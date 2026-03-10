# Day 9：Redis + Arq 异步任务队列

> 目标：用 Redis + Arq 替代 BackgroundTasks，实现可靠的异步任务队列
> 预计文件数：4 个新建 + 4 个修改
> 验证工具：Apifox + Redis CLI

---

## 前置准备

Day 9 开始之前确保：
- Day 8 全部通过（后端核心功能完整）
- 安装 Redis：`brew install redis && brew services start redis`
- 验证 Redis 可用：`redis-cli ping` → `PONG`

### 安装依赖

```bash
uv add redis arq
# redis: Python Redis 客户端（支持 async）
# arq: Async Redis Queue（异步任务队列）
```

---

## 为什么要替换 BackgroundTasks？

```
BackgroundTasks 的 5 个致命问题：

问题 1：无持久化
  API 进程重启（代码更新、OOM、崩溃）→ 正在排队的任务全部丢失
  用户上传了图片，等半天没结果

问题 2：无重试
  YOLO 推理偶尔因显存不足失败 → 任务永久 failed
  用户只能手动重新上传

问题 3：共享进程
  BackgroundTasks 在 API 进程内执行
  YOLO 推理 OOM → 整个 API 进程崩溃 → 所有用户断线

问题 4：无并发控制
  10 个用户同时上传 → 10 个 YOLO 推理同时跑 → GPU 过载 → 全部超时

问题 5：无可观测性
  不知道队列里有多少任务、每个任务什么状态、平均耗时多少
```

```
Arq 的解决方案：

解决 1：Redis 持久化
  任务序列化到 Redis → 进程重启后 Worker 继续处理

解决 2：自动重试
  max_tries=3，指数退避 → 偶发失败自动恢复

解决 3：独立 Worker 进程
  uv run arq app.worker.WorkerSettings → 独立进程
  Worker OOM → API 进程不受影响 → Worker 自动重启继续消费

解决 4：max_jobs 限制
  max_jobs=2 → 同时最多 2 个任务 → GPU 不过载

解决 5：任务状态可查
  job.status() → queued / in_progress / complete / not_found
```

**面试话术**：
> "原先用 BackgroundTasks，YOLO 推理和 API 共享进程，一旦 OOM 全部用户断线。
> 改用 Arq + Redis 后实现了三个关键升级：任务持久化不丢失、失败自动重试、进程级故障隔离。
> Worker 独立进程运行，max_jobs=2 限制并发，防止 GPU 过载。"

---

## 整体架构

```
之前（Day 4）：
  客户端 → POST /tasks/upload → API 进程
                                    │
                           BackgroundTasks.add_task()
                                    │
                           同一进程内执行 YOLO 推理
                           (共享内存，OOM 全崩)

之后（Day 9）：
  客户端 → POST /tasks/upload → API 进程
                                    │
                            arq.enqueue_job()
                                    │
                                  Redis
                                    │
                            Arq Worker 进程（独立）
                                    │
                            执行 YOLO 推理
                           (独立内存，OOM 只影响 Worker)
```

```
进程模型：

终端 1：uv run uvicorn app.main:app --port 8000    ← API 进程
终端 2：uv run arq app.worker.WorkerSettings        ← Worker 进程
终端 3：redis-server                                 ← Redis 服务

三个独立进程，互不影响。
```

---

## Step 1：`app/core/config.py` — 新增 Redis 配置

```python
# === Redis 配置 ===
REDIS_URL: str = "redis://localhost:6379/0"
REDIS_MAX_CONNECTIONS: int = 10
```

**你需要回答自己的问题**：

1. **`redis://localhost:6379/0` 中的 `/0` 是什么？**
   - Redis 默认有 16 个数据库（编号 0~15）
   - `/0` 指定使用第 0 号数据库
   - 不同用途可以用不同数据库隔离（如 `/0` 任务队列、`/1` 缓存）
   - **面试点**：Redis 的多数据库是逻辑隔离，不是物理隔离，生产环境建议用不同 Redis 实例

2. **`REDIS_MAX_CONNECTIONS = 10` 够用吗？**
   - 每个并发请求可能需要 1 个 Redis 连接
   - API 进程的并发请求数通常 < 10（因为 RAG 限制了 2 个并发）
   - 10 个连接足够，超出的请求会等待连接释放
   - **追问**：连接池满了怎么办？（等待队列，有超时机制，不会报错而是等待）

---

## Step 2：`app/core/redis.py` — Redis 连接管理

