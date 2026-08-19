"""2.3 CORS 必须走 settings.ALLOWED_ORIGINS，禁止 * + credentials。"""

from pathlib import Path

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.config import settings
from app.core.cors import apply_cors

_MAIN = Path(__file__).resolve().parents[1] / "app" / "main.py"


def _mini_app() -> FastAPI:
    app = FastAPI()
    apply_cors(app)

    @app.get("/ping")
    def ping():
        return {"ok": True}

    return app


def test_main_does_not_use_wildcard_origins():
    src = _MAIN.read_text(encoding="utf-8")
    assert "apply_cors" in src
    assert 'allow_origins=["*"]' not in src
    assert "*" not in settings.ALLOWED_ORIGINS


async def test_allowed_origin_receives_acao():
    origin = settings.ALLOWED_ORIGINS[0]
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://test"
    ) as client:
        response = await client.get("/ping", headers={"Origin": origin})
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == origin


async def test_unknown_origin_does_not_receive_acao():
    async with AsyncClient(
        transport=ASGITransport(app=_mini_app()), base_url="http://test"
    ) as client:
        response = await client.get(
            "/ping", headers={"Origin": "http://evil.example.test"}
        )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") != "http://evil.example.test"
    assert response.headers.get("access-control-allow-origin") in (None, "null")
