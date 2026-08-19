"""
知识库索引构建脚本（独立运行，不依赖 FastAPI）。

由 knowledge_service.trigger_build_knowledge() 通过子进程调用。
也可以手动运行：
  python build_knowledge.py --mode=full
  python build_knowledge.py --mode=incremental --doc-keys=doc1,doc2

流程：
1. 获取文件锁（防止并发）
2. 根据模式加载文档：
   - full: 清空 pgvector，加载所有文档
   - incremental: 只加载指定文档，删除旧 chunks
3. SentenceSplitter / MarkdownNodeParser 分块
4. BGE-M3 Embedding + 写入 pgvector
5. 更新数据库：index_status="indexed"
"""

import argparse
import asyncio
import fcntl
import logging
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

# === 环境变量必须在 import llama_index 之前设置 ===
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

# 把项目根目录加入 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

import app.models  # noqa: E402, F401 — 注册所有 SQLAlchemy mapper，解析跨模型 relationship
from app.core.config import settings  # noqa: E402
from app.core.database import AsyncSessionLocal  # noqa: E402
from app.models.knowledge_document import KnowledgeDocument  # noqa: E402

# HF_HOME 和 HUGGINGFACE_HUB_CACHE 在 Day 6 Step 1 的 config.py 中定义
_hf_home = (
    settings.HF_HOME
    if hasattr(settings, "HF_HOME") and settings.HF_HOME
    else str(Path(__file__).resolve().parent / "models" / "hf_cache")
)
os.environ.setdefault("HF_HOME", _hf_home)
os.environ.setdefault("HUGGINGFACE_HUB_CACHE", _hf_home)
os.environ.setdefault("LLAMA_INDEX_CACHE_DIR", _hf_home)

_docling_cache = (
    settings.DOCLING_CACHE_DIR
    if hasattr(settings, "DOCLING_CACHE_DIR") and settings.DOCLING_CACHE_DIR
    else str(Path(__file__).resolve().parent / "models" / "docling_cache")
)
os.environ.setdefault("DOCLING_CACHE_DIR", _docling_cache)

from llama_index.core import Settings as LlamaSettings  # noqa: E402
from llama_index.core import (  # noqa: E402
    SimpleDirectoryReader,  # noqa: E402
    StorageContext,
    VectorStoreIndex,
)
from llama_index.core.node_parser import MarkdownNodeParser, SentenceSplitter  # noqa: E402
from llama_index.embeddings.huggingface import HuggingFaceEmbedding  # noqa: E402
from llama_index.vector_stores.postgres import PGVectorStore  # noqa: E402
from sqlalchemy import select, text  # noqa: E402

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 文件锁路径
LOCK_FILE = Path(settings.BASE_DIR).parent / ".rebuild.lock"


def acquire_lock():
    """
    获取文件锁，如果已被占用则抛出异常
    fcntl.LOCK_EX: 排他锁，意思是我独占其他人不准进也不准看
    LOCK_NB: 非阻塞模式，若没有他，有锁时默认阻塞 会一直等待，有他则直接抛出异常不等待
    ｜ 的意思是两个选项都要，既要排他锁又要非阻塞模式
    """
    lock_fd = open(LOCK_FILE, "w")  # noqa: SIM115 — 必须保持 fd 打开直到 finally 释放锁，不能用 with
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lock_fd
    except BlockingIOError:
        lock_fd.close()  # 获取锁失败时关闭 fd，防止泄漏
        raise RuntimeError("另一个重建任务正在运行") from BlockingIOError


def release_lock(lock_fd):
    """释放文件锁 LOCK_UN: 解锁"""
    fcntl.flock(lock_fd, fcntl.LOCK_UN)
    lock_fd.close()


