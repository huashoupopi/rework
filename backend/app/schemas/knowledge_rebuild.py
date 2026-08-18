from pydantic import BaseModel


class KnowledgeRebuildResponse(BaseModel):
    """重建响应。"""

    success: bool
    message: str | None = None
    scope: str | None = None  # "full" 或 "incremental"
    document_id: int | None = None
    exit_code: int | None = None
    duration_ms: float | None = None
    chunk_config_id: int | None = None
    stdout: str | None = None
    stderr: str | None = None
