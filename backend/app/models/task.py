from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import JSON, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.chat import ChatMessage
    from app.models.user import User


class TaskStatus(Enum):
    PENDING = "pending"
    PROGRESSING = "progressing"
    COMPLETED = "completed"
    FAILED = "failed"


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    uuid: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=TaskStatus.PENDING.value
    )
    original_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    result_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    detect_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)

    owner: Mapped["User"] = relationship(back_populates="tasks", lazy="selectin")
    chats: Mapped[list["ChatMessage"]] = relationship(
        back_populates="task", lazy="selectin", cascade="all, delete-orphan"
    )
