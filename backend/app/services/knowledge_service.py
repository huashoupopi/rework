"""
知识库文件管理服务。

职责：文件系统操作（保存、删除、目录管理）+ 子进程触发构建。
元信息管理（去重、版本号）由 CRUD 层负责，本模块不依赖数据库 Session。
"""

import asyncio
import hashlib
import logging
import os
import re
import sys
import time
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)

# 允许的文件后缀集合
ALLOWED_SUFFIXES: set[str] = {
    s.strip().lower() for s in settings.ALLOWED_DOC_SUFFIXES.split(",") if s.strip()
}

# 目录路径
KNOWLEDGE_DIR = Path(settings.KNOWLEDGE_DIR)
VERSIONS_DIR = Path(settings.MANAGED_VERSIONS_DIR)
BACKEND_DIR = Path(__file__).resolve().parents[2]


def ensure_knowledge_dirs() -> None:
    """创建知识库目录结构。启动时和上传前调用。"""
    KNOWLEDGE_DIR.mkdir(parents=True, exist_ok=True)
    VERSIONS_DIR.mkdir(parents=True, exist_ok=True)


def normalize_doc_key(filename: str) -> str:
    """
    文档键规范化：去掉扩展名，只保留 a-z, 0-9, -, _。

    为什么要规范化？
    - 用户上传 "风电叶片检修手册 (第三版).pdf" → 中文+空格+括号
    - 直接做目录名 → 文件系统兼容性问题 + 目录遍历攻击风险
    - 规范化后安全且可预测

    示例：
      "blade_manual_v3.pdf" → "blade_manual_v3"
      "风电叶片手册.pdf"    → "doc-1678900000"（中文全替换后太短，用时间戳兜底）
    """
    stem = Path(filename).stem
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "-", stem.strip().lower())
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-")
    return normalized[:100] or f"doc-{int(time.time())}"


def sanitize_filename(filename: str) -> str:
    """清理文件名，保留扩展名。"""
    name = Path(filename).stem
    suffix = Path(filename).suffix.lower()
    clean = re.sub(r"[^a-zA-Z0-9_.-]+", "_", name.strip())
    return f"{clean[:200]}{suffix}" if clean else f"file_{int(time.time())}{suffix}"


def compute_content_hash(content: bytes) -> str:
    """
    SHA256 内容哈希，用于去重。

    为什么用 SHA256 而不是 MD5？
    - MD5 已知存在碰撞攻击（两个不同文件产生相同哈希）
    - SHA256 抗碰撞性远强于 MD5，是当前工业标准
    - 性能差异在文件级别可忽略（MB 级别毫秒差异）
    """
    return hashlib.sha256(content).hexdigest()


def is_allowed_suffix(filename: str) -> bool:
    """检查文件后缀是否在白名单中。"""
    return Path(filename).suffix.lower() in ALLOWED_SUFFIXES


def relative_to_backend(path: Path) -> str:
    """将绝对路径转为相对于 backend 目录的路径。"""
    try:
        return str(path.relative_to(BACKEND_DIR))
    except ValueError:
        return str(path)


async def read_upload_file(file) -> bytes:
    """异步读取上传文件内容。"""
    return await file.read()


def save_version_file(
    doc_key: str,
    version: int,
    content: bytes,
    file_name: str,
) -> Path:
    """
    保存文件到版本归档目录。

    目录结构：
      managed_versions/
      └── blade_manual/
          ├── v1/
          │   └── blade_manual.pdf
          └── v2/
              └── blade_manual.pdf
    """
    version_dir = VERSIONS_DIR / doc_key / f"v{version}"
    version_dir.mkdir(parents=True, exist_ok=True)
    file_path = version_dir / file_name
    file_path.write_bytes(content)
    logger.info(
        "版本归档完成 doc_key=%s version=%d path=%s",
        doc_key,
        version,
        file_path,
    )
    return file_path


def write_active_document(doc_key: str, content: bytes, suffix: str) -> Path:
    """
    写入 active 目录（knowledge_base/）。
    build_knowledge.py 读取这个目录来构建索引。

    写入前先清理同 doc_key 的旧文件，防止一个文档有多个后缀的残留。
    """
    ensure_knowledge_dirs()
    normalized_suffix = suffix.lower()
    if normalized_suffix not in ALLOWED_SUFFIXES:
        normalized_suffix = ".pdf"

    # 清理旧文件（不同后缀的残留）
    for s in ALLOWED_SUFFIXES:
        old_path = KNOWLEDGE_DIR / f"{doc_key}{s}"
        if old_path.exists() and old_path.is_file():
            old_path.unlink()
            logger.info("清理旧 active 文件 path=%s", old_path)

    active_path = KNOWLEDGE_DIR / f"{doc_key}{normalized_suffix}"
    active_path.write_bytes(content)
    logger.info("写入 active 文档 path=%s size=%d", active_path, len(content))
    return active_path


def remove_active_file(doc_key: str) -> bool:
    """
    从 active 目录删除文件。
    数据库的软删除由 CRUD 层负责，这里只管文件系统。
    """
    removed = False
    for suffix in ALLOWED_SUFFIXES:
        path = KNOWLEDGE_DIR / f"{doc_key}{suffix}"
        if path.exists() and path.is_file():
            path.unlink()
            removed = True
            logger.info("删除 active 文件 path=%s", path)
    return removed


