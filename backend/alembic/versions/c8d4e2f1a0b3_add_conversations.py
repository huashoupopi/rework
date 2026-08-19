"""add conversations and backfill chat_messages.conversation_id

Revision ID: c8d4e2f1a0b3
Revises: efc4bf731595
Create Date: 2026-08-19

upgrade：按 (user_id, task_id) 分组建会话；自由问答每用户一个「历史对话」。
downgrade：先把 Conversation.task_id 回填到该会话全部 ChatMessage.task_id，再删表。
"""

from typing import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c8d4e2f1a0b3"
down_revision: str | Sequence[str] | None = "efc4bf731595"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("task_id", sa.Integer(), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_conversations_id"), "conversations", ["id"], unique=False)
    op.create_index(op.f("ix_conversations_task_id"), "conversations", ["task_id"], unique=False)
    op.create_index(op.f("ix_conversations_user_id"), "conversations", ["user_id"], unique=False)

    op.add_column("chat_messages", sa.Column("conversation_id", sa.Integer(), nullable=True))

    op.execute(
        """
        INSERT INTO conversations (user_id, task_id, title, created_at)
        SELECT s.user_id, s.task_id,
               CASE
                   WHEN length(trim(s.content)) = 0 THEN '任务对话'
                   ELSE left(s.content, 40)
               END,
               s.created_at
        FROM (
            SELECT DISTINCT ON (user_id, task_id)
                   user_id, task_id, content, created_at
            FROM chat_messages
            WHERE task_id IS NOT NULL
            ORDER BY user_id, task_id, created_at ASC, id ASC
        ) AS s
        """
    )
    op.execute(
        """
        UPDATE chat_messages AS m
        SET conversation_id = c.id
        FROM conversations AS c
        WHERE m.user_id = c.user_id
          AND m.task_id IS NOT NULL
          AND c.task_id = m.task_id
        """
    )

    op.execute(
        """
        INSERT INTO conversations (user_id, task_id, title, created_at)
        SELECT s.user_id, NULL,
               CASE
                   WHEN length(trim(s.content)) = 0 THEN '历史对话'
                   ELSE left(s.content, 40)
               END,
               s.created_at
        FROM (
            SELECT DISTINCT ON (user_id)
                   user_id, content, created_at
            FROM chat_messages
            WHERE task_id IS NULL
            ORDER BY user_id, created_at ASC, id ASC
        ) AS s
        """
    )
    op.execute(
        """
        UPDATE chat_messages AS m
        SET conversation_id = c.id
        FROM conversations AS c
        WHERE m.user_id = c.user_id
          AND m.task_id IS NULL
          AND c.task_id IS NULL
        """
    )

    op.alter_column("chat_messages", "conversation_id", existing_type=sa.Integer(), nullable=False)
    op.create_foreign_key(
        "fk_chat_messages_conversation_id",
        "chat_messages",
        "conversations",
        ["conversation_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_chat_messages_conversation_id",
        "chat_messages",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        "idx_chat_user_conv",
        "chat_messages",
        ["user_id", "conversation_id"],
        unique=False,
    )


def downgrade() -> None:
    # 新消息不再写 ChatMessage.task_id，回退前必须从会话真相源回填。
    op.execute(
        """
        UPDATE chat_messages AS m
        SET task_id = c.task_id
        FROM conversations AS c
        WHERE m.conversation_id = c.id
          AND c.task_id IS NOT NULL
        """
    )
    op.drop_index("idx_chat_user_conv", table_name="chat_messages")
    op.drop_index("ix_chat_messages_conversation_id", table_name="chat_messages")
    op.drop_constraint("fk_chat_messages_conversation_id", "chat_messages", type_="foreignkey")
    op.drop_column("chat_messages", "conversation_id")
    op.drop_index(op.f("ix_conversations_user_id"), table_name="conversations")
    op.drop_index(op.f("ix_conversations_task_id"), table_name="conversations")
    op.drop_index(op.f("ix_conversations_id"), table_name="conversations")
    op.drop_table("conversations")
