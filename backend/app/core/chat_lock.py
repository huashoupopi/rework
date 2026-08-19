"""聊天请求锁：唯一 token + Lua compare-and-delete。

TTL = RAG_STREAM_TOTAL_TIMEOUT_S + 60。本轮不做续租。
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from app.core.config import settings

if TYPE_CHECKING:
    from redis.asyncio import Redis

_RELEASE_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


def chat_lock_key(user_id: int) -> str:
    return f"lock:chat:{user_id}"


def chat_lock_ttl_s() -> int:
    return int(settings.RAG_STREAM_TOTAL_TIMEOUT_S) + 60


async def acquire_chat_lock(redis: Redis, user_id: int) -> str | None:
    """SET NX。成功返回本请求 token，失败返回 None。"""
    token = uuid.uuid4().hex
    ok = await redis.set(chat_lock_key(user_id), token, ex=chat_lock_ttl_s(), nx=True)
    if not ok:
        return None
    return token


async def release_chat_lock(redis: Redis, user_id: int, token: str) -> bool:
    """只删自己的锁。token 对不上返回 False，不碰别人的锁。"""
    if not token:
        return False
    deleted = await redis.eval(_RELEASE_LUA, 1, chat_lock_key(user_id), token)
    return bool(deleted)
