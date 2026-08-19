"""3.2 检测结果导出：字段固定；空结果也是 200。不 import app.main。"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.database import get_db
from app.models.task import Task
from app.models.user import User
from app.routers import task as task_router
from app.routers.auth import get_current_user
from app.services.task_export import EXPORT_FIELDS, detections_from_task, export_json_body


class _FakeDb:
    def __init__(self, task: Task | None):
        self.task = task

    async def get(self, model, ident):
        if model is Task and self.task is not None and ident == self.task.id:
            return self.task
        return None


def _user(user_id: int) -> User:
    return User(id=user_id, username=f"u{user_id}", hashed_password="x", is_superuser=False)


def _task(*, owner_id: int, objects: list | None) -> Task:
    return Task(
        id=88,
        uuid=str(uuid4()),
        file_name="blade.jpg",
        user_id=owner_id,
        detect_result=None if objects is None else {"total": len(objects), "objects": objects},
        created_at=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
    )


def _app(current: User | None, task: Task | None) -> FastAPI:
    app = FastAPI()
    app.include_router(task_router.router, prefix="/api")

    async def override_db():
        yield _FakeDb(task)

    app.dependency_overrides[get_db] = override_db
    if current is not None:

        async def override_user():
            return current

        app.dependency_overrides[get_current_user] = override_user
    return app


def test_serialize_empty_and_fixed_fields():
    task = _task(owner_id=1, objects=[])
    body = export_json_body(task)
    assert body == {"task_id": 88, "detections": []}
    row_task = _task(
        owner_id=1,
        objects=[{"class": "craze", "confidence": 0.87654, "box": [1.1, 2.2, 3.3, 4.4]}],
    )
    rows = detections_from_task(row_task)
    assert list(rows[0].keys()) == list(EXPORT_FIELDS)
    assert rows[0]["confidence"] == 0.8765
    assert rows[0]["defect_class"] == "craze"


async def test_export_json_and_csv_owner_ok():
    owner = _user(1)
    task = _task(
        owner_id=1,
        objects=[{"class": "corrosion", "confidence": 0.5, "box": [0, 1, 2, 3]}],
    )
    app = _app(owner, task)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        json_resp = await client.get("/api/tasks/88/export", params={"format": "json"})
        csv_resp = await client.get("/api/tasks/88/export", params={"format": "csv"})
    assert json_resp.status_code == 200
    payload = json_resp.json()
    assert payload["task_id"] == 88
    assert payload["detections"][0]["defect_class"] == "corrosion"
    assert "task_88_" in json_resp.headers["content-disposition"]
    assert csv_resp.status_code == 200
    rows = list(csv.reader(io.StringIO(csv_resp.text)))
    assert rows[0] == list(EXPORT_FIELDS)
    assert rows[1][2] == "corrosion"


async def test_export_empty_result_is_200_with_fixed_shape():
    owner = _user(1)
    task = _task(owner_id=1, objects=[])
    app = _app(owner, task)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        json_resp = await client.get("/api/tasks/88/export", params={"format": "json"})
        csv_resp = await client.get("/api/tasks/88/export", params={"format": "csv"})
    assert json_resp.status_code == 200
    assert json_resp.json() == {"task_id": 88, "detections": []}
    assert csv_resp.status_code == 200
    rows = list(csv.reader(io.StringIO(csv_resp.text)))
    assert rows == [list(EXPORT_FIELDS)]


async def test_export_foreign_or_anonymous_denied():
    owner_task = _task(owner_id=1, objects=[])
    other = _user(2)
    app_other = _app(other, owner_task)
    app_anon = _app(None, owner_task)
    async with AsyncClient(
        transport=ASGITransport(app=app_other), base_url="http://test"
    ) as client:
        assert (await client.get("/api/tasks/88/export", params={"format": "json"})).status_code == 404
    async with AsyncClient(
        transport=ASGITransport(app=app_anon), base_url="http://test"
    ) as client:
        assert (await client.get("/api/tasks/88/export", params={"format": "json"})).status_code == 401