**完整代码**：

```python
"""
Redis 连接管理。

职责：
  - 管理 Redis 连接池（lifespan 中初始化/关闭）
  - 提供 ArqRedis 实例（用于入队任务）
  - 提供普通 Redis 实例（用于缓存等）

为什么用连接池？
  - 每次操作都新建 TCP 连接 → 建连耗时 1-3ms → 高频操作累积开销大
  - 连接池复用已有连接 → 0ms 开销
  - 类比数据库连接池（SQLAlchemy 的 pool_size）
"""

import logging

import redis.asyncio as redis
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import settings

logger = logging.getLogger(__name__)

# 全局 Arq 连接（用于入队任务）
_arq_pool: ArqRedis | None = None

# 全局 Redis 连接池（用于缓存等通用操作）
_redis_pool: redis.ConnectionPool | None = None


def _parse_redis_settings() -> RedisSettings:
    """
    从 REDIS_URL 解析出 Arq 需要的 RedisSettings。

    REDIS_URL 格式：redis://[:password@]host:port/db
    ArqRedis 需要 host, port, database 分开传。
    """
    # redis.asyncio 可以直接用 URL，但 arq 需要 RedisSettings
    from urllib.parse import urlparse
    parsed = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
    )


async def init_redis() -> None:
    """
    初始化 Redis 连接。在 lifespan 中调用。

    创建两个连接：
    1. ArqRedis：专门用于 Arq 任务入队（enqueue_job）
    2. ConnectionPool：通用 Redis 操作（缓存、限流等）
    """
    global _arq_pool, _redis_pool

    # Arq 连接池
    _arq_pool = await create_pool(_parse_redis_settings())
    logger.info("Arq Redis 连接池已创建")

    # 通用 Redis 连接池
    _redis_pool = redis.ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        decode_responses=True,
    )
    logger.info("Redis 通用连接池已创建 max_connections=%d", settings.REDIS_MAX_CONNECTIONS)


async def close_redis() -> None:
    """关闭 Redis 连接。在 lifespan shutdown 中调用。"""
    global _arq_pool, _redis_pool

    if _arq_pool:
        await _arq_pool.aclose()
        _arq_pool = None
        logger.info("Arq Redis 连接已关闭")

    if _redis_pool:
        await _redis_pool.aclose()
        _redis_pool = None
        logger.info("Redis 通用连接池已关闭")


def get_arq_redis() -> ArqRedis:
    """
    获取 Arq Redis 连接（用于入队任务）。

    用法：
      arq = get_arq_redis()
      await arq.enqueue_job("run_yolo_detection", task_id)
    """
    if _arq_pool is None:
        raise RuntimeError("Arq Redis 未初始化，请检查 lifespan")
    return _arq_pool


def get_redis() -> redis.Redis:
    """
    获取通用 Redis 连接（用于缓存等）。

    用法：
      r = get_redis()
      await r.set("key", "value", ex=3600)
      val = await r.get("key")
    """
    if _redis_pool is None:
        raise RuntimeError("Redis 未初始化，请检查 lifespan")
    return redis.Redis(connection_pool=_redis_pool)
```

**你需要回答自己的问题**：

1. **为什么有两个连接（ArqRedis + 普通 Redis）？**
   - `ArqRedis` 是 Arq 封装的 Redis 客户端，有 `enqueue_job`、`job_status` 等方法
   - 普通 `redis.Redis` 用于通用操作（缓存、计数、限流）
   - 两个用途不同，分开管理更清晰
   - **追问**：能不能只用一个？（技术上可以，ArqRedis 继承自 redis.Redis。但语义混乱，不推荐）

2. **`decode_responses=True` 做什么？**
   - Redis 底层存储的是 bytes
   - 不设置 → `await r.get("key")` 返回 `b"value"`，每次要 `.decode("utf-8")`
   - 设置后 → 自动解码为 `str`，返回 `"value"`
   - 只对通用 Redis 设置，Arq 自己管理序列化

3. **连接池什么时候关闭？**
   - 在 lifespan 的 shutdown 阶段（`yield` 之后）调用 `close_redis()`
   - 不关闭 → 连接泄露 → Redis 连接数耗尽 → 新连接被拒绝
   - **面试点**："资源的生命周期要和应用生命周期对齐。lifespan 中 init/close 是标准模式。"

---

## Step 3：`app/tasks/yolo_task.py` — YOLO 异步任务

**完整代码**：

