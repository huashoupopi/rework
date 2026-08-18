"""eval30 runner 管线的离线测试。

判分函数的测试在 test_eval_scoring.py，题库冒烟在 test_eval30_cases.py；
这里只测管线零件：流解析、history 取消息、登录、分层汇总。
"""

import asyncio

from evals.run_rag_eval import (
    authenticate,
    build_report,
    extract_assistant_message,
    parse_stream_payload,
)


def test_parse_stream_payload_strips_sources_marker():
    raw = (
        "这是回答正文。"
        "\n<<<SOURCES>>>"
        '[{"id":1,"doc":"manual.pdf","score":0.92,"snippet":"叶片裂纹处理"}]'
        "<<<SOURCES_END>>>"
    )
    assert parse_stream_payload(raw) == "这是回答正文。"


def test_extract_assistant_message_returns_latest_assistant_after_cursor():
    history_items = [
        {"id": 10, "role": "user", "content": "旧问题", "meta": None},
        {"id": 11, "role": "assistant", "content": "旧回答", "meta": {"route": "fallback"}},
        {"id": 12, "role": "user", "content": "新问题", "meta": None},
        {
            "id": 13,
            "role": "assistant",
            "content": "新回答",
            "meta": {"route": "rag", "sources": [{"doc": "doc.md"}]},
        },
    ]

    message = extract_assistant_message(history_items, after_id=11)

    assert message["id"] == 13
    assert message["content"] == "新回答"
    assert message["meta"]["route"] == "rag"


def test_authenticate_posts_oauth_password_grant(monkeypatch):
    class DummyResponse:
        def __init__(self):
            self.status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"access_token": "token-123", "token_type": "bearer"}

    class DummyClient:
        def __init__(self):
            self.calls = []

        async def post(self, url, data=None, headers=None):
            self.calls.append({"url": url, "data": data, "headers": headers})
            return DummyResponse()

    monkeypatch.setenv("RAG_EVAL_USERNAME", "demo_user")
    monkeypatch.setenv("RAG_EVAL_PASSWORD", "demo_pass")
    monkeypatch.delenv("RAG_EVAL_TOKEN", raising=False)

    client = DummyClient()
    token = asyncio.run(authenticate(client, "http://127.0.0.1:8000"))

    assert token == "token-123"
    assert client.calls == [
        {
            "url": "http://127.0.0.1:8000/api/auth/login",
            "data": {
                "grant_type": "password",
                "username": "demo_user",
                "password": "demo_pass",
            },
            "headers": None,
        }
    ]


def test_build_report_aggregates_by_layer_with_retrieval_means():
    results = [
        {
            "case_id": "R01",
            "layer": "retrieval",
            "status": "PASS",
            "scores": {"pass": True, "hit_at_10": 1.0, "hit_at_5": 1.0, "mrr": 1.0},
        },
        {
            "case_id": "R02",
            "layer": "retrieval",
            "status": "FAIL",
            "scores": {"pass": False, "hit_at_10": 1.0, "hit_at_5": 0.5, "mrr": 0.5},
        },
        {"case_id": "RT01", "layer": "routing", "status": "PASS", "scores": {"pass": True}},
        {"case_id": "GR01", "layer": "guardrail", "status": "ERROR", "error": "boom"},
    ]

    report = build_report(results)

    assert report["layers"]["retrieval"] == {
        "total": 2,
        "passed": 1,
        "errors": 0,
        "mean_hit_at_10": 1.0,
        "mean_hit_at_5": 0.75,
        "mean_mrr": 0.75,
    }
    assert report["layers"]["routing"]["passed"] == 1
    assert report["layers"]["guardrail"]["errors"] == 1
    assert report["summary"] == {"total_cases": 4, "passed_cases": 2, "pass_rate": 0.5}
