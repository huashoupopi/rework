"""P3 评测报告 API：非 superuser 404；路径穿越（含软链）被拒。

只挂 eval_report 路由，不 import app.main / RagService。
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core import static_paths
from app.models.user import User
from app.routers import eval_report as eval_report_router
from app.routers.auth import get_current_user

if TYPE_CHECKING:
    from pathlib import Path

SECRET_MARKER = "secret-should-not-leak"


def _user(*, superuser: bool) -> User:
    return User(
        id=1 if superuser else 2,
        username="admin" if superuser else "demo",
        hashed_password="x",
        is_superuser=superuser,
    )


def _build_app(current: User | None) -> FastAPI:
    app = FastAPI()
    app.include_router(eval_report_router.router, prefix="/api")
    if current is not None:

        async def override_user():
            return current

        app.dependency_overrides[get_current_user] = override_user
    return app


def _write_eval(path: Path, *, passed: int = 36, total: int = 36) -> None:
    payload = {
        "summary": {
            "total_cases": total,
            "passed_cases": passed,
            "pass_rate": round(passed / total, 2) if total else 0.0,
        },
        "layers": {"retrieval": {"passed": passed, "total": total}},
        "results": [],
    }
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.fixture
def eval_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "evals" / "results"
    root.mkdir(parents=True)
    monkeypatch.setattr(static_paths, "EVALS_RESULTS_DIR", root)
    return root


async def test_eval_list_forbidden_non_superuser_is_404(eval_root: Path):
    _write_eval(eval_root / "eval30_visible.json")
    app = _build_app(_user(superuser=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/evals")
    assert response.status_code == 404
    assert "eval30_visible.json" not in response.text


async def test_eval_detail_forbidden_non_superuser_is_404(eval_root: Path):
    _write_eval(eval_root / "eval30_visible.json")
    app = _build_app(_user(superuser=False))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/evals/eval30_visible.json")
    assert response.status_code == 404
    assert "eval30_visible.json" not in response.text
    assert "pass_rate" not in response.text


async def test_eval_list_unauthenticated_is_401(eval_root: Path):
    _write_eval(eval_root / "eval30_visible.json")
    app = _build_app(None)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/evals")
    assert response.status_code == 401


async def test_eval_superuser_list_and_detail(eval_root: Path):
    _write_eval(eval_root / "eval30_ok.json", passed=35, total=36)
    (eval_root / "notes.txt").write_text("ignore", encoding="utf-8")
    (eval_root / "broken.json").write_text("{", encoding="utf-8")
    app = _build_app(_user(superuser=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        listed = await client.get("/api/evals")
        detail = await client.get("/api/evals/eval30_ok.json")
        missing = await client.get("/api/evals/eval30_missing.json")
    assert listed.status_code == 200
    items = listed.json()["items"]
    assert [row["name"] for row in items] == ["eval30_ok.json"]
    assert items[0]["summary"]["passed_cases"] == 35
    assert detail.status_code == 200
    assert detail.json()["name"] == "eval30_ok.json"
    assert detail.json()["summary"]["total_cases"] == 36
    assert missing.status_code == 404


async def test_eval_detail_traversal_dotdot_is_404(eval_root: Path, tmp_path: Path):
    secret = tmp_path / "secret.json"
    secret.write_text(json.dumps({"marker": SECRET_MARKER}), encoding="utf-8")
    app = _build_app(_user(superuser=True))
    names = [
        "../secret.json",
        "..%2Fsecret.json",
        "..%2fsecret.json",
        "%2e%2e/%2e%2e/secret.json",
    ]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for name in names:
            response = await client.get(f"/api/evals/{name}")
            assert response.status_code == 404, name
            assert SECRET_MARKER not in response.text


async def test_eval_detail_traversal_absolute_is_404(eval_root: Path, tmp_path: Path):
    secret = tmp_path / "abs-secret.json"
    secret.write_text(json.dumps({"marker": SECRET_MARKER}), encoding="utf-8")
    app = _build_app(_user(superuser=True))
    names = [
        str(secret),
        secret.as_posix(),
        f"/{secret.as_posix().lstrip('/')}",
    ]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        for name in names:
            response = await client.get(f"/api/evals/{name}")
            assert response.status_code == 404, name
            assert SECRET_MARKER not in response.text


async def test_eval_detail_traversal_symlink_is_404(eval_root: Path, tmp_path: Path):
    secret = tmp_path / "linked-secret.json"
    secret.write_text(json.dumps({"marker": SECRET_MARKER, "summary": {}}), encoding="utf-8")
    link = eval_root / "eval30_link.json"
    link.symlink_to(secret)
    assert link.is_symlink()

    app = _build_app(_user(superuser=True))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        listed = await client.get("/api/evals")
        detail = await client.get("/api/evals/eval30_link.json")
    assert listed.status_code == 200
    assert listed.json()["items"] == []
    assert detail.status_code == 404
    assert SECRET_MARKER not in detail.text
