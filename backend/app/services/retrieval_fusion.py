"""两路检索融合：拼接去重（基线）与 RRF。不依赖 llama-index。"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from app.services.rag_trace import node_identity

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Sequence

FUSION_CONCAT = "concat"
FUSION_RRF = "rrf"


def concat_dedup(
    dense: Sequence[Any],
    sparse: Sequence[Any],
    id_fn: Callable[[Any], str],
) -> list[Any]:
    """向量结果在前、全文在后，按 id 去重保留先出现的。对齐 PGVectorStore hybrid。"""
    seen: set[str] = set()
    out: list[Any] = []
    for node in list(dense) + list(sparse):
        key = id_fn(node)
        if key in seen:
            continue
        seen.add(key)
        out.append(node)
    return out


def rrf_fuse(
    rankings: Sequence[Sequence[Any]],
    k: int,
    id_fn: Callable[[Any], str],
) -> list[Any]:
    """score(d) = Σ 1/(k + rank_i(d))，两路名次相加后降序。"""
    scores: dict[str, float] = {}
    nodes: dict[str, Any] = {}
    for ranking in rankings:
        for rank, node in enumerate(ranking, start=1):
            key = id_fn(node)
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            if key not in nodes:
                nodes[key] = node
    ordered = sorted(scores, key=lambda key: (-scores[key], key))
    return [nodes[key] for key in ordered]


def fuse_nodes(
    dense: Sequence[Any],
    sparse: Sequence[Any],
    *,
    mode: str,
    rrf_k: int,
    id_fn: Callable[[Any], str] = node_identity,
) -> list[Any]:
    if mode == FUSION_RRF:
        return rrf_fuse((dense, sparse), rrf_k, id_fn)
    if mode == FUSION_CONCAT:
        return concat_dedup(dense, sparse, id_fn)
    raise ValueError(f"unknown fusion mode: {mode}")


async def retrieve_two_path(
    dense: Awaitable[Sequence[Any]],
    sparse: Awaitable[Sequence[Any]],
    fallback: Callable[[], Awaitable[Sequence[Any]]],
    *,
    fusion: str,
    rrf_k: int,
    id_fn: Callable[[Any], str] = node_identity,
) -> tuple[list[Any], str]:
    """两路并发。都空则走纯向量兜底。fallback 是工厂，避免未使用的 coroutine。"""
    dense_nodes, sparse_nodes = await asyncio.gather(dense, sparse)
    if dense_nodes or sparse_nodes:
        fused = fuse_nodes(
            dense_nodes,
            sparse_nodes,
            mode=fusion,
            rrf_k=rrf_k,
            id_fn=id_fn,
        )
        return fused, "hybrid"
    fallback_nodes = await fallback()
    return list(fallback_nodes), "fallback_dense"
