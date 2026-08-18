"""
API限流 固定窗口算法
"""

import logging

from fastapi import HTTPException

from app.core.redis import get_redis

logger = logging.getLogger(__name__)


async def rate_limit(user_id: int, endpoint: str, limit: int = 10, window: int = 60) -> None:
    """
    固定窗口算法实现API限流
    Args:
        user_id: 用户ID
        endpoint: API端点如("upload" "chat")用于区分不同接口的限流
        limit: 每个窗口允许的最大请求数
        window: 窗口大小（秒）
    """
    r = get_redis()
    key = f"ratelimit:{user_id}:{endpoint}"

    # INCR命令是原子操作， 如果Key不存在则创建并设置为1， 如果存在则增加1
    current = await r.incr(key)
    if current == 1:
        await r.expire(key, window)  # 设置过期时间，窗口结束后自动重置计数

    if current > limit:
        logger.warning("限流触发 user_id=%d endpoint=%s count=%d", user_id, endpoint, current)
        raise HTTPException(status_code=429, detail=f"请求过于频繁，请{window} 秒后再试")



