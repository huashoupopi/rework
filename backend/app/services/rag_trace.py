"""RAG 链路结构化 trace。

复用 RAG_EVAL_DEBUG：关闭时 maybe_start_trace() 返回 None，不构造对象。
逐跳 ms 是相邻 lap 的差值，不是从总起点起算的累计值。
"""

from __future__ import annotations

import time
from typing import Any

from app.core.config import settings
from app.core.request_context import get_request_id

STEP_NAMES = ("rewrite", "retrieve", "rerank", "route", "generate")


class RagTrace:
    def __init__(self, request_id: str) -> None:
        self.request_id = request_id
        self._t0 = time.perf_counter()
        self._lap = self._t0
        self.steps: list[dict[str, Any]] = []

    def lap_ms(self) -> float:
        now = time.perf_counter()
        ms = (now - self._lap) * 1000
        self._lap = now
        return round(ms, 1)

    def add(self, step: str, *, ms: float | None = None, **fields: Any) -> None:
        if ms is None:
            ms = self.lap_ms()
        else:
            self._lap = time.perf_counter()
        payload: dict[str, Any] = {"step": step, "ms": round(float(ms), 1)}
        payload.update(fields)
        self.steps.append(payload)

    def finish(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "total_ms": round((time.perf_counter() - self._t0) * 1000, 1),
            "steps": self.steps,
        }


def maybe_start_trace() -> RagTrace | None:
    if not settings.RAG_EVAL_DEBUG:
        return None
    return RagTrace(request_id=get_request_id())


def node_identity(node: Any) -> str:
    inner = getattr(node, "node", node)
    for attr in ("node_id", "id_"):
        value = getattr(inner, attr, None) or getattr(node, attr, None)
        if value:
            return str(value)
    text = getattr(node, "text", None) or getattr(inner, "text", "") or ""
    return f"text:{text[:80]}"


def rerank_moved(pre_nodes: list, post_nodes: list) -> list[dict[str, int]]:
    pre_rank = {node_identity(node): rank for rank, node in enumerate(pre_nodes, start=1)}
    moved: list[dict[str, int]] = []
    for rank, node in enumerate(post_nodes, start=1):
        old = pre_rank.get(node_identity(node))
        if old is not None and old != rank:
            moved.append({"from": old, "to": rank})
    return moved


def first_node_score(nodes: list) -> float | None:
    if not nodes:
        return None
    score = getattr(nodes[0], "score", None)
    if score is None:
        return None
    return round(float(score), 4)
