from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.chat import ChatImage, ChatMessage


async def create_message(
    db: AsyncSession,
    user_id: int,
    role: str,
    content: str,
    task_id: int | None = None,
    image_paths: list[tuple[str, str | None]] | None = None,
    meta: dict[str, Any] | None = None,
) -> ChatMessage:
    msg = ChatMessage(user_id=user_id, role=role, content=content, task_id=task_id, meta=meta)
    db.add(msg)
    await db.flush()  # 先flush拿到msg.id 再创建ChatImage
    if image_paths:
        for file_path, original_name in image_paths:
            img = ChatImage(message_id=msg.id, file_path=file_path, original_name=original_name)
            db.add(img)
    await db.commit()
    await db.refresh(msg)
    return msg


async def get_chat_history(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    limit: int = 100,
    order: str = "asc",
    before: int | None = None,
    after: int | None = None,
) -> Sequence[ChatMessage]:
    order_col = ChatMessage.created_at.desc() if order == "desc" else ChatMessage.created_at.asc()
    stmt = (
        select(ChatMessage).where(ChatMessage.user_id == user_id).order_by(order_col).limit(limit)
    )
    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)

    if before is not None:
        stmt = stmt.where(ChatMessage.id < before)
    if after is not None:
        stmt = stmt.where(ChatMessage.id > after)

    result = await db.execute(stmt)
    return result.scalars().all()


async def get_recent_chat_windows(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    turns: int = 4,
    before_message_id: int | None = None,
) -> list[ChatMessage]:
    message_limit = max(1, turns) * 2
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(message_limit)
    )
    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)

    if before_message_id is not None:
        stmt = stmt.where(ChatMessage.id < before_message_id)

    result = await db.execute(stmt)
    message = list(result.scalars().all())
    message.reverse()
    return message


async def count_chat_messages(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
) -> int:
    stmt = select(func.count(ChatMessage.id)).where(ChatMessage.user_id == user_id)
    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)

    result = await db.execute(stmt)
    return result.scalar() or 0
