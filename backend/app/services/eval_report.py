"""评测结果只读扫描。路径边界复用 static_paths._is_within。"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from app.core import static_paths

if TYPE_CHECKING:
    from pathlib import Path


def list_eval_reports() -> list[dict[str, Any]]:
    root = static_paths.EVALS_RESULTS_DIR.resolve()
    if not root.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in sorted(root.glob("eval30_*.json"), reverse=True):
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if not resolved.is_file() or not static_paths._is_within(resolved, root):
            continue
        payload = _read_json(resolved)
        if payload is None:
            continue
        summary = payload.get("summary") or {}
        layers = {
            name: {
                "passed": entry.get("passed"),
                "total": entry.get("total"),
            }
            for name, entry in (payload.get("layers") or {}).items()
        }
        items.append({"name": resolved.name, "summary": summary, "layers": layers})
    return items


def get_eval_report(name: str) -> dict[str, Any] | None:
    path = static_paths.resolve_eval_result(name)
    if path is None:
        return None
    payload = _read_json(path)
    if payload is None:
        return None
    return {"name": path.name, **payload}


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return data
