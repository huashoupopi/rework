from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.schemas.user import UserPublic


class TaskSchema(BaseModel):
    id: int
    uuid: str
    file_name: str
    status: str
    original_path: str | None
    result_path: str | None = None
    detect_result: Any = None
    created_at: datetime
    owner: UserPublic | None = None
    model_config = ConfigDict(from_attributes=True)


class TaskPaginationSchema(BaseModel):
    total: int
    items: list[TaskSchema]
    # 全量的各状态计数，不随 status 过滤变化 —— 筛选时仍要能看到全貌
    status_counts: dict[str, int] = {}
    model_config = ConfigDict(from_attributes=True)