def load_documents(source_dir: str) -> list:
    """
    读取目录下的所有文档。

    SimpleDirectoryReader 支持：TXT、PDF、DOCX、CSV、HTML 等。
    PDF 解析底层用 PyMuPDF / pdfminer。
    复杂 PDF（扫描件、复杂表格）可以换成 DoclingReader。
    """
    dir_path = Path(source_dir)
    if not dir_path.exists():
        print(f"错误: 目录 {source_dir} 不存在")
        return []

    # 只读取允许的文件类型
    allowed = {s.strip() for s in settings.ALLOWED_DOC_SUFFIXES.split(",") if s.strip()}
    input_files = [
        str(f) for f in sorted(dir_path.iterdir()) if f.is_file() and f.suffix.lower() in allowed
    ]

    if not input_files:
        print(f"警告: {source_dir} 下没有可处理的文档")
        return []

    print(f"发现 {len(input_files)} 个文档，开始读取...")

    # 按文件类型分别处理
    pdf_files = [f for f in input_files if f.lower().endswith(".pdf")]
    other_files = [f for f in input_files if not f.lower().endswith(".pdf")]

    docs = []

    # PDF 文件尝试用 DoclingReader（更好的 PDF 解析）
    if pdf_files:
        try:
            from llama_index.readers.docling import DoclingReader

            reader = DoclingReader()
            for pdf_file in pdf_files:
                pdf_docs = reader.load_data(pdf_file)
                # DoclingReader 不写入 file_path/file_name，手动补上
                # 否则 doc_key 无法被赋值，增量重建删不掉旧 chunks
                for doc in pdf_docs:
                    doc.metadata.setdefault("file_path", pdf_file)
                    doc.metadata.setdefault("file_name", Path(pdf_file).name)
                docs.extend(pdf_docs)
                print(f"  DoclingReader: {Path(pdf_file).name} → {len(pdf_docs)} 片段")
        except ImportError:
            print("  DoclingReader 未安装，降级到 SimpleDirectoryReader")
            pdf_docs = SimpleDirectoryReader(input_files=pdf_files).load_data()
            docs.extend(pdf_docs)

    # 其他文件用 SimpleDirectoryReader
    if other_files:
        other_docs = SimpleDirectoryReader(input_files=other_files).load_data()
        docs.extend(other_docs)

    # 确保每个文档都有 file_name 元数据
    for doc in docs:
        file_path = doc.metadata.get("file_path")
        if file_path and not doc.metadata.get("file_name"):
            doc.metadata["file_name"] = Path(file_path).name

    print(f"文档读取完成，共 {len(docs)} 个文档片段")
    return docs


def load_single_document(doc_key: str, source_dir: str) -> list:
    """
    读取单个文档（增量模式）。

    根据 doc_key 查找对应的文件（尝试所有允许的后缀）。
    """
    dir_path = Path(source_dir)
    if not dir_path.exists():
        print(f"错误: 目录 {source_dir} 不存在")
        return []

    allowed = {s.strip() for s in settings.ALLOWED_DOC_SUFFIXES.split(",") if s.strip()}

    # 尝试所有后缀
    doc_path = None
    for suffix in allowed:
        candidate = dir_path / f"{doc_key}{suffix}"
        if candidate.exists() and candidate.is_file():
            doc_path = candidate
            break

    if not doc_path:
        print(f"错误: 文档 {doc_key} 不存在（已尝试后缀: {allowed}）")
        return []

    print(f"读取单个文档: {doc_path.name}")

    # 根据文件类型选择读取器
    if doc_path.suffix.lower() == ".pdf":
        try:
            from llama_index.readers.docling import DoclingReader

            reader = DoclingReader()
            docs = reader.load_data(str(doc_path))
            for doc in docs:
                doc.metadata.setdefault("file_path", str(doc_path))
                doc.metadata.setdefault("file_name", doc_path.name)
            print(f"  DoclingReader: {doc_path.name} → {len(docs)} 片段")
        except ImportError:
            print("  DoclingReader 未安装，降级到 SimpleDirectoryReader")
            docs = SimpleDirectoryReader(input_files=[str(doc_path)]).load_data()
    else:
        docs = SimpleDirectoryReader(input_files=[str(doc_path)]).load_data()

    # 确保有 file_name 元数据
    for doc in docs:
        if not doc.metadata.get("file_name"):
            doc.metadata["file_name"] = doc_path.name

    print(f"文档读取完成，共 {len(docs)} 个文档片段")
    return docs


