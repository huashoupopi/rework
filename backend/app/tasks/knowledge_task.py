"""
知识库重建异步任务(Arq Worker执行)

通过 Redis key "knowledge:rebuild_running" 标记任务状态，
backend 和 worker 跨容器共享状态。
"""

import asyncio
import logging
import os
import sys
import time
from pathlib import Path

from app.core.config import settings

logger = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).parent.parent.parent
REBUILD_RUNNING_KEY = "knowledge:rebuild_running"


async def _set_rebuild_status(ctx: dict, running: bool) -> None:
    """通过 arq worker 的 redis 连接设置重建状态。"""
    redis = ctx.get("redis")
    if not redis:
        return
    if running:
        # 设置标记，TTL 兜底防止进程异常退出后永远卡住
        await redis.set(REBUILD_RUNNING_KEY, "1", ex=settings.KNOWLEDGE_BUILD_TIMEOUT_S + 60)
    else:
        await redis.delete(REBUILD_RUNNING_KEY)


async def run_knowledge_rebuild(
    ctx: dict,
    mode: str = "full",  # "full" 或 "incremental"
    doc_keys: list[str] | None = None,  # 增量模式下指定要重建的文档key列表
    chunk_config: dict | None = None,  # 可选的分块配置，覆盖默认配置
    chunk_config_id: int | None = None,
) -> dict:
    timeout = settings.KNOWLEDGE_BUILD_TIMEOUT_S
    source_dir = str(settings.KNOWLEDGE_DIR)

    await _set_rebuild_status(ctx, True)

    try:
        env = dict(os.environ)
        env["KNOWLEDGE_DIR"] = source_dir
        if chunk_config:
            for key, value in chunk_config.items():
                env[f"CHUNK_{key.upper()}"] = str(value)
        cmd = [sys.executable, "build_knowledge.py", f"--mode={mode}"]
        if mode == "incremental" and doc_keys:
            cmd.append(f"--doc-keys={','.join(doc_keys)}")
        if chunk_config_id:
            cmd.append(f"--chunk-config-id={chunk_config_id}")

        logger.info("知识库重建开始 mode=%s cmd=%s", mode, cmd)
        start = time.perf_counter()

        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(BACKEND_DIR),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        except TimeoutError:
            process.kill()
            raise RuntimeError(f"知识库重建超时，超过 {timeout} 秒") from TimeoutError
        elapsed = round(time.perf_counter() - start, 1)

        if process.returncode != 0:
            err_msg = stderr.decode().strip()[-500:]
            logger.error(
                "知识库重建失败 code=%d elapsed=%.1fs error=%s", process.returncode, elapsed, err_msg
            )
            raise RuntimeError(f"知识库重建失败: {err_msg}")
        logger.info("知识库重建成功 elapsed=%.1fs mode=%s", elapsed, mode)
        return {"mode": mode, "elapsed": elapsed, "returncode": 0}
    finally:
        await _set_rebuild_status(ctx, False)
