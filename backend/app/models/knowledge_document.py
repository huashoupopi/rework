from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.knowledge_chunk_config import KnowledgeChunkConfig


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    doc_key: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(
        String(20), default="active", index=True
    )  # active, archived, deleted
    latest_version: Mapped[int] = mapped_column(default=0)

    indexed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    index_status: Mapped[str] = mapped_column(
        String(20), default="pending", index=True
    )  # pending, indexing, indexed, failed
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_build_attempt_at: Mapped[datetime | None] = mapped_column(nullable=True)

    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)

    versions: Mapped[list["KnowledgeDocumentVersion"]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="KnowledgeDocumentVersion.version.desc()",
    )


class KnowledgeDocumentVersion(Base):
    __tablename__ = "knowledge_document_versions"
    __table_args__ = (
        Index("uq_doc_version", "document_id", "version", unique=True),
        Index("uq_doc_hash", "document_id", "content_hash", unique=True),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("knowledge_documents.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column()
    file_name: Mapped[str] = mapped_column(String(255))
    storage_path: Mapped[str] = mapped_column(String(500))
    active_path: Mapped[str] = mapped_column(String(500))
    content_hash: Mapped[str] = mapped_column(String(64), index=True)  # 文件内容的哈希值，用于去重
    file_size: Mapped[int] = mapped_column(default=0)
    mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_current: Mapped[bool] = mapped_column(default=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)

    indexed_chunk_config_id: Mapped[int | None] = mapped_column(
        ForeignKey("knowledge_chunk_config.id"), nullable=True
    )
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    document: Mapped["KnowledgeDocument"] = relationship(
        back_populates="versions", lazy="selectin"
    )
    chunk_config: Mapped["KnowledgeChunkConfig | None"] = relationship(lazy="selectin")
