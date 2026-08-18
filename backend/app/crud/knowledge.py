"""
知识库 CRUD 操作。

分为三组：
1. 文档操作：创建/查询/软删除/恢复
2. 版本操作：创建/标记旧版本/按 hash 查重
3. 分块配置操作：增删改查/切换默认
"""

from datetime import UTC, datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge_chunk_config import KnowledgeChunkConfig
from app.models.knowledge_document import (
    KnowledgeDocument,
    KnowledgeDocumentVersion,
)
from app.models.knowledge_enums import KnowledgeDocStatus

# ==================== 文档操作 ====================


async def get_document_by_id(db: AsyncSession, document_id: int) -> KnowledgeDocument | None:
    """按 ID 获取文档。"""
    return await db.get(KnowledgeDocument, document_id)


async def get_document_by_key(db: AsyncSession, doc_key: str) -> KnowledgeDocument | None:
    """按 doc_key 获取文档（不区分状态）。"""
    stmt = select(KnowledgeDocument).where(KnowledgeDocument.doc_key == doc_key)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_documents(
    db: AsyncSession,
    status: str | None = None,
    keyword: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[list[KnowledgeDocument], int]:
    """
    文档列表 + 分页。

    支持按 status 过滤、按 title/doc_key 模糊搜索。
    返回 (documents, total_count)。
    """
    base = select(KnowledgeDocument)
    count_base = select(func.count(KnowledgeDocument.id))

    if status:
        base = base.where(KnowledgeDocument.status == status)
        count_base = count_base.where(KnowledgeDocument.status == status)

    if keyword:
        like = f"%{keyword}%"
        base = base.where(
            KnowledgeDocument.title.ilike(like) | KnowledgeDocument.doc_key.ilike(like)
        )
        count_base = count_base.where(
            KnowledgeDocument.title.ilike(like) | KnowledgeDocument.doc_key.ilike(like)
        )

    total = (await db.execute(count_base)).scalar_one()
    stmt = base.order_by(KnowledgeDocument.updated_at.desc()).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all()), total


async def create_document(
    db: AsyncSession,
    doc_key: str,
    title: str,
    created_by: int | None = None,
) -> KnowledgeDocument:
    """
    创建新文档记录。

    只创建主表记录，版本记录由 create_version 创建。
    """
    doc = KnowledgeDocument(
        doc_key=doc_key,
        title=title,
        status=KnowledgeDocStatus.ACTIVE,
        latest_version=0,  # create_version 时更新
        created_by=created_by,
    )
    db.add(doc)
    await db.flush()
    return doc


async def mark_document_deleted(db: AsyncSession, document_id: int) -> KnowledgeDocument | None:
    """软删除文档。"""
    doc = await db.get(KnowledgeDocument, document_id)
    if doc and doc.status == KnowledgeDocStatus.ACTIVE:
        doc.status = KnowledgeDocStatus.DELETED
        doc.deleted_at = datetime.now(UTC)
        await db.flush()
        return doc
    return None


async def mark_document_active(db: AsyncSession, document_id: int) -> KnowledgeDocument | None:
    """恢复已删除的文档。"""
    doc = await db.get(KnowledgeDocument, document_id)
    if doc and doc.status == KnowledgeDocStatus.DELETED:
        doc.status = KnowledgeDocStatus.ACTIVE
        doc.deleted_at = None
        await db.flush()
        return doc
    return None


# ==================== 版本操作 ====================


