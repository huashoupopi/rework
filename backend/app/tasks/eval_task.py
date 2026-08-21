"""eval30 跑批的 arq 任务。

为什么要有这个：评测原本只能从命令行开
(`uv run python backend/evals/run_rag_eval.py --tag xxx`)，
页面上只能看历史结果，跑一轮得切终端。

⚠️ 这个任务【禁用重试】。worker 的全局配置是 retry_jobs=True / max_tries=3，
对 YOLO、索引重建那种幂等任务是对的，但评测每题都要打一次 LLM ——
失败自动重试三次等于烧三倍额度，而且会写出三份结果文件。
入队时显式传 _max_tries=1，见 routers/eval_report.py。
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# evals 目录不在 app 包里，按路径挂上去（与 CLI 的加载方式一致）
_BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

EVAL_STATE_KEY = "evals:run_state"
EVAL_STATE_TTL_S = 3600


async def _write_state(ctx: dict, payload: dict[str, Any]) -> None:
    redis = ctx.get("redis")
    if not redis:
        return
    import json

    await redis.set(EVAL_STATE_KEY, json.dumps(payload, ensure_ascii=False), ex=EVAL_STATE_TTL_S)


async def run_eval_batch(
    ctx: dict,
    case_ids: list[str] | None = None,
    layers: list[str] | None = None,
    tag: str | None = None,
    base_url: str = "http://localhost:8000",
) -> dict[str, Any]:
    from evals.case_loader import load_eval_cases
    from evals.run_rag_eval import run_eval, save_results

    cases = load_eval_cases(case_ids=case_ids, layers=layers)
    if not cases:
        await _write_state(ctx, {"phase": "failed", "error": "没有匹配的评测用例"})
        return {"error": "没有匹配的评测用例"}

    total = len(cases)
    await _write_state(ctx, {"phase": "running", "done": 0, "total": total, "tag": tag})

    async def on_progress(done: int, count: int, case_id: str, status: str) -> None:
        await _write_state(
            ctx,
            {
                "phase": "running",
                "done": done,
                "total": count,
                "tag": tag,
                "last_case": case_id,
                "last_status": status,
            },
        )

    try:
        payload = await run_eval(cases, base_url=base_url.rstrip("/"), on_progress=on_progress)
        output = save_results(payload, tag=tag)
        summary = payload.get("summary", {})
        await _write_state(
            ctx,
            {
                "phase": "done",
                "done": total,
                "total": total,
                "tag": tag,
                "result_file": output.name,
                "passed": summary.get("passed_cases"),
                "cases": summary.get("total_cases"),
            },
        )
        logger.info("eval30 跑批完成 file=%s", output.name)
        return {"result_file": output.name}
    except Exception as exc:  # noqa: BLE001 - 状态要写回页面，不能让它静默死掉
        logger.exception("eval30 跑批失败")
        await _write_state(ctx, {"phase": "failed", "error": str(exc), "tag": tag})
        raise
