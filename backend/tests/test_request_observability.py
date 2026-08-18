import logging
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

pytestmark = pytest.mark.needs_db
from httpx import ASGITransport, AsyncClient

from app.core.database import get_db
from app.core.logging import setup_logging
from app.main import app
from app.routers import chat as chat_router
from app.routers.auth import get_current_user


class _FakeRedis:
    async def set(self, *args, **kwargs):
        return True

    async def delete(self, *args, **kwargs):
        return 1


class _FakeBgSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False


class _FakeDb:
    async def get(self, *args, **kwargs):
        return None


@pytest.mark.asyncio
async def test_request_context_middleware_reuses_incoming_request_id_and_exposes_it():
    from app.core.request_context import RequestContextMiddleware, get_request_id

    local_app = FastAPI()
    local_app.add_middleware(RequestContextMiddleware)

    @local_app.get("/echo")
    async def echo():
        return {"request_id": get_request_id()}

    async with AsyncClient(transport=ASGITransport(app=local_app), base_url="http://test") as client:
        response = await client.get("/echo", headers={"X-Request-ID": "req-123"})

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "req-123"
    assert response.json() == {"request_id": "req-123"}


@pytest.mark.asyncio
async def test_health_endpoint_generates_request_id_header_when_missing():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    request_id = response.headers.get("X-Request-ID")
    assert request_id
    assert len(request_id) >= 8


@pytest.mark.asyncio
async def test_chat_stream_returns_request_id_header_and_logs_request_context(monkeypatch, caplog):
    setup_logging()
    caplog.set_level(logging.INFO)

    async def override_user():
        return SimpleNamespace(id=123)

    async def override_db():
        yield _FakeDb()

    async def fake_rate_limit(*args, **kwargs):
        return None

    async def fake_create_message(*args, **kwargs):
        role = kwargs.get("role")
        if role == "assistant":
            return SimpleNamespace(id=2)
        return SimpleNamespace(id=1)

    async def fake_recent_chat_windows(*args, **kwargs):
        return []

    async def fake_generate_chat_stream(**kwargs):
        result_meta = kwargs.get("result_meta")
        if result_meta is not None:
            result_meta["route"] = "rag"
            result_meta["sources"] = [{"id": 1, "doc": "doc.md", "score": 0.4, "snippet": "chunk"}]
        yield "你好，世界"

    app.dependency_overrides[get_current_user] = override_user
    app.dependency_overrides[get_db] = override_db

    monkeypatch.setattr(chat_router, "rate_limit", fake_rate_limit)
    monkeypatch.setattr(chat_router, "get_redis", lambda: _FakeRedis())
    monkeypatch.setattr(chat_router.chat_crud, "create_message", fake_create_message)
    monkeypatch.setattr(chat_router.chat_crud, "get_recent_chat_windows", fake_recent_chat_windows)
    monkeypatch.setattr(chat_router, "AsyncSessionLocal", lambda: _FakeBgSession())
    monkeypatch.setattr(
        chat_router.RagService,
        "generate_chat_stream",
        fake_generate_chat_stream,
    )

    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.post(
                "/api/chat/stream",
                data={"question": "这是什么缺陷"},
                headers={"Authorization": "Bearer fake-token", "X-Request-ID": "chat-req-1"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "chat-req-1"
    assert "你好，世界" in response.text

    start_logs = [
        record for record in caplog.records if "chat event=start" in record.getMessage()
    ]
    done_logs = [
        record for record in caplog.records if "chat event=done" in record.getMessage()
    ]

    assert start_logs
    assert done_logs
    assert any(getattr(record, "request_id", None) == "chat-req-1" for record in start_logs)
    assert any(getattr(record, "request_id", None) == "chat-req-1" for record in done_logs)
