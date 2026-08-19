"""2.2 聊天 task_id IDOR：校验必须在加锁/写消息之前；失败不得落脏数据。"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import delete, func, select

from app.core.chat_lock import chat_lock_key
from app.core.config import settings
from app.crud import chat as chat_crud
from app.models.chat import ChatMessage
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.services.chat_guard import (
    authorize_then_lock,
    create_user_message_if_authorized,
    ensure_task_owned,
)
from tests.dbutil import isolated_session

pytestmark = pytest.mark.needs_db


class _RecordingDb:
    def __init__(self, tasks: dict[int, SimpleNamespace]):
        self.tasks = tasks
        self.added: list[object] = []
        self.committed = False

    async def get(self, model, ident):
        if model is Task:
            return self.tasks.get(ident)
        return None

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        for obj in self.added:
            if getattr(obj, "id", None) is None:
                obj.id = 1

    async def commit(self):
        self.committed = True

    async def refresh(self, obj):
        return obj


async def test_foreign_task_is_404_not_403():
    db = _RecordingDb({7: SimpleNamespace(id=7, user_id=99)})
    attacker = SimpleNamespace(id=2, is_superuser=False)
    with pytest.raises(HTTPException) as exc:
        await ensure_task_owned(db, attacker, 7)
    assert exc.value.status_code == 404


async def test_missing_task_is_404():
    db = _RecordingDb({})
    user = SimpleNamespace(id=2, is_superuser=False)
    with pytest.raises(HTTPException) as exc:
        await ensure_task_owned(db, user, 40404)
    assert exc.value.status_code == 404


async def test_foreign_task_does_not_write_message():
    db = _RecordingDb({7: SimpleNamespace(id=7, user_id=99)})
    attacker = SimpleNamespace(id=2, is_superuser=False)
    with pytest.raises(HTTPException) as exc:
        await create_user_message_if_authorized(db, attacker, "偷看", 7)
    assert exc.value.status_code == 404
    assert db.added == []
    assert db.committed is False


async def test_own_task_passes_authorization():
    db = _RecordingDb({7: SimpleNamespace(id=7, user_id=2)})
    owner = SimpleNamespace(id=2, is_superuser=False)
    owned = await ensure_task_owned(db, owner, 7)
    assert owned.id == 7


async def test_idor_does_not_acquire_lock_or_write_on_real_db():
    import redis.asyncio as redis

    suffix = uuid4().hex[:10]
    r = redis.from_url(settings.REDIS_URL, decode_responses=True)
    owner_id = attacker_id = task_id = None
    try:
        async with isolated_session() as db:
            owner = User(
                username=f"sec_own_{suffix}",
                hashed_password="x",
                is_superuser=False,
            )
            attacker = User(
                username=f"sec_atk_{suffix}",
                hashed_password="x",
                is_superuser=False,
            )
            db.add_all([owner, attacker])
            await db.commit()
            await db.refresh(owner)
            await db.refresh(attacker)
            owner_id, attacker_id = owner.id, attacker.id
            task = Task(
                uuid=str(uuid4()),
                file_name="idor.jpg",
                user_id=owner.id,
                status=TaskStatus.COMPLETED.value,
            )
            db.add(task)
            await db.commit()
            await db.refresh(task)
            task_id = task.id

            before = await chat_crud.count_chat_messages(
                db, user_id=attacker.id, task_id=task.id
            )
            with pytest.raises(HTTPException) as exc:
                await authorize_then_lock(db, r, attacker, task.id)
            assert exc.value.status_code == 404
            assert await r.get(chat_lock_key(attacker.id)) is None

            with pytest.raises(HTTPException):
                await create_user_message_if_authorized(db, attacker, "脏消息", task.id)
            after = await chat_crud.count_chat_messages(
                db, user_id=attacker.id, task_id=task.id
            )
            assert after == before == 0

            leftover = await db.execute(
                select(func.count(ChatMessage.id)).where(
                    ChatMessage.user_id == attacker.id,
                    ChatMessage.content == "脏消息",
                )
            )
            assert leftover.scalar_one() == 0
    finally:
        await r.aclose()
        async with isolated_session() as db:
            ids = [i for i in (owner_id, attacker_id) if i is not None]
            if ids:
                await db.execute(delete(User).where(User.id.in_(ids)))
                await db.commit()
        _ = task_id


def test_chat_stream_checks_ownership_before_lock_and_write():
    src = (Path(__file__).resolve().parents[1] / "app" / "routers" / "chat.py").read_text(
        encoding="utf-8"
    )
    body = src[src.index("async def chat_stream") :]
    validate_at = body.index("prepare_upload_images")
    auth_at = body.index("resolve_chat_conversation")
    lock_at = body.index("acquire_chat_lock")
    write_at = body.index("chat_crud.create_message")
    assert validate_at < auth_at < lock_at < write_at
    assert 'set(lock_key, "1"' not in src
    assert "await r.delete(lock_key)" not in src