```python
"""
YOLO 推理异步任务 — 由 Arq Worker 进程执行。

注意事项：
  1. Worker 是独立进程，没有 FastAPI 的依赖注入，必须手动管理 Session
  2. 任务函数的第一个参数必须是 ctx（Arq 注入的上下文）
  3. 任务函数必须是 async 的（Arq 基于 asyncio）
  4. 返回值会被序列化到 Redis（用于查询任务结果）
"""

import asyncio
import logging
import time

from app.core.database import AsyncSessionLocal
from app.models.task import Task
from app.services.yolo_service import YOLOService

logger = logging.getLogger(__name__)


async def run_yolo_detection(ctx: dict, task_id: int) -> dict:
    """
    YOLO 推理任务函数。

    Args:
        ctx: Arq 注入的上下文，包含 Redis 连接等。
             ctx["redis"] 可以访问 Redis。
        task_id: 任务 ID

    Returns:
        任务结果 dict（会被序列化到 Redis，可通过 job.result() 查询）

    这个函数和 Day 4 BackgroundTasks 中的逻辑完全相同，
    只是执行环境从 API 进程内 → Worker 独立进程。
    """
    t0 = time.perf_counter()
    logger.info("开始 YOLO 推理 task_id=%d", task_id)

    # Worker 进程没有 FastAPI 的 Depends(get_db)，必须手动创建 Session
    async with AsyncSessionLocal() as db:
        task = await db.get(Task, task_id)
        if not task:
            logger.error("任务不存在 task_id=%d", task_id)
            return {"task_id": task_id, "error": "task_not_found"}

        if task.status == "completed":
            logger.info("任务已完成，跳过 task_id=%d", task_id)
            return {"task_id": task_id, "status": "already_completed"}

        try:
            # YOLO 推理（CPU 密集，放到线程池）
            result = await asyncio.to_thread(
                YOLOService.detect, task.original_image
            )

            task.detect_result = result
            task.status = "completed"
            await db.commit()

            duration_ms = (time.perf_counter() - t0) * 1000
            logger.info(
                "YOLO 推理成功 task_id=%d duration_ms=%.1f detections=%d",
                task_id, duration_ms, result.get("total", 0),
            )

            return {
                "task_id": task_id,
                "status": "completed",
                "detections": result.get("total", 0),
                "duration_ms": round(duration_ms, 1),
            }

        except Exception as exc:
            task.status = "failed"
            await db.commit()

            duration_ms = (time.perf_counter() - t0) * 1000
            logger.exception(
                "YOLO 推理失败 task_id=%d duration_ms=%.1f",
                task_id, duration_ms,
            )

            # 抛出异常 → Arq 会自动重试（如果 retry_jobs=True）
            # 不抛异常 → Arq 认为任务成功完成，不会重试
            raise
```

**你需要回答自己的问题**：

1. **为什么失败时要 `raise` 而不是 `return {"error": ...}`？**
   - Arq 的重试机制基于异常：函数抛异常 → Arq 捕获 → 等待后重试
   - 如果 `return` 错误信息 → Arq 认为任务成功完成 → 不会重试
   - 所以：先把状态写为 `failed`（让用户看到当前状态），再 `raise`（触发 Arq 重试）
   - 重试成功后状态会变为 `completed`
   - **面试点**："区分业务失败和系统失败。任务不存在是业务问题（return），推理异常是系统问题（raise 触发重试）。"

2. **`ctx` 参数有什么用？**
   - Arq 自动注入，包含 `ctx["redis"]`（Redis 连接）和 `ctx["job_id"]`（任务 ID）
   - 可以用 `ctx["redis"]` 做进度更新：
     ```python
     await ctx["redis"].set(f"yolo:progress:{task_id}", "50%")
     ```
   - 当前没用到，但保留参数是 Arq 的要求（第一个参数必须是 ctx）

3. **重试时 `task.status` 已经是 `failed`，重试成功后呢？**
   - 重试时重新执行整个函数 → 重新从数据库读 task
   - `if task.status == "completed"` 跳过（防止重复处理）
   - 重试成功 → status 改为 `completed` → 覆盖之前的 `failed`
   - **追问**：用户在重试期间看到 `failed` 怎么办？（前端可以显示 "检测中，正在重试..."）

4. **Worker 进程怎么加载 YOLO 模型？**
   - Worker 进程 import `YOLOService` 时会加载模型
   - 和 API 进程分别加载一次（各自的进程空间）
   - 模型占用内存约 100-300MB × 2 个进程
   - **追问**：能不能共享？（不能，进程间不共享内存。可以用模型服务化——独立起一个推理服务，API 和 Worker 都调它）

