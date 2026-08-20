"""评测报告只读接口。非 superuser 404，不泄露资源是否存在。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, HTTPException

from app.routers.auth import get_current_user
from app.services import eval_report as eval_report_service

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
