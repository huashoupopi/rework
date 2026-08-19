from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.conversation import Conversation
    from app.models.task import Task
    from app.models.user import User


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # deprecated: 会话级上下文只看 Conversation.task_id；新消息不再写入本列
    task_id: Mapped[int | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True, nullable=True
    )
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="chats", lazy="selectin")
    task: Mapped["Task | None"] = relationship(back_populates="chats", lazy="selectin")
    conversation: Mapped["Conversation"] = relationship(
        back_populates="messages", lazy="selectin"
    )
    images: Mapped[list["ChatImage"]] = relationship(
        back_populates="message", lazy="selectin", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_chat_user_task", "user_id", "task_id"),
        Index("idx_chat_user_conv", "user_id", "conversation_id"),
    )


class ChatImage(Base):
    __tablename__ = "chat_images"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="CASCADE"), index=True
    )
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    original_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    message: Mapped["ChatMessage"] = relationship(back_populates="images", lazy="selectin")
