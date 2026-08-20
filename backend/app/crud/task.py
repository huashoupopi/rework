from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.task import Task
from app.schemas.task import TaskPaginationSchema, TaskSchema


async def get_task_by_id(db: AsyncSession, task_id: int) -> Task | None:
    result = await db.get(Task, task_id)
    return result


async def get_tasks_paginated(
    db: AsyncSession,
    user_id: int,
    is_superuser: bool,
    skip: int = 0,
    limit: int = 10,
    status: str | None = None,
    file_name: str | None = None,
) -> TaskPaginationSchema:
    """按状态筛选与统计都在库里做。

    此前筛选只在前端对当前页做，翻页才能找全某状态的任务，
    且完成率之类的指标只按当前页算。status_counts 一次给出全量分布，
    前端无需再自己数。
    """
    scope_stmt = select(Task)
    if not is_superuser:
        scope_stmt = scope_stmt.where(Task.user_id == user_id)

    # 各状态计数不受 status 过滤影响 —— 筛选时也要能看到全貌
    counts_stmt = select(Task.status, func.count(Task.id)).group_by(Task.status)
    if not is_superuser:
        counts_stmt = counts_stmt.where(Task.user_id == user_id)
    counts_result = await db.execute(counts_stmt)
    status_counts = {row[0]: row[1] for row in counts_result.all() if row[0] is not None}

    base_stmt = scope_stmt
    if status:
        base_stmt = base_stmt.where(Task.status == status)
    if file_name:
        # ilike + 转义，避免用户输入的 % _ 变成通配符
        escaped = file_name.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        base_stmt = base_stmt.where(Task.file_name.ilike(f"%{escaped}%", escape="\\"))

    total_stmt = select(func.count()).select_from(base_stmt.subquery())
    total_result = await db.execute(total_stmt)
    total = total_result.scalar_one()

    stmt = (
        base_stmt.options(selectinload(Task.owner))
        .order_by(Task.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    result = (await db.execute(stmt)).scalars().all()
    items = [TaskSchema.model_validate(task) for task in result]

    return TaskPaginationSchema(total=total, items=items, status_counts=status_counts)


"""
subquery()的作用是将一个查询作为子查询嵌入到另一个查询中。在这个例子中，base_stmt.subquery()会生成一个子查询，
计算满足条件的Task记录的总数。然后，外层的select(func.count())会对这个子查询的结果进行计数，得到总记录数total。
这种方式可以避免在主查询中直接使用聚合函数，从而提高查询效率和可读性。
现在这段逻辑其实是两步：
先定义“谁能看到哪些任务”（base_stmt，含权限过滤）。
对这批结果计数（count）。
subquery 就是把第 1 步的结果打包成一个“临时表”，第 2 步直接对这个临时表数行数。
为什么这很有价值（重点）：
防止你以后改了过滤条件，却忘了同步改 count 查询。
当查询变复杂（join/distinct/group by）时，更不容易计数错误。
“列表数据”和“total总数”天然保持一致。
你可以这样理解：
不用 subquery：你要手写两份逻辑（列表一份、count一份），容易不一致。
用 subquery：先写一份逻辑（base_stmt），count 直接复用它，稳定。

"""
