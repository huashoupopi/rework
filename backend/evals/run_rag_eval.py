"""rework eval30 分层评测 runner（36 用例 × 5 层）。

用法:
    cd backend

    # 只验用例加载与物化，不发请求（bench 冒烟同款思路）
    uv run python -m evals.run_rag_eval --dry-run

    # 跑全部评测。⚠️ 后端必须以 RAG_EVAL_DEBUG=1 启动，否则检索层拿不到观测口:
    #   RAG_EVAL_DEBUG=1 uv run uvicorn app.main:app  （或 compose 里加环境变量）
    RAG_EVAL_USERNAME=demo RAG_EVAL_PASSWORD=demo uv run python -m evals.run_rag_eval

    # 只跑某层 / 某题
    ... --layer retrieval --layer routing
    ... --case R07 --case GR05

判分逻辑全部在 evals/scoring.py（纯函数，所有者手写）；本文件只做管线：
发请求 → 从 history meta 取观测值 → 分发给对应层的判分函数 → 分层报告。
"""

import argparse
import asyncio
import json
import os
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx

from evals.case_loader import load_eval_cases, materialize_query
from evals.scoring import (
    score_generation,
    score_guardrail,
    score_multi_turn,
    score_retrieval,
    score_routing,
)

os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

EVALS_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVALS_DIR / "results"

# 与 app.security.GUARDRAIL_RESPONSE 保持一致（不 import app，runner 是纯客户端）
GUARDRAIL_RESPONSE = "抱歉，我无法处理该请求。如有疑问请联系管理员。"

SOURCES_PATTERN = re.compile(r"\n?<<<SOURCES>>>(.*?)<<<SOURCES_END>>>", flags=re.DOTALL)

LAYER_ORDER = ["retrieval", "generation", "guardrail", "multi_turn", "routing"]


def parse_stream_payload(raw_text: str) -> str:
    """剥掉 SOURCES 标记，返回纯答案文本。"""
    return SOURCES_PATTERN.sub("", raw_text).strip()


def extract_assistant_message(
    history_items: list[dict[str, Any]],
    after_id: int | None = None,
) -> dict[str, Any] | None:
    candidates = [
        item
        for item in history_items
        if item.get("role") == "assistant"
        and (after_id is None or int(item.get("id", 0)) > after_id)
    ]
    if not candidates:
        return None
    return max(candidates, key=lambda item: int(item.get("id", 0)))


async def authenticate(client: httpx.AsyncClient, base_url: str) -> str:
    direct_token = os.getenv("RAG_EVAL_TOKEN", "").strip()
    if direct_token:
        return direct_token

    username = os.getenv("RAG_EVAL_USERNAME", "").strip()
    password = os.getenv("RAG_EVAL_PASSWORD", "").strip()
    if not username or not password:
        raise RuntimeError("缺少 RAG_EVAL_TOKEN 或 RAG_EVAL_USERNAME/RAG_EVAL_PASSWORD")

    response = await client.post(
        f"{base_url}/api/auth/login",
        data={"grant_type": "password", "username": username, "password": password},
    )
    response.raise_for_status()
    token = response.json().get("access_token")
    if not token:
        raise RuntimeError("登录成功但未返回 access_token")
    return token


async def make_isolated_token(
    client: httpx.AsyncClient, base_url: str, case_id: str
) -> str:
    """现场注册一次性账号并登录（裁决 J：多轮题会话隔离）。

    会话窗口按 user_id 隔离，新账号历史为空——铺垫问题就是唯一上下文，
    不会被同一场评测里其他题的问答污染（首跑 RW02 把「这个」解析成
    两轮前的腐蚀，就是共用会话的后果）。副作用：users 表每场评测
    多 4 条一次性记录，仅限开发环境使用。
    """
    username = f"eval_{case_id.lower()}_{uuid.uuid4().hex[:8]}"
    password = f"Eval-{uuid.uuid4().hex[:16]}"
    response = await client.post(
        f"{base_url}/api/auth/register",
        json={"username": username, "password": password},
    )
    response.raise_for_status()

    response = await client.post(
        f"{base_url}/api/auth/login",
        data={"grant_type": "password", "username": username, "password": password},
    )
    response.raise_for_status()
    return response.json()["access_token"]


