"""P1 rag_trace。不 import rag_service（CI 收集会拉起 llama-index）。"""

from __future__ import annotations

import time
from pathlib import Path
from types import SimpleNamespace

from app.core.config import settings
from app.services.rag_trace import (
    STEP_NAMES,
    RagTrace,
    maybe_start_trace,
    rerank_moved,
)
from evals.run_rag_eval import print_report

BACKEND = Path(__file__).resolve().parents[1]


def test_disabled_does_not_construct_trace(monkeypatch):
    monkeypatch.setattr(settings, "RAG_EVAL_DEBUG", False)
    calls = {"n": 0}
    original = RagTrace.__init__

    def counting(self, request_id: str) -> None:
        calls["n"] += 1
        original(self, request_id)

    monkeypatch.setattr(RagTrace, "__init__", counting)
    assert maybe_start_trace() is None
    assert calls["n"] == 0


def test_enabled_constructs_trace(monkeypatch):
    monkeypatch.setattr(settings, "RAG_EVAL_DEBUG", True)
    trace = maybe_start_trace()
    assert isinstance(trace, RagTrace)
    payload = trace.finish()
    assert "request_id" in payload
    assert payload["steps"] == []


def test_five_steps():
    trace = RagTrace("req-1")
    for name in STEP_NAMES:
        trace.add(name, extra=name)
    payload = trace.finish()
    assert [step["step"] for step in payload["steps"]] == list(STEP_NAMES)
    assert all("ms" in step for step in payload["steps"])


def test_per_step_ms_not_cumulative():
    trace = RagTrace("req-2")
    time.sleep(0.05)
    trace.add("rewrite")
    time.sleep(0.10)
    trace.add("retrieve")
    time.sleep(0.02)
    trace.add("rerank")
    payload = trace.finish()
    by_name = {step["step"]: step["ms"] for step in payload["steps"]}
    assert 30 <= by_name["rewrite"] <= 90
    assert 70 <= by_name["retrieve"] <= 140
    assert 5 <= by_name["rerank"] <= 50
    # 累计口径会是 rewrite≈50、retrieve≈150、rerank≈170
    assert by_name["rerank"] < by_name["rewrite"]


def test_total_ms_accounted():
    trace = RagTrace("req-3")
    time.sleep(0.03)
    trace.add("rewrite")
    time.sleep(0.04)
    trace.add("retrieve")
    time.sleep(0.02)
    trace.add("rerank")
    time.sleep(0.01)
    trace.add("route")
    time.sleep(0.02)
    trace.add("generate")
    payload = trace.finish()
    summed = sum(step["ms"] for step in payload["steps"])
    assert abs(payload["total_ms"] - summed) < 100
    assert payload["total_ms"] >= summed - 1


def test_retrieval_debug_intact():
    src = (BACKEND / "app" / "services" / "rag_service.py").read_text(encoding="utf-8")
    assert 'result_meta["retrieval_debug"]' in src
    assert '"pre_rerank": build_debug_nodes(pre_rerank_nodes)' in src
    assert '"post_rerank": build_debug_nodes(nodes)' in src
    assert 'result_meta["rag_trace"]' in src
    runner = (BACKEND / "evals" / "run_rag_eval.py").read_text(encoding="utf-8")
    assert 'debug["pre_rerank"]' in runner
    assert 'debug["post_rerank"]' in runner
    assert "score_retrieval" in (BACKEND / "evals" / "scoring.py").read_text(encoding="utf-8")


def test_rerank_moved_only_records_rank_changes():
    pre = [
        SimpleNamespace(id_="a", text="A"),
        SimpleNamespace(id_="b", text="B"),
        SimpleNamespace(id_="c", text="C"),
    ]
    post = [
        SimpleNamespace(id_="b", text="B"),
        SimpleNamespace(id_="a", text="A"),
        SimpleNamespace(id_="c", text="C"),
    ]
    assert rerank_moved(pre, post) == [{"from": 2, "to": 1}, {"from": 1, "to": 2}]


def test_print_report_failure_traces(capsys):
    report = {
        "summary": {"total_cases": 2, "passed_cases": 1, "pass_rate": 0.5},
        "layers": {"retrieval": {"total": 2, "passed": 1, "errors": 0}},
        "results": [
            {"case_id": "R01", "status": "PASS"},
            {
                "case_id": "R02",
                "status": "FAIL",
                "trace": {
                    "request_id": "abc",
                    "total_ms": 12.0,
                    "steps": [{"step": "retrieve", "ms": 8.0, "returned": 1}],
                },
            },
        ],
    }
    print_report(report)
    out = capsys.readouterr().out
    assert "失败归因" in out
    assert "R02" in out
    assert "returned" in out
    assert "R01" not in out.split("失败归因", 1)[1]


def test_print_report_omits_failure_section_when_all_pass(capsys):
    report = {
        "summary": {"total_cases": 1, "passed_cases": 1, "pass_rate": 1.0},
        "layers": {"routing": {"total": 1, "passed": 1, "errors": 0}},
        "results": [{"case_id": "RT01", "status": "PASS"}],
    }
    print_report(report)
    assert "失败归因" not in capsys.readouterr().out