async def get_current_version(
    db: AsyncSession, document_id: int
) -> KnowledgeDocumentVersion | None:
    """获取文档的当前版本（is_current=True）。"""
    stmt = (
        select(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.is_current == True,  # noqa: E712
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def mark_old_versions_not_current(db: AsyncSession, document_id: int) -> int:
    """
    将同一文档下所有 is_current=True 的版本标记为 False。

    新版本上传前调用——确保同一时刻只有一个 is_current=True 的版本。
    返回被标记的记录数。
    """
    stmt = (
        update(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.is_current == True,  # noqa: E712
        )
        .values(is_current=False)
    )
    result = await db.execute(stmt)
    rowcount = getattr(result, "rowcount", 0)
    return rowcount


async def create_version(
    db: AsyncSession,
    document_id: int,
    version: int,
    file_name: str,
    storage_path: str,
    active_path: str,
    content_hash: str,
    file_size: int,
    mime_type: str | None = None,
    created_by: int | None = None,
    chunk_config_id: int | None = None,
) -> KnowledgeDocumentVersion:
    """
    创建新版本记录。

    调用前应先调用 mark_old_versions_not_current 标记旧版本。
    同时更新主表的 latest_version。
    """
    ver = KnowledgeDocumentVersion(
        document_id=document_id,
        version=version,
        file_name=file_name,
        storage_path=storage_path,
        active_path=active_path,
        content_hash=content_hash,
        file_size=file_size,
        mime_type=mime_type,
        is_current=True,
        created_by=created_by,
        indexed_chunk_config_id=chunk_config_id,
    )
    db.add(ver)
    await db.flush()

    # 更新主表的 latest_version
    doc = await db.get(KnowledgeDocument, document_id)
    if doc:
        doc.latest_version = version

    return ver


async def check_duplicate_hash(
    db: AsyncSession,
    document_id: int,
    content_hash: str,
) -> KnowledgeDocumentVersion | None:
    """
    按 content_hash 查重（同一文档内）。

    (document_id, content_hash) 有唯一约束，这里做业务层检查。
    """
    stmt = (
        select(KnowledgeDocumentVersion)
        .where(
            KnowledgeDocumentVersion.document_id == document_id,
            KnowledgeDocumentVersion.content_hash == content_hash,
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


# ==================== 分块配置操作 ====================


async def get_chunk_config_by_id(db: AsyncSession, config_id: int) -> KnowledgeChunkConfig | None:
    return await db.get(KnowledgeChunkConfig, config_id)


async def get_chunk_config_by_name(db: AsyncSession, name: str) -> KnowledgeChunkConfig | None:
    stmt = select(KnowledgeChunkConfig).where(KnowledgeChunkConfig.name == name)
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_default_chunk_config(
    db: AsyncSession,
) -> KnowledgeChunkConfig | None:
    """获取默认分块配置（is_default=True 且 is_active=True）。"""
    stmt = (
        select(KnowledgeChunkConfig)
        .where(
            KnowledgeChunkConfig.is_default == True,  # noqa: E712
            KnowledgeChunkConfig.is_active == True,  # noqa: E712
        )
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_chunk_configs(
    db: AsyncSession,
    active_only: bool = True,
) -> list[KnowledgeChunkConfig]:
    """列出分块配置。"""
    stmt = select(KnowledgeChunkConfig)
    if active_only:
        stmt = stmt.where(KnowledgeChunkConfig.is_active == True)  # noqa: E712
    stmt = stmt.order_by(KnowledgeChunkConfig.id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_chunk_config(
    db: AsyncSession,
    name: str,
    splitter: str = "sentence",
    chunk_size: int = 800,
    chunk_overlap: int = 150,
    min_chunk_len: int = 20,
    metadata_policy: str = "basic",
    is_default: bool = False,
    created_by: int | None = None,
    description: str | None = None,
) -> KnowledgeChunkConfig:
    """创建分块配置。如果 is_default=True，先取消旧的默认。"""
    if is_default:
        await _clear_default_config(db)

    config = KnowledgeChunkConfig(
        name=name,
        description=description,
        splitter=splitter,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        min_chunk_len=min_chunk_len,
        metadata_policy=metadata_policy,
        is_active=True,
        is_default=is_default,
        created_by=created_by,
    )
    db.add(config)
    await db.flush()
    return config


async def update_chunk_config(
    db: AsyncSession,
    config_id: int,
    **fields,
) -> KnowledgeChunkConfig | None:
    """更新分块配置（部分字段更新）。"""
    config = await db.get(KnowledgeChunkConfig, config_id)
    if not config:
        return None

    # 如果要设为默认，先清除旧默认
    if fields.get("is_default"):
        await _clear_default_config(db)

    for key, value in fields.items():
        if hasattr(config, key) and value is not None:
            setattr(config, key, value)

    await db.flush()
    return config


async def delete_chunk_config(db: AsyncSession, config_id: int) -> bool:
    """软删除分块配置（is_active=False）。"""
    config = await db.get(KnowledgeChunkConfig, config_id)
    if not config:
        return False
    config.is_active = False
    if config.is_default:
        config.is_default = False
    await db.flush()
    return True


async def count_versions_by_chunk_config(db: AsyncSession, config_id: int) -> int:
    """统计使用某个配置的版本数量。"""
    stmt = select(func.count(KnowledgeDocumentVersion.id)).where(
        KnowledgeDocumentVersion.indexed_chunk_config_id == config_id
    )
    result = await db.execute(stmt)
    return result.scalar_one()


async def _clear_default_config(db: AsyncSession) -> None:
    """清除所有默认标记。"""
    stmt = (
        update(KnowledgeChunkConfig)
        .where(KnowledgeChunkConfig.is_default == True)  # noqa: E712
        .values(is_default=False)
    )
    await db.execute(stmt)


# ==================== 索引状态操作 ====================


async def list_all_documents(db: AsyncSession) -> list[KnowledgeDocument]:
    """列出所有活跃文档（不分页），用于状态查询。"""
    result = await db.execute(
        select(KnowledgeDocument)
        .where(KnowledgeDocument.status == KnowledgeDocStatus.ACTIVE)
        .order_by(KnowledgeDocument.created_at.desc())
    )
    return list(result.scalars().all())


async def reset_all_index_status(db: AsyncSession) -> None:
    """将所有活跃文档的 index_status 重置为 pending（全量重建前调用）。"""
    await db.execute(
        update(KnowledgeDocument)
        .where(KnowledgeDocument.status == KnowledgeDocStatus.ACTIVE)
        .values(index_status="pending", indexed_at=None, error_message=None)
    )


async def get_pending_documents(db: AsyncSession) -> list[KnowledgeDocument]:
    """查询所有 index_status="pending" 的活跃文档（增量重建时使用）。"""
    result = await db.execute(
        select(KnowledgeDocument).where(
            KnowledgeDocument.status == KnowledgeDocStatus.ACTIVE,
            KnowledgeDocument.index_status == "pending",
        )
    )
    return list(result.scalars().all())
