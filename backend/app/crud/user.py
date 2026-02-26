from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import app.models.user as model
from app.core.security import get_password_hash
from app.schemas.user import UserCreate


async def get_user_by_username(db: AsyncSession, username: str) -> model.User | None:
    smt = select(model.User).where(model.User.username == username)
    result = await db.execute(smt)
    return result.scalars().first()


async def create_user(db: AsyncSession, user_in: UserCreate) -> model.User:
    hashed_password = get_password_hash(user_in.password)
    user = model.User(
        username=user_in.username,
        hashed_password=hashed_password,
        full_name=user_in.full_name,
        is_superuser=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


# scalars.first() 和 scalars.one_or_none()的区别？
# 多条时firsh取第一个，one_or_none抛异常
