"""聊天入口护栏：先鉴权任务归属，再加锁，再写消息。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import HTTPException

from app.core.chat_lock import acquire_chat_lock
from app.crud import chat as chat_crud
from app.models.task import Task

if TYPE_CHECKING:
    from redis.asyncio import Redis
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.chat import ChatMessage
    from app.models.user import User


async def ensure_task_owned(
    db: AsyncSession, current_user: User, task_id: int | None
) -> Task | None:
    """非本人与不存在一律 404，避免泄露任务存在性。"""
    if task_id is None:
        return None
    task_row = await db.get(Task, task_id)
    if task_row is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task_row.user_id != current_user.id and not current_user.is_superuser:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task_row


async def authorize_then_lock(
    db: AsyncSession,
    redis: Redis,
    current_user: User,
    task_id: int | None,
) -> tuple[Task | None, str]:
    """必须先归属校验再抢锁。失败时不持锁。"""
    owned = await ensure_task_owned(db, current_user, task_id)
    token = await acquire_chat_lock(redis, current_user.id)
    if token is None:
        raise HTTPException(status_code=409, detail="上一条消息还在生成中，请稍后")
    return owned, token


async def create_user_message_if_authorized(
    db: AsyncSession,
    current_user: User,
    content: str,
    task_id: int | None,
    image_paths: list[tuple[str, str | None]] | None = None,
) -> ChatMessage:
    """鉴权失败不得落库。"""
    await ensure_task_owned(db, current_user, task_id)
    return await chat_crud.create_message(
        db=db,
        user_id=current_user.id,
        role="user",
        content=content,
        task_id=task_id,
        image_paths=image_paths,
    )