async def fetch_history(
    client: httpx.AsyncClient,
    base_url: str,
    token: str,
    *,
    limit: int = 20,
    order: str = "desc",
    after: int | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {"limit": limit, "order": order}
    if after is not None:
        params["after"] = after
    response = await client.get(
        f"{base_url}/api/chat/history",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
    )
    response.raise_for_status()
    return response.json()


async def send_chat(
    client: httpx.AsyncClient,
    base_url: str,
    token: str,
    question: str,
) -> tuple[str, dict[str, Any], float]:
    """发一问，等流式收完，从 history 取回 (answer, meta, elapsed_ms)。"""
    before = await fetch_history(client, base_url, token, limit=1, order="desc")
    cursor = before.get("newest_id")

    started_at = time.perf_counter()
    response = await client.post(
        f"{base_url}/api/chat/stream",
        data={"question": question},
        headers={"Authorization": f"Bearer {token}"},
        timeout=float(os.getenv("RAG_EVAL_TIMEOUT_S", "180")),
    )
    response.raise_for_status()
    elapsed_ms = (time.perf_counter() - started_at) * 1000

    after_history = await fetch_history(
        client, base_url, token, limit=20, order="asc", after=cursor
    )
    message = extract_assistant_message(after_history.get("items", []), after_id=cursor)
    if not message:
        raise RuntimeError(f"未找到 assistant 消息（question={question[:40]!r}）")

    answer = message.get("content") or parse_stream_payload(response.text)
    meta = message.get("meta") or {}
    return answer, meta, elapsed_ms


def dispatch_score(case: dict[str, Any], answer: str, meta: dict[str, Any]) -> dict[str, Any]:
    """按层分发到判分函数。观测值缺失时 fail loud，不折算成正常判挂。"""
    layer = case["layer"]
    if layer == "routing":
        return score_routing(case, meta.get("route", "unknown"))
    if layer == "guardrail":
        blocked = (
            meta.get("finish_reason") == "guardrail_blocked"
            or answer.strip() == GUARDRAIL_RESPONSE
        )
        return score_guardrail(case, blocked)
    if layer == "generation":
        return score_generation(case, answer)
    if layer == "multi_turn":
        # 后端把「实际用于检索的 query」写进 meta；缺席 = 改写链路整个没跑，
        # 用原句判（自然挂）——观测现实，不美化
        rewritten = meta.get("rewritten_query") or case["query"]
        return score_multi_turn(case, rewritten)
    if layer == "retrieval":
        debug = meta.get("retrieval_debug")
        if not debug:
            raise RuntimeError(
                f"{case['id']}: meta 里没有 retrieval_debug——后端须以 RAG_EVAL_DEBUG=1 启动"
            )
        return score_retrieval(
            case,
            pre_chunks=[n["text"] for n in debug["pre_rerank"]],
            post_chunks=[n["text"] for n in debug["post_rerank"]],
        )
    raise ValueError(f"未知 layer: {layer}")


async def run_case(
    client: httpx.AsyncClient,
    base_url: str,
    token: str,
    case: dict[str, Any],
) -> dict[str, Any]:
    # 多轮题：换一次性账号（窗口隔离），先发铺垫问题占住窗口（结果不判分）
    if case["layer"] == "multi_turn":
        token = await make_isolated_token(client, base_url, case["id"])
        await send_chat(client, base_url, token, case["expect"]["prior"])

    query = materialize_query(case)
    answer, meta, elapsed_ms = await send_chat(client, base_url, token, query)
    scores = dispatch_score(case, answer, meta)

    row: dict[str, Any] = {
        "case_id": case["id"],
        "layer": case["layer"],
        "status": "PASS" if scores["pass"] else "FAIL",
        "elapsed_ms": round(elapsed_ms, 1),
        "scores": scores,
        "route": meta.get("route"),
        "answer_preview": answer[:160],
    }
    if meta.get("rag_trace"):
        row["trace"] = meta["rag_trace"]
    return row


def build_report(results: list[dict[str, Any]]) -> dict[str, Any]:
    """分层汇总：每层 通过数/总数；检索层附 hit@10 / hit@5 / MRR 均值。"""
    layers: dict[str, dict[str, Any]] = {}
    for layer in LAYER_ORDER:
        rows = [r for r in results if r.get("layer") == layer]
        if not rows:
            continue
        scored = [r for r in rows if r["status"] in ("PASS", "FAIL")]
        entry: dict[str, Any] = {
            "total": len(rows),
            "passed": sum(1 for r in rows if r["status"] == "PASS"),
            "errors": sum(1 for r in rows if r["status"] == "ERROR"),
        }
        if layer == "retrieval" and scored:
            for metric in ("hit_at_10", "hit_at_5", "mrr"):
                values = [r["scores"][metric] for r in scored]
                entry[f"mean_{metric}"] = round(sum(values) / len(values), 3)
        layers[layer] = entry

    total = len(results)
    passed = sum(1 for r in results if r["status"] == "PASS")
    return {
        "summary": {
            "total_cases": total,
            "passed_cases": passed,
            "pass_rate": round(passed / total, 2) if total else 0.0,
        },
        "layers": layers,
    }


def print_report(report: dict[str, Any]) -> None:
    print("=" * 64)
    print("分层基线表")
    header = f"{'层':<12} {'通过':>8}"
    print(f"{header}   （检索层附 hit@10 / hit@5 / MRR）")
    for layer, entry in report["layers"].items():
        line = f"{layer:<12} {entry['passed']:>4}/{entry['total']}"
        if entry.get("errors"):
            line += f"  ERROR×{entry['errors']}"
        if "mean_hit_at_10" in entry:
            line += (
                f"   hit@10={entry['mean_hit_at_10']}"
                f"  hit@5={entry['mean_hit_at_5']}"
                f"  MRR={entry['mean_mrr']}"
            )
        print(line)
    summary = report["summary"]
    print("-" * 64)
    print(f"总计: {summary['passed_cases']}/{summary['total_cases']} ({summary['pass_rate']:.0%})")
    _print_failure_traces(report.get("results") or [])


def _print_failure_traces(results: list[dict[str, Any]]) -> None:
    failed = [row for row in results if row.get("status") != "PASS"]
    if not failed:
        return
    print("=" * 64)
    print("失败归因")
    for row in failed:
        case_id = row.get("case_id", "?")
        trace = row.get("trace")
        if not trace:
            print(f"  {case_id}: 无 trace")
            continue
        print(f"  {case_id}: total_ms={trace.get('total_ms')} request_id={trace.get('request_id')}")
        for step in trace.get("steps") or []:
            name = step.get("step")
            extra = {k: v for k, v in step.items() if k not in ("step",)}
            print(f"    {name}: {extra}")


async def run_eval(cases: list[dict[str, Any]], base_url: str) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        token = await authenticate(client, base_url)
        results: list[dict[str, Any]] = []
        for index, case in enumerate(cases, start=1):
            label = f"[{index}/{len(cases)}] {case['id']} ({case['layer']})"
            try:
                result = await run_case(client, base_url, token, case)
                detail = "" if result["status"] == "PASS" else f"  scores={result['scores']}"
                print(f"{label} {result['status']}{detail}")
            except Exception as exc:
                result = {
                    "case_id": case["id"],
                    "layer": case["layer"],
                    "status": "ERROR",
                    "error": str(exc),
                }
                print(f"{label} ERROR: {exc}")
            results.append(result)

    report = build_report(results)
    return {**report, "results": results}


def save_results(payload: dict[str, Any], tag: str | None = None) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = ""
    if tag:
        safe = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in tag)
        suffix = f"_{safe}"
    output = RESULTS_DIR / f"eval30_{timestamp}{suffix}.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="运行 rework eval30 分层评测")
    parser.add_argument("--case", action="append", dest="case_ids", help="只跑指定 case，可重复")
    parser.add_argument("--layer", action="append", dest="layers", help="只跑指定层，可重复")
    parser.add_argument("--dry-run", action="store_true", help="只验用例加载与物化，不发请求")
    parser.add_argument("--tag", default=None, help="写入结果文件名，如 p1-after")
    parser.add_argument(
        "--base-url",
        default=os.getenv("RAG_EVAL_BASE_URL", "http://localhost:8000"),
        help="后端服务地址，默认 http://localhost:8000",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cases = load_eval_cases(case_ids=args.case_ids, layers=args.layers)
    if not cases:
        raise SystemExit("没有匹配的评测用例")

    if args.dry_run:
        by_layer: dict[str, int] = {}
        for case in cases:
            by_layer[case["layer"]] = by_layer.get(case["layer"], 0) + 1
            query = materialize_query(case)  # 物化本身就是校验（query_special 坏了当场炸）
            print(f"- {case['id']:<5} {case['layer']:<11} len={len(query)}")
        print(f"cases={len(cases)} by_layer={by_layer}")
        return

    payload = asyncio.run(run_eval(cases, base_url=args.base_url.rstrip("/")))
    print_report(payload)
    output = save_results(payload, tag=args.tag)
    print(f"结果文件: {output}")


if __name__ == "__main__":
    main()
