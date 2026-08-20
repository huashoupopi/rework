"""静态目录边界：公开资源可挂载，上传/结果图必须走鉴权接口。"""

from __future__ import annotations

import os
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi.staticfiles import StaticFiles

if TYPE_CHECKING:
    from fastapi import FastAPI

APP_DIR = Path(__file__).resolve().parent.parent
if (APP_DIR.parent / "static").exists():
    STATIC_DIR = APP_DIR.parent / "static"
else:
    STATIC_DIR = Path("app/static").resolve()

PUBLIC_DIR = STATIC_DIR / "public"
EVALS_RESULTS_DIR = APP_DIR.parent / "evals" / "results"


def mount_public_static(app: FastAPI) -> None:
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    app.mount("/static/public", StaticFiles(directory=PUBLIC_DIR), name="static_public")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_existing_file(stored_path: str | None) -> Path | None:
    """把任务/聊天里存的相对路径解析成 STATIC_DIR 下的真实文件。禁止穿越。"""
    if not stored_path:
        return None
    raw = Path(stored_path)
    candidates: list[Path] = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.append(Path.cwd() / raw)
        candidates.append(STATIC_DIR / raw)
        if raw.parts and raw.parts[0] == "static":
            candidates.append(STATIC_DIR.joinpath(*raw.parts[1:]))
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_file() and _is_within(resolved, STATIC_DIR):
            return resolved
    return None


def resolve_eval_result(name: str | None) -> Path | None:
    """把评测结果文件名解析成 EVALS_RESULTS_DIR 下的真实文件。禁止穿越。"""
    if not name:
        return None
    try:
        resolved = (EVALS_RESULTS_DIR / name).resolve()
    except OSError:
        return None
    if resolved.is_file() and _is_within(resolved, EVALS_RESULTS_DIR):
        return resolved
    return None


def ensure_static_dir() -> None:
    os.makedirs(STATIC_DIR, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
