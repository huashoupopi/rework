from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.user import UserPublic

router = APIRouter(tags=["用户管理(User)"])


@router.get("/users/me", response_model=UserPublic)
async def read_users_me(current_user: User = Depends(get_current_user)) -> User | None:
    return current_user


@router.get("/users", response_model=list[UserPublic])
async def read_users(
    skip: int = 0,
    limit: int = 100,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Sequence[User]:
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="权限不足")
    result = await db.execute(select(User).offset(skip).limit(limit))
    return result.scalars().all()


@router.delete("/users/{user_id}", status_code=204)
async def delete_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="权限不足")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="无法删除自己")
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    await db.delete(user)
    await db.commit()
    return None
