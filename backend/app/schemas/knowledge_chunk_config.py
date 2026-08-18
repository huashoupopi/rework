from datetime import datetime

from pydantic import BaseModel, ConfigDict, field_validator


class ChunkConfigBaseSchema(BaseModel):
    """分块配置基础字段。"""

    name: str
    description: str | None = None
    splitter: str = "sentence"
    chunk_size: int = 800
    chunk_overlap: int = 150
    min_chunk_len: int = 20
    metadata_policy: str = "basic"
    is_active: bool = True
    is_default: bool = False


class ChunkConfigCreateSchema(ChunkConfigBaseSchema):
    """创建请求。"""

    @field_validator("chunk_overlap")
    @classmethod
    def overlap_must_be_less_than_size(cls, v, info):
        chunk_size = info.data.get("chunk_size", 800)
        if v >= chunk_size:
            raise ValueError(f"chunk_overlap ({v}) 必须小于 chunk_size ({chunk_size})")
        return v


class ChunkConfigUpdateSchema(BaseModel):
    """更新请求（所有字段可选）。"""

    name: str | None = None
    description: str | None = None
    splitter: str | None = None
    chunk_size: int | None = None
    chunk_overlap: int | None = None
    min_chunk_len: int | None = None
    metadata_policy: str | None = None
    is_active: bool | None = None
    is_default: bool | None = None


class ChunkConfigSchema(ChunkConfigBaseSchema):
    """响应 Schema。"""

    id: int
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChunkConfigDeleteResponse(BaseModel):
    """删除响应。"""

    success: bool
    message: str
