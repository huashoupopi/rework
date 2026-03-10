from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ChatRequest(BaseModel):
    question: str
    task_id: int | None = None


class ChatImageSchema(BaseModel):
    id: int
    file_path: str
    original_name: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatMessageSchema(BaseModel):
    id: int
    role: str
    content: str
    images: list[ChatImageSchema] = []
    meta: dict[str, Any] | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatHistoryResponse(BaseModel):
    items: list[ChatMessageSchema]
    total: int
    has_more: bool
    oldest_id: int | None
    newest_id: int | None
