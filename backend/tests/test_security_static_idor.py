"""2.1 静态资源 IDOR：鉴权 FileResponse；旧 /static/uploads 不再可达。

只挂 task/media 路由，不 import app.main / RagService。
"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.database import get_db
from app.core.static_paths import PUBLIC_DIR, STATIC_DIR, mount_public_static
from app.models.chat import ChatImage, ChatMessage
from app.models.task import Task
from app.models.user import User
from app.routers import media as media_router
from app.routers import task as task_router
from app.routers.auth import get_current_user

pytestmark = pytest.mark.needs_db

_MIN_JPEG = (
    b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
)


class _FakeDb:
    def __init__(self, store: dict):
        self.store = store

    async def get(self, model, ident):
        return self.store.get((model, ident))


def _user(user_id: int, *, superuser: bool = False) -> User:
    return User(
        id=user_id,
        username=f"u{user_id}",
        hashed_password="x",
        is_superuser=superuser,
    )


def _build_app(current: User | None, store: dict) -> FastAPI:
    app = FastAPI()
    app.include_router(task_router.router, prefix="/api")
    app.include_router(media_router.router, prefix="/api")
    mount_public_static(app)

    async def override_db():
        yield _FakeDb(store)

    app.dependency_overrides[get_db] = override_db
    if current is not None:
        async def override_user():
            return current

        app.dependency_overrides[get_current_user] = override_user
    return app


@pytest.fixture
def jpeg_file():
    uploads = STATIC_DIR / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    path = uploads / f"sec_{uuid4().hex}.jpg"
    path.write_bytes(_MIN_JPEG)
    yield path
    path.unlink(missing_ok=True)


async def test_task_image_unauthenticated_is_401(jpeg_file: Path):
    task = Task(
        id=11,
        uuid=str(uuid4()),
        file_name="a.jpg",
        user_id=1,
        original_path=str(jpeg_file),
        result_path=str(jpeg_file),
    )
    app = _build_app(None, {(Task, 11): task})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/tasks/11/image", params={"kind": "original"})
    assert response.status_code == 401


async def test_task_image_other_user_is_404(jpeg_file: Path):
    owner = _user(1)
    other = _user(2)
    task = Task(
        id=12,
        uuid=str(uuid4()),
        file_name="a.jpg",
        user_id=owner.id,
        original_path=str(jpeg_file),
        result_path=str(jpeg_file),
    )
    app = _build_app(other, {(Task, 12): task})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/tasks/12/image", params={"kind": "result"})
    assert response.status_code == 404
    assert response.content != _MIN_JPEG


async def test_task_image_owner_is_200(jpeg_file: Path):
    owner = _user(1)
    task = Task(
        id=13,
        uuid=str(uuid4()),
        file_name="a.jpg",
        user_id=owner.id,
        original_path=str(jpeg_file),
        result_path=str(jpeg_file),
    )
    app = _build_app(owner, {(Task, 13): task})
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/tasks/13/image", params={"kind": "original"})
    assert response.status_code == 200
    assert response.content == _MIN_JPEG


async def test_chat_image_other_user_is_404(jpeg_file: Path):
    owner = _user(1)
    other = _user(2)
    rel = f"uploads/{jpeg_file.name}"
    message = ChatMessage(id=21, user_id=owner.id, role="user", content="hi")
    image = ChatImage(id=31, message_id=21, file_path=rel)
    store = {(ChatImage, 31): image, (ChatMessage, 21): message}
    app = _build_app(other, store)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/chat/images/31")
    assert response.status_code == 404


async def test_chat_image_owner_is_200(jpeg_file: Path):
    owner = _user(1)
    rel = f"uploads/{jpeg_file.name}"
    message = ChatMessage(id=22, user_id=owner.id, role="user", content="hi")
    image = ChatImage(id=32, message_id=22, file_path=rel)
    store = {(ChatImage, 32): image, (ChatMessage, 22): message}
    app = _build_app(owner, store)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/chat/images/32")
    assert response.status_code == 200
    assert response.content == _MIN_JPEG


async def test_legacy_static_upload_path_not_mounted(jpeg_file: Path):
    app = FastAPI()
    mount_public_static(app)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        blocked = await client.get(f"/static/uploads/{jpeg_file.name}")
        blocked_root = await client.get(f"/static/{jpeg_file.name}")
    assert blocked.status_code == 404
    assert blocked_root.status_code == 404


async def test_public_static_still_served():
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    public_file = PUBLIC_DIR / f"sec_{uuid4().hex}.txt"
    public_file.write_text("ok", encoding="utf-8")
    app = FastAPI()
    mount_public_static(app)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(f"/static/public/{public_file.name}")
        assert response.status_code == 200
        assert response.text == "ok"
    finally:
        public_file.unlink(missing_ok=True)


def test_main_no_longer_mounts_whole_static_tree():
    src = (Path(__file__).resolve().parents[1] / "app" / "main.py").read_text(encoding="utf-8")
    assert "mount_public_static" in src
    assert "StaticFiles(directory=STATIC_DIR)" not in src
