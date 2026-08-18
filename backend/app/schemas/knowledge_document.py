from datetime import datetime

from pydantic import BaseModel, ConfigDict


class KnowledgeVersionSchema(BaseModel):
    """版本响应 Schema。"""

    id: int
    version: int
    file_name: str
    content_hash: str
    file_size: int
    mime_type: str | None = None
    is_current: bool
    indexed_chunk_config_id: int | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentSchema(BaseModel):
    """文档响应 Schema（含嵌套的当前版本）。"""

    id: int
    doc_key: str
    title: str
    status: str
    latest_version: int
    created_at: datetime
    updated_at: datetime
    current_version: KnowledgeVersionSchema | None = None

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentListSchema(BaseModel):
    """文档分页列表。"""

    total: int
    documents: list[KnowledgeDocumentSchema]


class KnowledgeUploadResponse(BaseModel):
    """上传响应。"""

    created: bool
    message: str
    document: KnowledgeDocumentSchema
    version: KnowledgeVersionSchema
    rebuild_triggered: bool = False
    rebuild_success: bool | None = None
    rebuild_exit_code: int | None = None


class KnowledgeDeleteResponse(BaseModel):
    """删除响应。"""

    success: bool
    doc_key: str
    message: str
