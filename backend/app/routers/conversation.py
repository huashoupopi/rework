from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.crud import chat as chat_crud
from app.crud import conversation as conversation_crud
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.chat import ChatHistoryResponse, ChatMessageSchema
from app.schemas.conversation import (
    ConversationCreate,
    ConversationListResponse,
    ConversationPublic,
    ConversationUpdate,
)
from app.services.chat_guard import ensure_task_owned

router = APIRouter(tags=["conversations"])


async def _owned_or_404(
    db: AsyncSession, user: User, conversation_id: int
):
    conv = await conversation_crud.get_owned(db, user.id, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return conv


@router.get("/conversations", response_model=ConversationListResponse)
async def list_conversations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationListResponse:
    items = await conversation_crud.list_conversations(db, current_user.id)
    return ConversationListResponse(
        items=[ConversationPublic.model_validate(item) for item in items]
    )


@router.post("/conversations", response_model=ConversationPublic)
async def create_conversation(
    body: ConversationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationPublic:
    if body.task_id is not None:
        await ensure_task_owned(db, current_user, body.task_id)
    conv = await conversation_crud.create_conversation(
        db, current_user.id, body.task_id, body.title
    )
    return ConversationPublic.model_validate(conv)


@router.get("/conversations/{conversation_id}", response_model=ConversationPublic)
async def get_conversation(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationPublic:
    conv = await _owned_or_404(db, current_user, conversation_id)
    return ConversationPublic.model_validate(conv)


@router.patch("/conversations/{conversation_id}", response_model=ConversationPublic)
async def rename_conversation(
    conversation_id: int,
    body: ConversationUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ConversationPublic:
    conv = await _owned_or_404(db, current_user, conversation_id)
    conv = await conversation_crud.rename_conversation(db, conv, body.title)
    return ConversationPublic.model_validate(conv)


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    conv = await _owned_or_404(db, current_user, conversation_id)
    await conversation_crud.delete_conversation(db, conv)


@router.get("/conversations/{conversation_id}/messages", response_model=ChatHistoryResponse)
async def list_conversation_messages(
    conversation_id: int,
    limit: int = Query(50, ge=1, le=200),
    order: str = Query(default="asc", pattern="^(asc|desc)$"),
    before: int | None = Query(None),
    after: int | None = Query(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChatHistoryResponse:
    await _owned_or_404(db, current_user, conversation_id)
    history = await chat_crud.get_chat_history(
        db=db,
        user_id=current_user.id,
        conversation_id=conversation_id,
        limit=limit,
        order=order,
        before=before,
        after=after,
    )
    total = await chat_crud.count_chat_messages(
        db, user_id=current_user.id, conversation_id=conversation_id
    )
    items = [ChatMessageSchema.model_validate(msg) for msg in history]
    return ChatHistoryResponse(
        items=items,
        total=total,
        has_more=len(items) == limit,
        oldest_id=items[0].id if items else None,
        newest_id=items[-1].id if items else None,
    )
