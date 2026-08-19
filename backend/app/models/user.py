from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, String, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.chat import ChatMessage
    from app.models.conversation import Conversation
    from app.models.task import Task


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    # 这里使用server_default让数据库自动设置时间，避免时区问题，查询时直接用datetime对象 而不是用default=datetime.now
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    # 反向关系，User对象可以通过tasks属性访问关联的Task对象列表
    tasks: Mapped[list["Task"]] = relationship(
        back_populates="owner", lazy="selectin", cascade="all, delete-orphan"
    )
    chats: Mapped[list["ChatMessage"]] = relationship(
        back_populates="user", lazy="selectin", cascade="all, delete-orphan"
    )
    conversations: Mapped[list["Conversation"]] = relationship(
        back_populates="user", lazy="selectin", cascade="all, delete-orphan"
    )
