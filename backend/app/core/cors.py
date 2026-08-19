from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings

if TYPE_CHECKING:
    from fastapi import FastAPI


def apply_cors(app: FastAPI) -> None:
    """把已有的 settings.ALLOWED_ORIGINS 接到 CORS 中间件，禁止 * + credentials。"""
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.ALLOWED_ORIGINS),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