---

## Step 4：`app/worker.py` — Arq Worker 配置

**完整代码**：

```python
"""
Arq Worker 配置 — 独立进程运行。

启动命令：
  uv run arq app.worker.WorkerSettings

Worker 会自动：
  1. 连接 Redis
  2. 监听任务队列
  3. 接收到任务后执行对应函数
  4. 失败时按配置自动重试

注意：Worker 进程和 API 进程完全独立，有各自的内存空间。
"""

import logging

from arq.connections import RedisSettings

from app.core.config import settings
from app.tasks.yolo_task import run_yolo_detection

logger = logging.getLogger(__name__)


def _parse_redis_settings() -> RedisSettings:
    """从 REDIS_URL 解析 Arq 的 RedisSettings。"""
    from urllib.parse import urlparse
    parsed = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
    )


async def on_startup(ctx: dict) -> None:
    """
    Worker 启动时执行。

    类似 FastAPI 的 lifespan startup。
    用于初始化 Worker 进程需要的资源。
    """
    logger.info("Arq Worker 启动...")
    # 如果需要，可以在这里预加载 YOLO 模型
    # YOLOService.load_model()


async def on_shutdown(ctx: dict) -> None:
    """Worker 关闭时执行。清理资源。"""
    logger.info("Arq Worker 关闭")


class WorkerSettings:
    """
    Arq Worker 配置类。

    Arq 通过反射读取这个类的属性来配置 Worker。
    类名必须叫 WorkerSettings（或在启动命令中指定）。
    """

    # 注册的任务函数列表
    # Worker 只执行这里注册的函数，未注册的任务会被忽略
    functions = [run_yolo_detection]

    # Redis 连接配置
    redis_settings = _parse_redis_settings()

    # === 并发控制 ===
    max_jobs = 2
    """
    同时最多执行 2 个任务。

    为什么是 2？
    - YOLO 推理是 CPU/GPU 密集型
    - 并发太高 → GPU 显存不够 / CPU 过载 → 所有任务都变慢
    - 2 个并发 = 1 个在推理、1 个在前处理/后处理，利用率最优
    - 和 RAG 的 Semaphore(2) 同理
    """

    # === 超时控制 ===
    job_timeout = 300  # 单个任务超时 5 分钟
    """
    为什么 5 分钟？
    - YOLO 推理通常 2-30 秒
    - 大图 + 多目标可能更久
    - 留足够余量，但不能无限等（防止卡死的任务永远占着 Worker）
    """

    # === 重试配置 ===
    retry_jobs = True
    max_tries = 3
    """
    失败自动重试，最多 3 次。

    Arq 的重试间隔是指数退避：
      第 1 次重试：等待 ~10 秒
      第 2 次重试：等待 ~30 秒
      第 3 次重试：等待 ~90 秒

    为什么要重试？
    - GPU 显存偶尔被其他进程占用 → OOM → 释放后重试成功
    - 文件系统偶尔 I/O 错误 → 重试通常成功
    - 网络抖动（如果 YOLO 是远程服务）→ 重试成功
    """

    # === 生命周期钩子 ===
    on_startup = on_startup
    on_shutdown = on_shutdown

    # === 定时任务（可选，后续扩展）===
    # cron_jobs = [
    #     cron(cleanup_expired_files, hour=3, minute=0),    # 每天凌晨清理
    #     cron(rebuild_knowledge_index, weekday=0, hour=2),  # 每周一凌晨重建索引
    # ]
```

**你需要回答自己的问题**：

1. **`functions = [run_yolo_detection]` 为什么要显式注册？**
   - 安全考量：只有注册的函数才能被执行
   - 如果不限制 → 攻击者通过 Redis 注入任意函数名 → 远程代码执行
   - **面试安全点**："任务函数白名单注册，防止通过 Redis 注入执行任意代码。"

2. **`max_tries=3` 是总共 3 次还是重试 3 次？**
   - 总共 3 次（1 次初始执行 + 2 次重试）
   - 第 3 次还失败 → 任务标记为永久失败（dead letter）
   - **追问**：永久失败的任务怎么处理？（记录日志 + 告警，人工介入排查）

