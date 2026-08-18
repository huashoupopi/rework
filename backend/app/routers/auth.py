import hashlib
import logging
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.redis import get_redis
from app.core.security import create_access_token, verify_password
from app.crud.user import create_user, get_user_by_username
from app.models.user import User
from app.schemas.auth import Token, TokenData
from app.schemas.user import UserCreate, UserPublic

logger = logging.getLogger(__name__)
router = APIRouter(tags=["认证(Auth)"])

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")  # 这里注意要加/api


@router.post("/auth/register", response_model=UserPublic)
async def register(user: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
    db_user = await get_user_by_username(db, user.username)
    if db_user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="用户名已存在")
    new_user = await create_user(db, user)
    return new_user


@router.post("/auth/login", response_model=Token)
async def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(), db: AsyncSession = Depends(get_db)
) -> Token:
    user = await get_user_by_username(db, form_data.username)
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
            headers={"WWW-Authenticate": "Bearer"},
        )
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=access_token_expires
    )
    return Token(access_token=access_token, token_type="bearer")


async def get_current_user(
    token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    if await r.get(f"blacklist:{token_hash}"):
        logger.warning("Token在黑名单中，拒绝访问")
        raise credentials_exception
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id: str | None = payload.get("sub")
        user_id_int: int | None = int(user_id) if user_id is not None else None
        if user_id is None:
            raise credentials_exception
        token_data = TokenData(user_id=user_id_int)
    except jwt.InvalidTokenError:
        logger.exception("JWT无效")
        raise credentials_exception from jwt.InvalidTokenError
    # db.get只能按照主键查询
    user = await db.get(User, token_data.user_id)
    if user is None:
        raise credentials_exception
    return user


@router.get("/auth/logout", status_code=204)
async def logout(token: str = Depends(oauth2_scheme)) -> None:
    """
    登出，将当前token加入黑名单 实际要换成Short token + refresh token
    """
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        remaining = int((exp - datetime.now(tz=UTC)).total_seconds())
        if remaining < 0:
            return
    except jwt.InvalidTokenError:
        return

    # 存入redis 黑名单 TTL=token剩余时间
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    await r.set(f"blacklist:{token_hash}", "1", ex=remaining)


"""
- 为什么登录用 OAuth2PasswordRequestForm 而不是 JSON？（OAuth2 规范要求 form-urlencoded）
- get_current_user 的 Depends 链是什么？（oauth2_scheme 取 token → decode → 查 DB → 返回 User）
- 为什么返回 401 要带 WWW-Authenticate header？（HTTP 规范要求，告知客户端认证方式）
"""