async def build_index(
    source_dir: str,
    mode: str = "full",
    doc_keys: list[str] | None = None,
    chunk_splitter: str = "sentence",
    chunk_size: int = 512,
    chunk_overlap: int = 50,
    chunk_min_len: int = 50,
    chunk_config_id: int | None = None,
    metadata_policy: str = "basic",
) -> None:
    """
    构建知识库索引的主流程。

    参数：
    - source_dir: 知识库目录
    - mode: "full"（全量重建）或 "incremental"（增量重建）
    - doc_keys: 增量模式时指定的文档 key 列表
    - chunk_splitter: "sentence" 或 "markdown"
    - chunk_size: 分块大小（token 数）
    - chunk_overlap: 分块重叠（token 数）
    - chunk_min_len: 过滤短文本的最小字符数
    - chunk_config_id: 分块配置 ID（写入 chunk metadata，供增量删除定位）
    - metadata_policy: "basic"（只保留必要字段）或 "full"（保留所有元数据）
    """
    # 获取文件锁：acquire 失败则直接返回，不进入后续 try/finally
    try:
        lock_fd = acquire_lock()
    except RuntimeError as e:
        logger.error(str(e))
        return

    try:
        start = time.perf_counter()

        # --- [1] 初始化 Embedding 模型 ---
        print("加载 Embedding 模型 (BAAI/bge-m3)...")
        LlamaSettings.embed_model = HuggingFaceEmbedding(
            model_name="BAAI/bge-m3",
            model_kwargs={"dtype": "float16"},
        )
        LlamaSettings.llm = None  # 构建阶段不需要 LLM

        # --- [2] 连接 PGVectorStore ---
        print("连接 PostgreSQL 向量数据库...")
        # 知识库重建的连接说明：
        # 1. 这个脚本由 worker 拉起为“独立子进程”运行，不与 API 进程、worker 主进程共享 engine/pool。
        # 2. 因此，这里创建的 PGVectorStore 会再额外增加 2 套独立 pool（sync + async）。
        # 3. 同一个子进程稍后还会 import AsyncSessionLocal 访问 ORM，
        #    所以重建期间总共会额外增加 3 套 PostgreSQL pool：
        #    - build_knowledge ORM 1 套
        #    - build_knowledge PGVector sync 1 套
        #    - build_knowledge PGVector async 1 套
        # 4. 文件锁保证同一时刻通常只有一个重建进程，但它仍然会和 API / worker 的连接预算叠加。
        # 5. 如需控制 PostgreSQL 峰值连接数，这里也需要显式传 create_engine_kwargs。
        vector_store = PGVectorStore.from_params(
            database=settings.DB_NAME,
            host=settings.DB_HOST,
            password=settings.DB_PASSWORD,
            port=str(settings.DB_PORT),
            user=settings.DB_USER,
            table_name=settings.DB_TABLE,
            embed_dim=1024,
            hybrid_search=True,
            text_search_config="simple",
        )
        storage_context = StorageContext.from_defaults(vector_store=vector_store)

        # --- [3] 根据模式加载文档 ---
        if mode == "full":
            logger.info("全量模式：加载所有文档")
            documents = load_documents(source_dir)
        else:
            logger.info("增量模式：加载 %d 个文档", len(doc_keys or []))
            documents = []
            for doc_key in doc_keys or []:
                docs = load_single_document(doc_key, source_dir)
                documents.extend(docs)

        if not documents:
            logger.warning("没有文档可构建，退出")
            return

        from app.services.ingest_text import (
            apply_normalize_to_node,
            near_duplicate_warnings,
            normalize_ingest_text,
        )

        for doc in documents:
            raw = getattr(doc, "text", "") or ""
            normalized = normalize_ingest_text(raw)
            if normalized != raw:
                if hasattr(doc, "set_content"):
                    doc.set_content(normalized)
                else:
                    doc.text = normalized

        # --- [4] 根据配置选择分块器 ---
        print(f"分块策略: {chunk_splitter}, chunk_size={chunk_size}, overlap={chunk_overlap}")
        if chunk_splitter == "markdown":
            splitter = MarkdownNodeParser()
            print("使用 MarkdownNodeParser（按 Markdown 标题层级切分）")
        else:
            splitter = SentenceSplitter(
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
            )
            print("使用 SentenceSplitter（按句子边界切分）")

        nodes = splitter.get_nodes_from_documents(documents)
        print(f"分块完成，原始节点数: {len(nodes)}")
        for node in nodes:
            apply_normalize_to_node(node)

        # --- [5] 过滤短文本 + 附加元数据 ---
        filtered_nodes = []
        for idx, node in enumerate(nodes, start=1):
            node_text = (getattr(node, "text", "") or "").strip()
            if len(node_text) < chunk_min_len:
                continue
            metadata = dict(getattr(node, "metadata", {}) or {})
            metadata.setdefault("chunk_id", idx)
            metadata["chunk_splitter"] = chunk_splitter
            # 增量重建关键：为每个 chunk 打上 doc_key 标签，用于精准删除旧 chunks
            file_path = metadata.get("file_path")
            if file_path:
                metadata["doc_key"] = Path(file_path).stem
            if chunk_config_id:
                metadata["chunk_config_id"] = chunk_config_id

            # 根据 metadata_policy 控制元数据量
            if metadata_policy == "basic":
                # 只保留必要字段（注意保留 doc_key，增量删除需要它）
                keep_keys = {
                    "file_name",
                    "chunk_id",
                    "chunk_splitter",
                    "chunk_config_id",
                    "doc_key",
                }
                metadata = {k: v for k, v in metadata.items() if k in keep_keys}

            node.metadata = metadata
            filtered_nodes.append(node)

        logger.info("过滤后节点数: %d (min_len=%d)", len(filtered_nodes), chunk_min_len)
        near_duplicate_warnings(filtered_nodes)

        if not filtered_nodes:
            logger.warning("过滤后没有可入库节点，退出")
            return

        # --- [6] 根据模式处理旧向量 ---
        if mode == "full":
            # 全量重建：清空所有旧向量
            logger.info("全量模式：清空旧向量数据...")
            vector_store.clear()
        else:
            # 增量重建：用 AsyncSessionLocal 删除指定文档的旧 chunks
            logger.info("增量模式：删除指定文档的旧 chunks...")
            """
            metadata->> 'doc _key' （PostgreSQL 的神级语法）：
            在数据库里， metadata 这一列存的是一坨 JSON 数据
            比如｛'chunk_id"： 1， "doc_key": "blade_manual", ...}
            ->>是 PostgreSQL 专门针对 JSONB 数据类型提供的提取操作符。
            它的意思是：“去 metadata 这个 JSON 对象里，
            把键为 doc_key 的值提取出来，并且当做纯文本 （Text）返回"
            - 参数绑定的双重标准（防SQL 注入）：表名用了f-string
            （（settings.DB_TABLE））：因为表名是系统配置写死的，
            绝对安全， 且SQL 原生不支持把表名作为参数传入，只能用f-string 拼接。
            值用了命名参数（：doc_key ）：注意！这里绝对没有用f-string 去拼用户的 doc_key
            而是写了一个占位符 ：doc_key，然后在后面的字典 ｛"doc_ _key": doc_key}
            里把值传进去。这叫参数化查询 （Parameterized Query），
            是防御黑客 SQL 注入攻击（SQL Injection) 的绝对铁律！
            哪怕用户传过来的 doc_key 是恶意代码'；DROP TABLE users;
            数据库也只会把它当成一个普通的字符串去匹配，绝不会执行它。
            """
            # PGVectorStore 自动加 data_ 前缀，列名用 metadata_（带下划线）
            actual_table = f"data_{settings.DB_TABLE}"
            async with AsyncSessionLocal() as db:
                # 表不存在时（首次增量重建，全量构建尚未运行）直接跳过删除
                exists_result = await db.execute(
                    text(
                        "SELECT 1 FROM information_schema.tables WHERE table_name = :tbl LIMIT 1"
                    ),
                    {"tbl": actual_table},
                )
                if exists_result.scalar():
                    for doc_key in doc_keys or []:
                        del_result = await db.execute(
                            text(
                                f"DELETE FROM {actual_table} "
                                "WHERE metadata_->>'doc_key' = :doc_key"
                            ),
                            {"doc_key": doc_key},
                        )
                        # CursorResult 有 rowcount，但 AsyncSession.execute() 的静态类型是
                        # Result[Any]，用 getattr 安全取值避免 Pylance 误报
                        rowcount = getattr(del_result, "rowcount", "?")
                        logger.info(
                            "  删除 %s 旧 chunks: %s 条（同 doc_key 版本替换）",
                            doc_key,
                            rowcount,
                        )
                    await db.commit()
                else:
                    logger.info("向量表尚不存在，跳过旧 chunks 删除")

        # --- [7] 构建索引（Embedding + 写入 pgvector）---
        logger.info("开始 Embedding + 写入 pgvector（这一步最慢）...")
        try:
            VectorStoreIndex(
                nodes=filtered_nodes,
                storage_context=storage_context,
                show_progress=True,
            )
        except Exception as e:
            logger.exception("索引构建失败: %s", e)
            await _update_index_status(doc_keys, "failed", str(e)[:500])
            return

        duration = time.perf_counter() - start
        logger.info("构建完成！%d 个节点已入库，耗时 %.1fs", len(filtered_nodes), duration)

        # --- [8] 更新数据库状态 ---
        await _update_index_status(
            doc_keys if mode == "incremental" else None,
            "indexed",
            chunk_config_id=chunk_config_id,
        )

    finally:
        release_lock(lock_fd)