3. **Worker 进程怎么知道有新任务？**
   - Arq 用 Redis 的 `BLPOP`（阻塞式列表弹出）实现
   - Worker 阻塞等待在 Redis 队列上 → 有新任务时立即唤醒
   - 不是轮询（轮询浪费 CPU），是阻塞等待（事件驱动）
   - **面试点**："Arq 用 Redis BLPOP 实现事件驱动的任务消费，不是轮询。"

4. **`cron_jobs` 定时任务有什么用？**
   - 场景 1：每天凌晨清理 7 天前的临时文件（上传的原始图片）
   - 场景 2：每周重建知识库索引（定期全量更新）
   - 场景 3：每小时清理过期的 Redis 缓存
   - 当前注释掉，后续按需开启

---

## Step 5：改 `app/routers/tasks.py` — 入队替代 BackgroundTasks

### 核心改动

```python
# === 删掉 ===
from fastapi import BackgroundTasks

# === 新增 ===
from app.core.redis import get_arq_redis
```

### 上传接口改动

```python
@router.post("/tasks/upload")
async def upload_task(
    files: list[UploadFile] = File(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    # 删掉：background_tasks: BackgroundTasks,
):
    # ... 保存文件、创建 Task 的逻辑不变 ...

    # === Day 4 的写法（删掉）===
    # background_tasks.add_task(run_yolo_in_background, task.id)

    # === Day 9 的写法（替换）===
    arq = get_arq_redis()
    job = await arq.enqueue_job(
        "run_yolo_detection",   # 任务函数名（必须和 Worker 注册的一致）
        task.id,                # 传给任务函数的参数
        _job_id=f"yolo_{task.id}",  # 自定义 job ID（方便查询状态）
    )
    logger.info(
        "YOLO 任务已入队 task_id=%d job_id=%s",
        task.id, job.job_id,
    )

    return TaskResponse(id=task.id, status="processing")
```

### 可选：添加任务状态查询接口

```python
from arq.jobs import Job

@router.get("/tasks/{task_id}/job-status")
async def get_job_status(
    task_id: int,
    current_user: User = Depends(get_current_user),
) -> dict:
    """
    查询 Arq 任务的执行状态（可选接口）。

    和 GET /tasks/{task_id} 的区别：
    - GET /tasks/{task_id} 查数据库中的 Task 状态（processing/completed/failed）
    - 这个接口查 Redis 中 Arq Job 的状态（queued/in_progress/complete）
    - 两个维度的信息互补

    注意：这个接口主要用于调试，生产环境前端只需要轮询 GET /tasks/{task_id}。
    """
    arq = get_arq_redis()
    job = Job(job_id=f"yolo_{task_id}", redis=arq)
    status = await job.status()
    info = await job.info()

    return {
        "task_id": task_id,
        "job_id": f"yolo_{task_id}",
        "job_status": status.value if status else "unknown",
        "job_result": info.result if info and info.result else None,
    }
```

**你需要回答自己的问题**：

1. **`_job_id=f"yolo_{task_id}"` 为什么要自定义？**
   - 默认 job_id 是随机 UUID → 无法通过 task_id 反查 job 状态
   - 自定义为 `yolo_{task_id}` → 知道 task_id 就能查 job 状态
   - **追问**：如果同一个 task_id 重复入队呢？（Arq 会拒绝重复 job_id，返回 None 而不是 Job 对象。可以先检查再入队）

2. **`enqueue_job` 的第一个参数为什么是字符串？**
   - Arq 入队时只存函数名（字符串）+ 参数到 Redis
   - Worker 进程根据函数名从 `functions` 列表中找到对应函数执行
   - 如果传函数对象 → 无法序列化到 Redis
   - **面试点**："任务入队和执行在不同进程。入队存的是函数名（字符串），Worker 根据名字路由到注册的函数。这就是为什么要显式注册。"

3. **原来的 `run_yolo_in_background` 函数还需要吗？**
   - 不需要了，功能已迁移到 `app/tasks/yolo_task.py` 的 `run_yolo_detection`
   - 如果原来写在 `routers/tasks.py` 里，可以删掉
   - 如果写在 `services/yolo_service.py` 里，保留原始推理逻辑，只删调度相关代码

---

## Step 6：改 `app/main.py` — lifespan 管理 Redis 生命周期

```python
from app.core.redis import init_redis, close_redis

@asynccontextmanager
async def lifespan(app: FastAPI):
    # === startup ===
    setup_logging()
    await init_models()
    YOLOService.load_model()
    await RagService.initialize()
    await init_redis()            # Day 9 新增
    yield
    # === shutdown ===
    await close_redis()           # Day 9 新增
```