async def trigger_build_knowledge(
    mode: str = "full",
    doc_keys: list[str] | None = None,
    chunk_config: dict | None = None,
    chunk_config_id: int | None = None,
    source_dir: str | None = None,
    timeout_seconds: int | None = None,
) -> tuple[int, float, str, str]:
    """
    异步触发知识库索引重建脚本。

    参数：
    - mode: "full"（全量重建）或 "incremental"（增量重建）
    - doc_keys: 增量模式时指定的文档 key 列表
    - chunk_config: 分块配置
    - chunk_config_id: 分块配置 ID，写入版本记录（供删除保护用）
    - source_dir: 知识库目录
    - timeout_seconds: 超时时间

    为什么用 create_subprocess_exec 而不是 BackgroundTasks？
    - BackgroundTasks 在 API 进程内执行，共享内存空间
    - 知识库构建加载 Embedding 模型 + 处理文档，可能占用数 GB 内存
    - 如果 BackgroundTask OOM → 整个 API 进程崩溃 → 所有用户断线
    - 子进程有独立内存空间，OOM 只影响子进程，API 进程安然无恙
    """
    final_timeout = timeout_seconds or settings.KNOWLEDGE_BUILD_TIMEOUT_S
    final_source_dir = source_dir or str(KNOWLEDGE_DIR)

    # 构建环境变量
    env = dict(os.environ)
    env["KNOWLEDGE_DIR"] = final_source_dir

    # 传入分块配置
    if chunk_config:
        for key, value in chunk_config.items():
            env[f"CHUNK_{key.upper()}"] = str(value)

    cmd = [sys.executable, "build_knowledge.py", f"--mode={mode}"]
    if mode == "incremental" and doc_keys:
        cmd.append(f"--doc-keys={','.join(doc_keys)}")
    if chunk_config_id:
        cmd.append(f"--chunk-config-id={chunk_config_id}")

    logger.info(
        "启动知识库重建 cmd=%s cwd=%s timeout=%ds",
        cmd,
        BACKEND_DIR,
        final_timeout,
    )

    start = time.perf_counter()
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        logger.info("build_knowledge.py 已启动 PID=%s", process.pid)

        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=final_timeout,
        )
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")
        duration_ms = (time.perf_counter() - start) * 1000

        if process.returncode == 0:
            logger.info(
                "知识库重建成功 duration_ms=%.1f PID=%s",
                duration_ms,
                process.pid,
            )
        else:
            logger.error(
                "知识库重建失败 exit_code=%s duration_ms=%.1f",
                process.returncode,
                duration_ms,
            )

        if stdout.strip():
            logger.info("[build_knowledge stdout]\n%s", stdout[-2000:])
        if stderr.strip():
            logger.warning("[build_knowledge stderr]\n%s", stderr[-2000:])

        return (process.returncode or 0, duration_ms, stdout[-4000:], stderr[-4000:])

    except TimeoutError:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.error(
            "知识库重建超时 timeout=%ds duration_ms=%.1f",
            final_timeout,
            duration_ms,
        )
        # 超时后必须终止子进程，防止进程泄漏
        process.kill()
        await process.wait()
        raise
    except Exception:
        duration_ms = (time.perf_counter() - start) * 1000
        logger.exception("知识库重建异常 duration_ms=%.1f", duration_ms)
        raise


async def set_rebuild_running(running: bool) -> None:
    """设置重建任务运行状态到 Redis。"""
    from app.core.redis import get_redis
    from app.core.config import settings
    from app.tasks.knowledge_task import REBUILD_RUNNING_KEY

    r = get_redis()
    if running:
        await r.set(REBUILD_RUNNING_KEY, "1", ex=settings.KNOWLEDGE_BUILD_TIMEOUT_S + 60)
    else:
        await r.delete(REBUILD_RUNNING_KEY)
    await r.aclose()


async def is_rebuild_running() -> bool:
    """
    检查是否有重建任务正在运行（通过 Redis key）。

    原理：
    - 后端入队时立即设置 "knowledge:rebuild_running"
    - worker 任务结束（成功/失败）时删除该 key
    - key 带 TTL 兜底，防止进程异常退出后永远卡住
    """
    from app.core.redis import get_redis
    from app.tasks.knowledge_task import REBUILD_RUNNING_KEY

    r = get_redis()
    result = await r.exists(REBUILD_RUNNING_KEY)
    await r.aclose()
    return bool(result)


async def delete_document_chunks(doc_key: str) -> int:
    """
    从 pgvector 删除指定文档的所有 chunks。

    使用原始 SQL 而不是 PGVectorStore API，因为 PGVectorStore
    不提供按 metadata 过滤删除的方法。

    返回删除的 chunk 数量。
    """
    from sqlalchemy import text as sa_text

    from app.core.database import engine

    # PGVectorStore 自动加 data_ 前缀，列名用 metadata_（带下划线）
    actual_table = f"data_{settings.DB_TABLE}"

    async with engine.begin() as conn:
        # 表不存在时（尚未执行过全量重建）直接返回 0，避免 500
        exists = await conn.execute(
            sa_text("SELECT 1 FROM information_schema.tables WHERE table_name = :tbl LIMIT 1"),
            {"tbl": actual_table},
        )
        if not exists.scalar():
            return 0

        result = await conn.execute(
            sa_text(f"DELETE FROM {actual_table} WHERE metadata_->>'doc_key' = :doc_key"),
            {"doc_key": doc_key},
        )
        return result.rowcount