async def _update_index_status(
    doc_keys: list[str] | None,
    status: str,
    error_message: str | None = None,
    chunk_config_id: int | None = None,
) -> None:
    """更新文档的索引状态（使用 AsyncSessionLocal）。"""
    now = datetime.now(UTC).replace(tzinfo=None)

    async with AsyncSessionLocal() as db:
        if doc_keys:
            # 增量模式：只更新指定文档
            for doc_key in doc_keys:
                result = await db.execute(
                    select(KnowledgeDocument).where(KnowledgeDocument.doc_key == doc_key)
                )
                doc = result.scalar_one_or_none()
                if doc:
                    doc.index_status = status
                    if status == "indexed":
                        doc.indexed_at = now
                        doc.error_message = None
                        await _update_version_chunk_config(db, doc.id, chunk_config_id)
                    elif status == "failed":
                        doc.error_message = error_message
        else:
            # 全量模式：更新所有 active 文档
            result = await db.execute(
                select(KnowledgeDocument).where(KnowledgeDocument.status == "active")
            )
            docs = result.scalars().all()
            for doc in docs:
                doc.index_status = status
                if status == "indexed":
                    doc.indexed_at = now
                    doc.error_message = None
                    await _update_version_chunk_config(db, doc.id, chunk_config_id)
                elif status == "failed":
                    doc.error_message = error_message

        await db.commit()


