"""2.4 聊天锁：唯一 token + Lua CAD + TTL + 流式释放。

直连 Redis，不 import app.main / RagService / routers.chat。
"""

from __future__ import annotations

import asyncio

import pytest
import redis.asyncio as redis

from app.core.chat_lock import (
    acquire_chat_lock,
    chat_lock_key,
    chat_lock_ttl_s,
    release_chat_lock,
)
from app.core.config import settings

pytestmark = pytest.mark.needs_db


@pytest.fixture
async def r():
    client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    await client.ping()
    yield client
    await client.aclose()


@pytest.fixture
def user_id():
    return 8_100_000 + (id(object()) % 90_000)


@pytest.fixture(autouse=True)
async def _cleanup_lock(r, user_id):
    yield
    await r.delete(chat_lock_key(user_id))


async def test_two_concurrent_acquires_only_one_wins(r, user_id):
    order: list[tuple[str, str | None]] = []

    async def attempt(name: str) -> str | None:
        token = await acquire_chat_lock(r, user_id)
        order.append((name, token))
        return token

    first, second = await asyncio.gather(attempt("A"), attempt("B"))
    winners = [token for token in (first, second) if token]
    losers = [name for name, token in order if token is None]
    assert len(winners) == 1
    assert len(losers) == 1
    assert await r.get(chat_lock_key(user_id)) == winners[0]


async def test_old_token_cannot_delete_new_lock(r, user_id):
    old = await acquire_chat_lock(r, user_id)
    assert old
    # 模拟 TTL 过期后第二条请求写入新 token
    new_token = "new-request-token"
    await r.set(chat_lock_key(user_id), new_token, ex=chat_lock_ttl_s())
    deleted = await release_chat_lock(r, user_id, old)
    assert deleted is False
    assert await r.get(chat_lock_key(user_id)) == new_token


async def test_lock_ttl_is_stream_timeout_plus_60(r, user_id):
    token = await acquire_chat_lock(r, user_id)
    assert token
    ttl = await r.ttl(chat_lock_key(user_id))
    expected = chat_lock_ttl_s()
    assert expected == int(settings.RAG_STREAM_TOTAL_TIMEOUT_S) + 60
    assert expected - 5 <= ttl <= expected


async def test_prepare_exception_releases_lock(r, user_id):
    token = await acquire_chat_lock(r, user_id)
    assert token
    try:
        try:
            raise RuntimeError("prepare failed")
        except BaseException:
            await release_chat_lock(r, user_id, token)
            raise
    except RuntimeError:
        pass
    assert await r.get(chat_lock_key(user_id)) is None


async def test_stream_success_releases_in_generator_finally(r, user_id):
    token = await acquire_chat_lock(r, user_id)
    assert await r.get(chat_lock_key(user_id)) == token

    async def event_generator():
        try:
            yield "chunk"
        finally:
            await release_chat_lock(r, user_id, token)

    chunks = [chunk async for chunk in event_generator()]
    assert chunks == ["chunk"]
    assert await r.get(chat_lock_key(user_id)) is None


async def test_stream_error_releases_in_generator_finally(r, user_id):
    token = await acquire_chat_lock(r, user_id)

    async def event_generator():
        try:
            yield "partial"
            raise RuntimeError("stream exploded")
        finally:
            await release_chat_lock(r, user_id, token)

    gen = event_generator()
    assert await gen.__anext__() == "partial"
    with pytest.raises(RuntimeError, match="stream exploded"):
        await gen.__anext__()
    assert await r.get(chat_lock_key(user_id)) is None


async def test_route_outer_finally_must_not_wrap_streaming_return(r, user_id):
    """对照：若在 return StreamingResponse 外包 finally，锁会在流开始前被丢掉。"""
    released_before_stream = False

    async def bad_route():
        nonlocal released_before_stream
        token = await acquire_chat_lock(r, user_id)

        async def event_generator():
            yield "too-late"

        try:
            return event_generator()
        finally:
            await release_chat_lock(r, user_id, token)
            released_before_stream = True

    gen = await bad_route()
    assert released_before_stream is True
    assert await r.get(chat_lock_key(user_id)) is None
    assert [chunk async for chunk in gen] == ["too-late"]
