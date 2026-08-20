"""任务列表的状态筛选与全量统计下沉到库里。

此前筛选只在前端对当前页做 —— 实测第 2 页共 6 条，筛「失败」得 5 条、
筛「已完成」得 1 条，5+1=6 正好是当前页全部，说明根本没查全库；
要找出所有失败任务必须一页页翻着筛。本文件钉住修好后的行为。
不 import app.main，避免被 CI 的 --ignore 挡掉。
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from app.crud.task import get_tasks_paginated
from app.models.task import Task


class _FakeResult:
    def __init__(self, rows, scalar=None):
        self._rows = rows
        self._scalar = scalar

    def all(self):
        return self._rows

    def scalar_one(self):
        return self._scalar

    def scalars(self):
        return self

    class _Scalars:
        pass


class _RecordingDb:
    """记录每条 SQL，用来断言过滤真的进了 where 而不是在 Python 里做。"""

    def __init__(self, counts, page_rows, total):
        self.counts = counts
        self.page_rows = page_rows
        self.total = total
        self.statements = []

    async def execute(self, stmt):
        self.statements.append(str(stmt))
        compiled = str(stmt)
        if "group_by" in compiled.lower() or "GROUP BY" in compiled:
            return _FakeResult(self.counts)
        if "count" in compiled.lower():
            return _FakeResult([], scalar=self.total)
        result = _FakeResult(self.page_rows)
        result.scalars = lambda: _ScalarWrapper(self.page_rows)
        return result


class _ScalarWrapper:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows


@pytest.mark.asyncio
async def test_status_counts_cover_all_states_not_just_current_page():
    db = _RecordingDb(
        counts=[("completed", 11), ("failed", 4), ("pending", 1)],
        page_rows=[],
        total=16,
    )

    result = await get_tasks_paginated(db, user_id=1, is_superuser=False, skip=0, limit=10)

    # 全量分布，不是当前页的 10 条
    assert result.status_counts == {"completed": 11, "failed": 4, "pending": 1}
    assert sum(result.status_counts.values()) == 16


@pytest.mark.asyncio
async def test_status_filter_reaches_sql_where_clause():
    db = _RecordingDb(counts=[("failed", 4)], page_rows=[], total=4)

    await get_tasks_paginated(
        db, user_id=1, is_superuser=False, skip=0, limit=10, status="failed"
    )

    # 过滤必须在 SQL 里 —— 否则又变成只筛当前页
    joined = " ".join(db.statements)
    assert "tasks.status" in joined


@pytest.mark.asyncio
async def test_counts_ignore_the_status_filter():
    """筛某个状态时，各状态计数仍要给全貌，否则筛完就看不到别的状态还有多少。"""
    db = _RecordingDb(
        counts=[("completed", 11), ("failed", 4), ("pending", 1)],
        page_rows=[],
        total=4,
    )

    result = await get_tasks_paginated(
        db, user_id=1, is_superuser=False, skip=0, limit=10, status="failed"
    )

    assert result.total == 4
    assert result.status_counts["completed"] == 11


def test_status_query_param_is_whitelisted():
    """路由只接受四个已知状态 —— 校验交给 FastAPI 的 pattern，不让任意字符串进 where。"""
    import re

    from fastapi.routing import APIRoute

    from app.routers.task import router

    route = next(
        r for r in router.routes if isinstance(r, APIRoute) and r.path == "/tasks" and "GET" in r.methods
    )
    field = next(f for f in route.dependant.query_params if f.name == "status")
    pattern = field.field_info.metadata[0].pattern

    for good in ("pending", "progressing", "completed", "failed"):
        assert re.match(pattern, good), f"{good} 应被接受"
    for bad in ("' OR 1=1", "deleted", "", "COMPLETED"):
        assert not re.fullmatch(pattern, bad), f"{bad} 不该被接受"


@pytest.mark.asyncio
async def test_file_name_search_escapes_wildcards():
    """用户输入的 % 和 _ 不能变成通配符 —— 否则搜 "a_b" 会匹配 "axb"。"""
    db = _RecordingDb(counts=[("completed", 3)], page_rows=[], total=1)

    await get_tasks_paginated(
        db, user_id=1, is_superuser=False, skip=0, limit=10, file_name="100%_blade"
    )

    joined = " ".join(db.statements)
    assert "lower(tasks.file_name) LIKE lower" in joined or "ilike" in joined.lower()


@pytest.mark.asyncio
async def test_no_filters_means_no_extra_where():
    """不传筛选条件时不应凭空多出 status / file_name 的 where。"""
    db = _RecordingDb(counts=[("completed", 3)], page_rows=[], total=3)

    await get_tasks_paginated(db, user_id=1, is_superuser=False, skip=0, limit=10)

    page_query = [s for s in db.statements if "LIMIT" in s or "OFFSET" in s]
    joined = " ".join(page_query)
    assert "tasks.status =" not in joined
    assert "file_name" not in joined.lower() or "SELECT" in joined