async def _update_version_chunk_config(
    db: AsyncSession,
    document_id: int,
    chunk_config_id: int | None,
) -> None:
    """将当前版本的 indexed_chunk_config_id 回写为本次重建使用的配置。"""
    from app.models.knowledge_document import KnowledgeDocumentVersion

    result = await db.execute(
        select(KnowledgeDocumentVersion).where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.is_current == True,  # noqa: E712
        )
    )
    version = result.scalar_one_or_none()
    if version:
        version.indexed_chunk_config_id = chunk_config_id


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="知识库索引构建脚本")
    parser.add_argument(
        "--mode",
        choices=["full", "incremental"],
        default="full",
        help="重建模式：full（全量）或 incremental（增量）",
    )
    parser.add_argument(
        "--doc-keys",
        type=str,
        default=None,
        help="增量模式时指定的文档 key 列表（逗号分隔）",
    )
    parser.add_argument(
        "--chunk-splitter",
        type=str,
        default="sentence",
        choices=["sentence", "markdown"],
        help="分块策略（默认 sentence）",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=512,
        help="分块大小，token 数（默认 512）",
    )
    parser.add_argument(
        "--chunk-overlap",
        type=int,
        default=50,
        help="分块重叠，token 数（默认 50）",
    )
    parser.add_argument(
        "--min-len",
        type=int,
        default=50,
        help="过滤短文本的最小字符数（默认 50）",
    )
    parser.add_argument(
        "--chunk-config-id",
        type=int,
        default=None,
        help="分块配置 ID，写入 chunk metadata（可选）",
    )
    parser.add_argument(
        "--metadata-policy",
        type=str,
        default="basic",
        choices=["basic", "full"],
        help="metadata 策略：basic 只保留必要字段，full 保留全部（默认 basic）",
    )
    args = parser.parse_args()

    doc_keys = args.doc_keys.split(",") if args.doc_keys else None

    if args.mode == "incremental" and not doc_keys:
        logger.error("增量模式需要指定 --doc-keys")
        sys.exit(1)

    asyncio.run(
        build_index(
            source_dir=settings.KNOWLEDGE_DIR,
            mode=args.mode,
            doc_keys=doc_keys,
            chunk_splitter=args.chunk_splitter,
            chunk_size=args.chunk_size,
            chunk_overlap=args.chunk_overlap,
            chunk_min_len=args.min_len,
            chunk_config_id=args.chunk_config_id,
            metadata_policy=args.metadata_policy,
        )
    )
