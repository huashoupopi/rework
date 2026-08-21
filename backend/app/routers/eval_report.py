"""评测报告接口。非 superuser 一律 404，不泄露资源是否存在。

2026-08-21 从「只读」扩成「可触发」：原先跑一轮评测只能切终端敲
`uv run python backend/evals/run_rag_eval.py`，页面上只能看历史结果。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.redis import get_arq_redis, get_redis
from app.routers.auth import get_current_user
from app.services import eval_report as eval_report_service
from app.tasks.eval_task import EVAL_STATE_KEY

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

if TYPE_CHECKING:
    from app.models.user import User

router = APIRouter(tags=["评测报告(Evals)"])


def _require_eval_admin(user: User) -> None:
    if not user.is_superuser:
        raise HTTPException(status_code=404, detail="评测报告不存在")


@router.get("/evals")
async def list_evals(current_user: User = Depends(get_current_user)) -> dict:
    _require_eval_admin(current_user)
    return {"items": eval_report_service.list_eval_reports()}


@router.get("/evals/{name}")
async def get_eval(name: str, current_user: User = Depends(get_current_user)) -> dict:
    _require_eval_admin(current_user)
    payload = eval_report_service.get_eval_report(name)
    if payload is None:
        raise HTTPException(status_code=404, detail="评测报告不存在")
    return payload


# ── 触发跑批 ────────────────────────────────────────────────────

EVAL_JOB_ID = "eval30_run"


class EvalRunRequest(BaseModel):
    layers: list[str] | None = Field(default=None, description="只跑这些层，空=全部")
    case_ids: list[str] | None = Field(default=None, description="只跑这些题号，空=全部")
    tag: str | None = Field(default=None, max_length=40, description="写进结果文件名")


@router.get("/evals/meta/layers")
async def list_eval_layers(current_user: User = Depends(get_current_user)) -> dict:
    """给页面的设置面板用：有哪些层、每层多少题。"""
    _require_eval_admin(current_user)
    from evals.case_loader import load_eval_cases

    counts: dict[str, int] = {}
    for case in load_eval_cases():
        counts[case["layer"]] = counts.get(case["layer"], 0) + 1
    return {"layers": [{"name": k, "count": v} for k, v in sorted(counts.items())]}


@router.post("/evals/run", status_code=202)
async def trigger_eval_run(
    payload: EvalRunRequest,
    current_user: User = Depends(get_current_user),
) -> dict:
    _require_eval_admin(current_user)

    arq = get_arq_redis()
    # 固定 job_id 去重：一轮没跑完不允许再开一轮（每题都要打 LLM）
    await arq.delete(f"arq:result:{EVAL_JOB_ID}")
    job = await arq.enqueue_job(
        "run_eval_batch",
        case_ids=payload.case_ids,
        layers=payload.layers,
        tag=payload.tag,
        base_url=settings.EVAL_BASE_URL,
        _job_id=EVAL_JOB_ID,
        # ⚠️ 不重试：worker 全局是 max_tries=3，对评测意味着失败后
        # 自动再烧两遍 LLM 额度并写出多份结果文件。
        _max_tries=1,
        # 36 题 × 每题一次完整问答，全局 600s 不够
        _job_timeout=3600,
    )
    if job is None:
        raise HTTPException(status_code=409, detail="已有一轮评测在跑，等它结束再开")
    return {"job_id": job.job_id, "status": "queued"}


@router.get("/evals/run/status")
async def get_eval_run_status(current_user: User = Depends(get_current_user)) -> dict:
    _require_eval_admin(current_user)
    redis = get_redis()
    raw = await redis.get(EVAL_STATE_KEY)
    if not raw:
        return {"phase": "idle"}
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return {"phase": "idle"}
