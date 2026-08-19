import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.redis import get_arq_redis
from app.crud import knowledge as knowledge_crud
from app.models.knowledge import KnowledgeDocStatus
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.knowledge import (
    ChunkConfigCreateSchema,
    ChunkConfigDeleteResponse,
    ChunkConfigSchema,
    ChunkConfigUpdateSchema,
    KnowledgeDeleteResponse,
    KnowledgeDocumentListSchema,
    KnowledgeDocumentSchema,
    KnowledgeRebuildResponse,
    KnowledgeUploadResponse,
    KnowledgeVersionSchema,
)
from app.services import knowledge_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["知识库管理(Knowledge)"])


def _require_superuser(user: User) -> None:
    if not user.is_superuser:
        raise HTTPException(status_code=403, detail="需要管理员权限")


@router.post(
    "/knowledge/documents/upload",
    response_model=KnowledgeUploadResponse,
    summary="上传知识库文档",
)
async def upload_document(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeUploadResponse:
    """
    上传文档到知识库。

    流程：
    1. 校验文件格式
    2. SHA256 → 按文档内去重
    3. 创建/获取文档主记录 → 标记旧版本 → 创建新版本
    4. 保存文件（版本归档 + active 目录）
    5. 统一 commit
    """
    _require_superuser(current_user)
    knowledge_service.ensure_knowledge_dirs()

    # [1] 校验文件名和格式
    if not file.filename:
        raise HTTPException(status_code=400, detail="文件名不能为空")

    if not knowledge_service.is_allowed_suffix(file.filename):
        raise HTTPException(
            status_code=400,
            detail=f"仅支持 {sorted(knowledge_service.ALLOWED_SUFFIXES)} 格式",
        )

    # [2] 读取文件内容 + 哈希
    content = await knowledge_service.read_upload_file(file)
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")

    content_hash = knowledge_service.compute_content_hash(content)
    suffix = Path(file.filename).suffix.lower()
    doc_key = knowledge_service.normalize_doc_key(file.filename)
    safe_filename = knowledge_service.sanitize_filename(file.filename)

    # [3] 获取或创建文档主记录
    doc = await knowledge_crud.get_document_by_key(db, doc_key)
    created = False

    restored = False
    if doc is None:
        doc = await knowledge_crud.create_document(
            db,
            doc_key=doc_key,
            title=safe_filename,
            created_by=current_user.id,
        )
        created = True
    elif doc.status == KnowledgeDocStatus.DELETED:
        # 文档已被删除 → 恢复为 active，继续上传新版本
        await knowledge_crud.mark_document_active(db, doc.id)
        created = False
        restored = True

    # [4] 按文档内去重
    dup_version = await knowledge_crud.check_duplicate_hash(
        db,
        document_id=doc.id,
        content_hash=content_hash,
    )
    if dup_version:
        if restored:
            # 文档从 deleted 恢复：物理文件已被删除，需要重新写入 active 目录
            knowledge_service.write_active_document(doc_key, content, suffix)
            logger.info("已恢复被删除文档的 active 文件 doc_key=%s", doc_key)
        # 即使内容重复，也要提交之前的状态变更（如恢复已删除文档）
        await db.commit()
        await db.refresh(doc)
        return KnowledgeUploadResponse(
            created=False,
            message="文档已恢复" if restored else f"内容重复，与 v{dup_version.version} 相同",
            document=KnowledgeDocumentSchema.model_validate(doc),
            version=KnowledgeVersionSchema.model_validate(dup_version),
        )

    # [5] 标记旧版本 + 计算新版本号
    await knowledge_crud.mark_old_versions_not_current(db, doc.id)
    new_version_num = doc.latest_version + 1

    # [5.5] 获取默认分块配置 ID（预填充到版本记录，保证删除保护从上传起就生效）
    default_cfg = await knowledge_crud.get_default_chunk_config(db)
    default_config_id = default_cfg.id if default_cfg else None

    # [6] 文件系统操作
    try:
        storage_path = knowledge_service.save_version_file(
            doc_key,
            new_version_num,
            content,
            safe_filename,
        )
        active_path = knowledge_service.write_active_document(
            doc_key,
            content,
            suffix,
        )
    except Exception:
        logger.exception("文件保存失败，回滚数据库 doc_key=%s", doc_key)
        await db.rollback()
        raise HTTPException(status_code=500, detail="文件保存失败") from None

    # [7] 创建版本记录（预填充 indexed_chunk_config_id，重建后会更新为实际使用的配置）
    version = await knowledge_crud.create_version(
        db,
        document_id=doc.id,
        version=new_version_num,
        file_name=safe_filename,
        storage_path=knowledge_service.relative_to_backend(storage_path),
        active_path=knowledge_service.relative_to_backend(active_path),
        content_hash=content_hash,
        file_size=len(content),
        mime_type=file.content_type,
        created_by=current_user.id,
        chunk_config_id=default_config_id,
    )

    # [8] 统一 commit
    await db.commit()
    await db.refresh(doc)

    logger.info(
        "文档上传成功 doc_key=%s version=%d hash=%s user=%d",
        doc_key,
        new_version_num,
        content_hash[:16],
        current_user.id,
    )

    # 填充 current_version 到文档 Schema
    doc_schema = KnowledgeDocumentSchema.model_validate(doc)
    doc_schema.current_version = KnowledgeVersionSchema.model_validate(version)

    return KnowledgeUploadResponse(
        created=created,
        message="上传成功",
        document=doc_schema,
        version=KnowledgeVersionSchema.model_validate(version),
    )


# ==================== 文档列表 ====================


@router.get(
    "/knowledge/documents",
    response_model=KnowledgeDocumentListSchema,
    summary="列出知识库文档",
)
async def list_documents(
    status: str | None = None,
    keyword: str | None = None,
    offset: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeDocumentListSchema:
    """列出文档，支持按状态过滤和关键词搜索。"""
    _require_superuser(current_user)
    docs, total = await knowledge_crud.list_documents(
        db,
        status=status,
        keyword=keyword,
        offset=offset,
        limit=limit,
    )

    versions = await knowledge_crud.get_current_versions_map(db, [d.id for d in docs])
    items = []
    for d in docs:
        schema = KnowledgeDocumentSchema.model_validate(d)
        current_ver = versions.get(d.id)
        if current_ver:
            schema.current_version = KnowledgeVersionSchema.model_validate(current_ver)
        items.append(schema)

    return KnowledgeDocumentListSchema(total=total, documents=items)


# ==================== 文档删除 ====================


@router.delete(
    "/knowledge/documents/{doc_key}",
    response_model=KnowledgeDeleteResponse,
    summary="删除知识库文档索引",
)
async def delete_document(
    doc_key: str,
    physical_delete: bool = False,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeDeleteResponse:
    """
    删除文档索引。

    参数：
    - physical_delete: 是否物理删除文件（默认 false，只删除索引）

    流程：
    1. 从 pgvector 删除所有 chunks
    2. 更新数据库：index_status="pending", indexed_at=NULL
    3. 如果 physical_delete=true，则标记 status="deleted" 并删除物理文件
    """
    _require_superuser(current_user)

    doc = await knowledge_crud.get_document_by_key(db, doc_key)
    if not doc:
        raise HTTPException(status_code=404, detail=f"文档 {doc_key} 不存在")

    # 从 pgvector 删除 chunks
    chunks_deleted = await knowledge_service.delete_document_chunks(doc_key)

    # 更新数据库状态
    doc.index_status = "pending"
    doc.indexed_at = None

    if physical_delete:
        # 标记为已删除
        doc.status = "deleted"
        # 物理删除文件
        knowledge_service.remove_active_file(doc_key)

    await db.commit()

    logger.info(
        "文档索引已删除 doc_key=%s chunks=%d physical=%s user=%d",
        doc_key,
        chunks_deleted,
        physical_delete,
        current_user.id,
    )

    return KnowledgeDeleteResponse(
        success=True,
        doc_key=doc_key,
        message=f"已删除 {chunks_deleted} 个 chunks"
        + ("，物理文件已删除" if physical_delete else ""),
    )


# ==================== 知识库重建 ====================


@router.get(
    "/knowledge/status",
    summary="查询索引状态",
)
async def get_index_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    查询所有文档的索引状态。

    返回：
    - total_documents: 文档总数
    - indexed/pending/failed: 各状态文档数量
    - rebuild_running: 是否有重建任务正在运行
    - documents: 文档列表（包含索引状态、错误信息等）
    """
    _require_superuser(current_user)

    docs = await knowledge_crud.list_all_documents(db)

    stats = {
        "total_documents": len(docs),
        "indexed": sum(1 for d in docs if d.index_status == "indexed"),
        "pending": sum(1 for d in docs if d.index_status == "pending"),
        "failed": sum(1 for d in docs if d.index_status == "failed"),
        "rebuild_running": await knowledge_service.is_rebuild_running(),
        "documents": [
            {
                "doc_key": d.doc_key,
                "title": d.title,
                "index_status": d.index_status,
                "indexed_at": d.indexed_at.isoformat() if d.indexed_at else None,
                "latest_version": d.latest_version,
                "error_message": d.error_message if d.index_status == "failed" else None,
                "last_build_attempt_at": d.last_build_attempt_at.isoformat()
                if d.last_build_attempt_at
                else None,
            }
            for d in docs
        ],
    }

    return stats


@router.post(
    "/knowledge/rebuild/full", response_model=KnowledgeRebuildResponse, summary="触发全量重建"
)
async def trigger_full_rebuild(
    chunk_config_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeRebuildResponse:
    _require_superuser(current_user)

    if await knowledge_service.is_rebuild_running():
        return KnowledgeRebuildResponse(
            success=False,
            message="已有重建任务正在运行，请稍后再试",
        )

    await knowledge_crud.reset_all_index_status(db)
    await db.commit()

    config_dict = None
    used_config_id: int | None = None
    if chunk_config_id:
        config = await knowledge_crud.get_chunk_config_by_id(db, chunk_config_id)
        if not config:
            raise HTTPException(status_code=404, detail=f"分块配置 {chunk_config_id} 不存在")
        used_config_id = config.id
        config_dict = {
            "splitter": config.splitter,
            "size": config.chunk_size,
            "overlap": config.chunk_overlap,
            "min_len": config.min_chunk_len,
        }
    else:
        default_cfg = await knowledge_crud.get_default_chunk_config(db)
        if default_cfg:
            used_config_id = default_cfg.id
            config_dict = {
                "splitter": default_cfg.splitter,
                "size": default_cfg.chunk_size,
                "overlap": default_cfg.chunk_overlap,
                "min_len": default_cfg.min_chunk_len,
            }
    arq = get_arq_redis()
    mode = "full"
    job_id = f"rebuild_{mode}"
    # 清掉上次的任务结果，否则 arq 会因为 job_id 重复拒绝入队
    await arq.delete(f"arq:result:{job_id}")
    job = await arq.enqueue_job(
        "run_knowledge_rebuild",
        mode="full",
        chunk_config=config_dict,
        chunk_config_id=used_config_id,
        _job_id=job_id,
    )
    logger.info("任务已入队 job_id=%s", job.job_id if job else "duplicate")

    # 入队成功后立即标记运行状态，避免前端轮询竞态
    if job:
        await knowledge_service.set_rebuild_running(True)

    logger.info(
        "全量重建已触发 user=%d config=%s config_id=%s",
        current_user.id,
        config_dict,
        used_config_id,
    )

    return KnowledgeRebuildResponse(
        success=True,
        message="全量重建已触发",
    )


@router.post(
    "/knowledge/rebuild/incremental",
    response_model=KnowledgeRebuildResponse,
    summary="触发增量重建",
)
async def trigger_incremental_rebuild(
    chunk_config_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> KnowledgeRebuildResponse:
    """
    触发增量重建：只处理 index_status="pending" 的文档。

    使用场景：
    - 上传了新文档
    - 修改了某个文档的内容
    - 上次索引失败，需要重试
    """
    _require_superuser(current_user)

    # 检查是否有任务正在运行
    if await knowledge_service.is_rebuild_running():
        return KnowledgeRebuildResponse(
            success=False,
            message="另一个重建任务正在运行，请稍后再试",
        )

    # 查询待索引的文档
    pending_docs = await knowledge_crud.get_pending_documents(db)

    if not pending_docs:
        return KnowledgeRebuildResponse(
            success=True,
            message="没有待索引的文档",
        )

    doc_keys = [doc.doc_key for doc in pending_docs]

    # 获取分块配置
    config = None
    config_dict = None
    used_config_id: int | None = None
    if chunk_config_id:
        config = await knowledge_crud.get_chunk_config_by_id(db, chunk_config_id)
        if not config:
            raise HTTPException(status_code=404, detail=f"配置 {chunk_config_id} 不存在")
    else:
        config = await knowledge_crud.get_default_chunk_config(db)

    if config:
        used_config_id = config.id
        config_dict = {
            "splitter": config.splitter,
            "size": config.chunk_size,
            "overlap": config.chunk_overlap,
            "min_len": config.min_chunk_len,
        }

    # # 异步启动子进程（fire-and-forget，不等待完成）
    # asyncio.create_task(
    #     knowledge_service.trigger_build_knowledge(
    #         mode="incremental",
    #         doc_keys=doc_keys,
    #         chunk_config=config_dict,
    #         chunk_config_id=used_config_id,
    #     )
    # )
    arq = get_arq_redis()
    mode = "incremental"
    job_id = f"rebuild_{mode}"
    await arq.delete(f"arq:result:{job_id}")
    job = await arq.enqueue_job(
        "run_knowledge_rebuild",
        mode="incremental",
        doc_keys=doc_keys,
        chunk_config=config_dict,
        chunk_config_id=used_config_id,
        _job_id=job_id,
    )
    logger.info("任务已入队 job_id=%s", job.job_id if job else "duplicate")

    if job:
        await knowledge_service.set_rebuild_running(True)

    logger.info("增量重建已触发 user=%d docs=%d", current_user.id, len(doc_keys))

    return KnowledgeRebuildResponse(
        success=True,
        message=f"增量重建已启动，共 {len(doc_keys)} 个文档，预计耗时 3-10 秒",
    )


@router.get(
    "/knowledge/chunk-configs",
    response_model=list[ChunkConfigSchema],
    summary="列出分块配置",
)
async def list_chunk_configs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ChunkConfigSchema]:
    _require_superuser(current_user)
    configs = await knowledge_crud.list_chunk_configs(db)
    return [ChunkConfigSchema.model_validate(c) for c in configs]


@router.post(
    "/knowledge/chunk-configs",
    response_model=ChunkConfigSchema,
    summary="创建分块配置",
)
async def create_chunk_config(
    payload: ChunkConfigCreateSchema,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigSchema:
    _require_superuser(current_user)

    # 校验 overlap < size
    if payload.chunk_overlap >= payload.chunk_size:
        raise HTTPException(
            status_code=400,
            detail=f"chunk_overlap ({payload.chunk_overlap}) 必须小于 chunk_size ({payload.chunk_size})",
        )

    # 检查名称唯一
    existing = await knowledge_crud.get_chunk_config_by_name(db, payload.name)
    if existing:
        if not existing.is_active:
            existing.is_active = True
            await db.commit()
            await db.refresh(existing)
            return ChunkConfigSchema.model_validate(existing)
        raise HTTPException(status_code=409, detail=f"配置名 '{payload.name}' 已存在")

    config = await knowledge_crud.create_chunk_config(
        db,
        name=payload.name,
        description=payload.description,
        splitter=payload.splitter,
        chunk_size=payload.chunk_size,
        chunk_overlap=payload.chunk_overlap,
        min_chunk_len=payload.min_chunk_len,
        metadata_policy=payload.metadata_policy,
        is_default=payload.is_default,
        created_by=current_user.id,
    )
    await db.commit()

    return ChunkConfigSchema.model_validate(config)


@router.put(
    "/knowledge/chunk-configs/{chunk_config_id}",
    response_model=ChunkConfigSchema,
    summary="更新分块配置",
)
async def update_chunk_config(
    chunk_config_id: int,
    payload: ChunkConfigUpdateSchema,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigSchema:
    _require_superuser(current_user)

    config = await knowledge_crud.get_chunk_config_by_id(db, chunk_config_id)
    if not config:
        raise HTTPException(status_code=404, detail="配置不存在")

    # 如果要切换默认，更新旧默认
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=400, detail="没有要更新的字段")

    config = await knowledge_crud.update_chunk_config(
        db,
        chunk_config_id,
        **fields,
    )
    await db.commit()

    return ChunkConfigSchema.model_validate(config)


@router.delete(
    "/knowledge/chunk-configs/{chunk_config_id}",
    response_model=ChunkConfigDeleteResponse,
    summary="删除分块配置",
)
async def delete_chunk_config(
    chunk_config_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChunkConfigDeleteResponse:
    _require_superuser(current_user)

    # 检查是否有版本在使用此配置
    usage_count = await knowledge_crud.count_versions_by_chunk_config(
        db,
        chunk_config_id,
    )
    if usage_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"该配置被 {usage_count} 个版本使用中，无法删除",
        )

    success = await knowledge_crud.delete_chunk_config(db, chunk_config_id)
    if not success:
        raise HTTPException(status_code=404, detail="配置不存在")

    await db.commit()

    return ChunkConfigDeleteResponse(
        success=True,
        message="分块配置已删除",
    )
