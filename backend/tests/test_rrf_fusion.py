"""P2 融合：纯函数 + 假 retriever。不 import rag_service。"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services.retrieval_fusion import (
    concat_dedup,
    fuse_nodes,
    path_overlap_stats,
    retrieve_two_path,
    rrf_fuse,
)


def _n(node_id: str):
    return SimpleNamespace(id_=node_id, text=node_id)


def _id(node) -> str:
    return str(node.id_)


def test_rrf_ranking_prefers_docs_that_rank_well_on_both_lists():
    dense = [_n("A"), _n("B"), _n("C")]
    sparse = [_n("C"), _n("A")]
    fused = rrf_fuse((dense, sparse), k=60, id_fn=_id)
    assert [n.id_ for n in fused] == ["A", "C", "B"]
    # A: 1/61+1/62 > C: 1/63+1/61 > B: 1/62
    score_a = 1 / 61 + 1 / 62
    score_c = 1 / 63 + 1 / 61
    score_b = 1 / 62
    assert score_a > score_c > score_b


def test_rrf_ranking_k_changes_relative_weight_not_membership():
    dense = [_n("A"), _n("B"), _n("C")]
    sparse = [_n("C"), _n("A")]
    k60 = [n.id_ for n in rrf_fuse((dense, sparse), k=60, id_fn=_id)]
    k10 = [n.id_ for n in rrf_fuse((dense, sparse), k=10, id_fn=_id)]
    k100 = [n.id_ for n in rrf_fuse((dense, sparse), k=100, id_fn=_id)]
    assert set(k60) == set(k10) == set(k100) == {"A", "B", "C"}
    assert k60[0] == k10[0] == k100[0] == "A"


def test_concat_dedup_keeps_dense_first():
    dense = [_n("A"), _n("B")]
    sparse = [_n("B"), _n("C")]
    fused = concat_dedup(dense, sparse, _id)
    assert [n.id_ for n in fused] == ["A", "B", "C"]


def test_fuse_nodes_unknown_mode_raises():
    with pytest.raises(ValueError, match="unknown fusion mode"):
        fuse_nodes([_n("A")], [], mode="alpha", rrf_k=60, id_fn=_id)


async def test_two_path_concurrent_not_serial():
    starts: list[float] = []

    async def slow(label: str, delay: float):
        starts.append(time.perf_counter())
        await asyncio.sleep(delay)
        return [_n(label)]

    t0 = time.perf_counter()
    nodes, mode, stats = await retrieve_two_path(
        slow("d", 0.12),
        slow("s", 0.12),
        lambda: slow("fb", 0.01),
        fusion="concat",
        rrf_k=60,
        id_fn=_id,
    )
    elapsed = time.perf_counter() - t0
    assert mode == "hybrid"
    assert [n.id_ for n in nodes] == ["d", "s"]
    assert stats == {"dense": 1, "sparse": 1, "overlap": 0}
    assert elapsed < 0.20
    assert abs(starts[0] - starts[1]) < 0.05


async def test_two_path_fallback_when_both_empty():
    async def empty():
        return []

    async def fallback():
        return [_n("vec")]

    nodes, mode, stats = await retrieve_two_path(
        empty(),
        empty(),
        fallback,
        fusion="rrf",
        rrf_k=60,
        id_fn=_id,
    )
    assert mode == "fallback_dense"
    assert [n.id_ for n in nodes] == ["vec"]
    assert stats == {"dense": 0, "sparse": 0, "overlap": 0}


async def test_two_path_does_not_fallback_when_one_side_hits():
    async def empty():
        return []

    async def sparse():
        return [_n("fts")]

    async def fallback():
        raise AssertionError("fallback must not run")

    nodes, mode, stats = await retrieve_two_path(
        empty(),
        sparse(),
        fallback,
        fusion="concat",
        rrf_k=60,
        id_fn=_id,
    )
    assert mode == "hybrid"
    assert [n.id_ for n in nodes] == ["fts"]
    assert stats == {"dense": 0, "sparse": 1, "overlap": 0}


def test_path_overlap_stats_counts_shared_ids():
    dense = [_n("A"), _n("B"), _n("C")]
    sparse = [_n("B"), _n("C"), _n("D")]
    assert path_overlap_stats(dense, sparse, _id) == {
        "dense": 3,
        "sparse": 3,
        "overlap": 2,
    }


def test_rag_service_does_not_call_private_vector_store_methods():
    src = (
        Path(__file__).resolve().parents[1] / "app" / "services" / "rag_service.py"
    ).read_text(encoding="utf-8")
    assert "_hybrid_query" not in src
    assert "_async_sparse_query_with_rank" not in src
    assert "_sparse_query_with_rank" not in src
    assert 'vector_store_query_mode="sparse"' in src
    assert 'vector_store_query_mode="default"' in src
    assert 'vector_store_query_mode="hybrid"' not in src
    assert "asyncio.gather" not in src
    assert "retrieve_two_path" in src
    assert "dense_retriever.aretrieve(augmented_question)" in src
    assert "sparse_retriever.aretrieve(hybrid_query)" in src
    assert "dense_retriever.aretrieve(hybrid_query)" not in src