**为什么 `close_redis()` 要在 shutdown 中调用？**
- 不关闭 → Redis 连接泄露 → 达到 Redis 的 `maxclients` 限制后新连接被拒绝
- lifespan 的 `yield` 之后就是 shutdown 代码
- **面试点**："lifespan 管理所有外部资源的生命周期：数据库连接池、Redis 连接池、ML 模型。应用退出时按依赖顺序逆序关闭。"

---

## Step 7：Redis 缓存（可选扩展）

Day 9 核心是 Arq 任务队列。以下是 Redis 的额外用途，时间允许可以加：

### 7.1 任务状态缓存（减少 DB 查询）

```python
# 在 yolo_task.py 的 run_yolo_detection 中，完成后写缓存
r = get_redis()
await r.set(
    f"task:status:{task_id}",
    json.dumps({"status": "completed", "total": result.get("total", 0)}),
    ex=3600,  # 1 小时过期
)

# 在 routers/tasks.py 的 get_task 中，先查缓存
r = get_redis()
cached = await r.get(f"task:status:{task_id}")
if cached:
    return json.loads(cached)  # 命中缓存，不查 DB
# 未命中，查 DB...
```

### 7.2 接口限流

```python
async def check_rate_limit(user_id: int, endpoint: str, limit: int = 10, window: int = 60):
    """滑动窗口限流：每个用户每分钟最多 N 次请求"""
    r = get_redis()
    key = f"ratelimit:{user_id}:{endpoint}"
    current = await r.incr(key)
    if current == 1:
        await r.expire(key, window)
    if current > limit:
        raise HTTPException(429, "请求过于频繁，请稍后再试")
```

---

## Day 9 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 确保 Redis 运行
redis-cli ping  # → PONG

# 3. 启动 API（终端 1）
uv run uvicorn app.main:app --reload --port 8000
# 日志应该看到：
# "Arq Redis 连接池已创建"
# "Redis 通用连接池已创建"

# 4. 启动 Worker（终端 2）
uv run arq app.worker.WorkerSettings
# 日志应该看到：
# "Arq Worker 启动..."

# 5. Apifox 验证：

# a) 上传图片
#    POST /api/tasks/upload
#    API 终端日志：YOLO 任务已入队 task_id=1 job_id=yolo_1
#    Worker 终端日志：开始 YOLO 推理 task_id=1 → 推理成功

# b) 轮询任务状态
#    GET /api/tasks/1
#    processing → 几秒后 → completed + 检测结果

# c) 可选：查 Arq Job 状态
#    GET /api/tasks/1/job-status
#    job_status=complete, job_result={...}

# d) 验证重试：
#    把 YOLO 模型路径改错 → 上传图片 → Worker 日志显示失败+重试
#    改回正确路径 → 重启 Worker → 不需要重新上传，Redis 中的任务会被重新消费

# 6. Redis 中查看任务数据
redis-cli
> KEYS arq:*
# 应该能看到 arq:job:yolo_1 等 key
```

---

## 文件写作顺序

```
1. app/core/config.py         <- 改（加 Redis 配置）
2. app/core/redis.py          <- 新建
3. app/tasks/__init__.py      <- 新建（空文件，创建 tasks 包）
4. app/tasks/yolo_task.py     <- 新建
5. app/worker.py              <- 新建
6. app/routers/tasks.py       <- 改（BackgroundTasks → arq.enqueue_job）
7. app/main.py                <- 改（lifespan 加 init_redis/close_redis）
8. uv add redis arq           <- 安装依赖
```

---

## 面试话术（90 秒）

> YOLO 推理原先用 FastAPI 的 BackgroundTasks，有三个致命问题：
> 任务不持久化——API 重启就丢；无重试——失败永久失败；共享进程——OOM 全崩。
>
> 改用 Arq + Redis 后实现了三个升级：
> 任务序列化到 Redis 实现持久化；失败自动重试 3 次，指数退避；
> Worker 独立进程执行推理，进程级故障隔离，Worker OOM 不影响 API 服务。
>
> max_jobs=2 限制同时处理的推理任务数，防止 GPU 过载。
> 任务入队用 enqueue_job 存函数名和参数到 Redis，
> Worker 进程监听队列用 Redis BLPOP 实现事件驱动消费，不是轮询。
>
> 任务函数注册到白名单，防止通过 Redis 注入执行任意代码。
> 后续还能扩展 cron job 做定时清理和定期知识库重建。
