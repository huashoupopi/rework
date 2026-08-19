from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.conversation import Conversation

DEFAULT_FREE_TITLE = "历史对话"
DEFAULT_TASK_TITLE = "任务对话"
DEFAULT_NEW_TITLE = "新对话"
PLACEHOLDER_TITLES = {DEFAULT_FREE_TITLE, DEFAULT_TASK_TITLE, DEFAULT_NEW_TITLE}


async def get_owned(
    db: AsyncSession, user_id: int, conversation_id: int
) -> Conversation | None:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != user_id:
        return None
    return conv


async def list_conversations(db: AsyncSession, user_id: int) -> list[Conversation]:
    stmt = (
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .order_by(Conversation.created_at.desc(), Conversation.id.desc())
    )
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_conversation(
    db: AsyncSession,
    user_id: int,
    task_id: int | None,
    title: str | None,
) -> Conversation:
    conv = Conversation(
        user_id=user_id,
        task_id=task_id,
        title=(title.strip() if title and title.strip() else DEFAULT_NEW_TITLE),
    )
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return conv


async def find_for_task(
    db: AsyncSession, user_id: int, task_id: int
) -> Conversation | None:
    stmt = (
        select(Conversation)
        .where(Conversation.user_id == user_id, Conversation.task_id == task_id)
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def find_free(db: AsyncSession, user_id: int) -> Conversation | None:
    stmt = (
        select(Conversation)
        .where(Conversation.user_id == user_id, Conversation.task_id.is_(None))
        .order_by(Conversation.created_at.asc(), Conversation.id.asc())
        .limit(1)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def get_or_create_for_task(
    db: AsyncSession, user_id: int, task_id: int
) -> Conversation:
    existing = await find_for_task(db, user_id, task_id)
    if existing:
        return existing
    return await create_conversation(db, user_id, task_id, DEFAULT_TASK_TITLE)


async def get_or_create_free(db: AsyncSession, user_id: int) -> Conversation:
    existing = await find_free(db, user_id)
    if existing:
        return existing
    return await create_conversation(db, user_id, None, DEFAULT_FREE_TITLE)


async def rename_conversation(db: AsyncSession, conv: Conversation, title: str) -> Conversation:
    conv.title = title.strip()[:255]
    await db.commit()
    await db.refresh(conv)
    return conv


async def delete_conversation(db: AsyncSession, conv: Conversation) -> None:
    await db.delete(conv)
    await db.commit()


async def maybe_set_title_from_first_message(
    db: AsyncSession, conv: Conversation, content: str
) -> None:
    if conv.title not in PLACEHOLDER_TITLES:
        return
    trimmed = content.strip()
    if not trimmed:
        return
    conv.title = trimmed[:40]
    await db.commit()
