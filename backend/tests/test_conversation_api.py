"""3.1 会话 API：归属 404、互不串历史、级联删除。不 import app.main / RagService。"""

from __future__ import annotations

from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select

from app.core.database import get_db
from app.crud import chat as chat_crud
from app.models.chat import ChatMessage
from app.models.conversation import Conversation
from app.models.task import Task, TaskStatus
from app.models.user import User
from app.routers import conversation as conversation_router
from app.routers.auth import get_current_user
from tests.dbutil import isolated_session

pytestmark = pytest.mark.needs_db


@pytest.fixture
async def two_users():
    suffix = uuid4().hex[:10]
    async with isolated_session() as db:
        owner = User(username=f"cv_own_{suffix}", hashed_password="x", is_superuser=False)
        other = User(username=f"cv_oth_{suffix}", hashed_password="x", is_superuser=False)
        db.add_all([owner, other])
        await db.commit()
        await db.refresh(owner)
        await db.refresh(other)
        owner_id, other_id = owner.id, other.id
        task = Task(
            uuid=str(uuid4()),
            file_name="cv.jpg",
            user_id=owner_id,
            status=TaskStatus.COMPLETED.value,
        )
        db.add(task)
        await db.commit()
        await db.refresh(task)
        task_id = task.id
    try:
        yield owner_id, other_id, task_id
    finally:
        async with isolated_session() as db:
            await db.execute(delete(User).where(User.id.in_([owner_id, other_id])))
            await db.commit()


def _app_for(user_id: int) -> FastAPI:
    app = FastAPI()
    app.include_router(conversation_router.router, prefix="/api")

    async def override_user():
        async with isolated_session() as db:
            user = await db.get(User, user_id)
            assert user is not None
            return user

    async def override_db():
        async with isolated_session() as db:
            yield db

    app.dependency_overrides[get_current_user] = override_user
    app.dependency_overrides[get_db] = override_db
    return app


async def test_create_list_and_foreign_user_404(two_users):
    owner_id, other_id, task_id = two_users
    owner_app = _app_for(owner_id)
    other_app = _app_for(other_id)
    async with AsyncClient(
        transport=ASGITransport(app=owner_app), base_url="http://test"
    ) as owner:
        created = await owner.post("/api/conversations", json={"task_id": task_id, "title": "叶片A"})
        assert created.status_code == 200
        conv_id = created.json()["id"]
        listed = await owner.get("/api/conversations")
        assert listed.status_code == 200
        assert any(item["id"] == conv_id for item in listed.json()["items"])
    async with AsyncClient(
        transport=ASGITransport(app=other_app), base_url="http://test"
    ) as other:
        got = await other.get(f"/api/conversations/{conv_id}")
        deleted = await other.delete(f"/api/conversations/{conv_id}")
        assert got.status_code == 404
        assert deleted.status_code == 404


async def test_two_conversations_do_not_share_history(two_users):
    owner_id, _other_id, task_id = two_users
    async with isolated_session() as db:
        a = Conversation(user_id=owner_id, task_id=task_id, title="会话A")
        b = Conversation(user_id=owner_id, task_id=task_id, title="会话B")
        db.add_all([a, b])
        await db.commit()
        await db.refresh(a)
        await db.refresh(b)
        await chat_crud.create_message(
            db, owner_id, "user", "只属于A", conversation_id=a.id, task_id=None
        )
        await chat_crud.create_message(
            db, owner_id, "user", "只属于B", conversation_id=b.id, task_id=None
        )
        a_id, b_id = a.id, b.id
    app = _app_for(owner_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        hist_a = await client.get(f"/api/conversations/{a_id}/messages")
        hist_b = await client.get(f"/api/conversations/{b_id}/messages")
    texts_a = [item["content"] for item in hist_a.json()["items"]]
    texts_b = [item["content"] for item in hist_b.json()["items"]]
    assert texts_a == ["只属于A"]
    assert texts_b == ["只属于B"]


async def test_delete_conversation_cascades_messages(two_users):
    owner_id, _other_id, _task_id = two_users
    async with isolated_session() as db:
        conv = Conversation(user_id=owner_id, task_id=None, title="待删")
        db.add(conv)
        await db.commit()
        await db.refresh(conv)
        await chat_crud.create_message(
            db, owner_id, "user", "会被删", conversation_id=conv.id, task_id=None
        )
        conv_id = conv.id
    app = _app_for(owner_id)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        renamed = await client.patch(f"/api/conversations/{conv_id}", json={"title": "新名字"})
        assert renamed.status_code == 200
        assert renamed.json()["title"] == "新名字"
        deleted = await client.delete(f"/api/conversations/{conv_id}")
        assert deleted.status_code == 204
    async with isolated_session() as db:
        leftover_conv = await db.get(Conversation, conv_id)
        leftover_msg = await db.execute(
            select(func.count(ChatMessage.id)).where(ChatMessage.conversation_id == conv_id)
        )
        assert leftover_conv is None
        assert leftover_msg.scalar_one() == 0
