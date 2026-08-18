"""
Redis 连接管理
- 负责 redis 连接池(lifespan初始化/关闭)
- 提供ArqRedis连接实例（入队）
- 提供Redis连接实例 （缓存）
- 提供RedisSettings 解析(Arq Worker也需要)

为什么用连接池：
- 每次操作新建TCP连接 -》 建连耗时 1-3 ms -〉高频操作累积开销大
- 连接池复用已有连接 -》 0开销
- 类比数据库连接池
"""

import logging
from urllib.parse import urlparse

import redis.asyncio as redis
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import settings

logger = logging.getLogger(__name__)

# 全局arq连接（用于入队）
_arq_pool: ArqRedis | None = None
# 全局redis连接（用于缓存等通用操作）
_redis_pool: redis.ConnectionPool | None = None


def parse_redis_settings() -> RedisSettings:
    parsed = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
    )


async def init_redis() -> None:
    global _arq_pool, _redis_pool
    _arq_pool = await create_pool(parse_redis_settings())
    logger.info("Arq Redis pool initialized")

    _redis_pool = redis.ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        decode_responses=True,
    )
    logger.info(
        "Redis connection pool initialized max_connections=%d", settings.REDIS_MAX_CONNECTIONS
    )


async def close_redis() -> None:
    global _arq_pool, _redis_pool

    if _arq_pool:
        await _arq_pool.aclose()
        _arq_pool = None
        logger.info("Arq Redis pool closed")
    if _redis_pool:
        await _redis_pool.aclose()
        _redis_pool = None
        logger.info("Redis connection pool closed")


def get_arq_redis() -> ArqRedis:
    if _arq_pool is None:
        raise RuntimeError("Arq Redis pool not initialized, Please check lifespan")
    return _arq_pool


def get_redis() -> redis.Redis:
    if _redis_pool is None:
        raise RuntimeError("Redis connection pool not initialized, Please check lifespan")
    return redis.Redis(connection_pool=_redis_pool)
