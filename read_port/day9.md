# Day 9：Redis + Arq 异步任务队列

> 目标：学习 Redis 基础 + 用 Arq 替代 BackgroundTasks，实现可靠的异步任务队列
> 预计文件数：4 个新建 + 3 个修改
> 验证工具：Apifox + Redis CLI

---

## 前置准备

Day 9 开始之前确保：
- Day 8 全部通过（后端核心功能完整）
- 已安装 OrbStack（或 Docker Desktop）

### 启动 Redis（Docker）

```bash
# 创建数据目录（宿主机持久化）
mkdir -p ~/.docker-data/redis

# 启动 Redis 容器
docker run -d \
  --name redis \
  -p 6379:6379 \
  -v ~/.docker-data/redis:/data \
  --restart unless-stopped \
  redis:7-alpine \
  redis-server \
    --appendonly yes \
    --requirepass changeme_dev

# 验证 Redis 可用
docker exec redis redis-cli -a changeme_dev ping
# → PONG
```

**逐行解释每个参数（架构决策）**：

```
-d                              后台运行
--name redis                    容器名，方便 docker stop/start/exec
-p 6379:6379                    端口映射，Python 代码通过 localhost:6379 连接
-v ~/.docker-data/redis:/data   数据卷挂载（关键！）
--restart unless-stopped        容器异常退出或机器重启后自动恢复
redis:7-alpine                  镜像版本（alpine = 最小体积，~30MB）
redis-server                    容器内启动命令
  --appendonly yes               开启 AOF 持久化
  --requirepass changeme_dev     设置密码

为什么每个参数都不能少？

  -v（数据卷）不挂载会怎样？
    容器内数据存在容器的临时文件系统中
    docker rm redis → 数据全部丢失 → 正在排队的任务消失
    挂载后 → 数据写到宿主机 ~/.docker-data/redis → 容器删了重建数据还在

  --appendonly yes（AOF）不开会怎样？
    默认只有 RDB 快照（每几分钟一次）
    Redis 崩溃 → 最近几分钟的任务入队操作丢失
    AOF 模式 → 每条写命令都追加到日志文件 → 最多丢 1 秒数据
    任务队列场景必须开 AOF，任务不能丢

  --requirepass 不设会怎样？
    端口 6379 裸露 → 局域网内任何人可以连接
    攻击者可以 FLUSHALL 清空所有数据
    可以写入恶意 cron job（Redis 未授权访问是 CVE 高频漏洞）
    即使是开发环境也要养成设密码的习惯

  --restart unless-stopped 不加会怎样？
    机器重启 → Redis 容器不会自动启动 → API 连不上 Redis → 所有任务入队失败
    加了之后 → 重启后 Docker 自动恢复容器 → 服务自愈
```

**为什么用 Docker 而不是 `brew install redis`？**

```
brew install 的问题：
  1. 污染本机环境 — Redis 常驻后台，开机自启，占内存
  2. 版本管理难 — 多项目需要不同 Redis 版本时冲突
  3. 和生产不一致 — 生产用 Docker/K8s，开发用 brew → 环境差异
  4. 持久化配置散落 — 需要手动编辑 redis.conf，不同机器不一致

Docker 的好处：
  1. 隔离 — 容器内运行，不影响本机
  2. 一行启停 — docker stop redis / docker start redis
  3. 版本精确 — redis:7-alpine 固定版本，和生产一致
  4. 配置即代码 — 所有参数在启动命令中，团队成员复制即可
  5. 数据可控 — -v 挂载指定目录，清理干净不留垃圾
```

> OrbStack 是 macOS 上的 Docker Desktop 替代品，更轻量更快。
> 如果你用的是 OrbStack，上面的 `docker` 命令完全通用，不需要改。

### 连接 Redis CLI（通过 Docker）

```bash
# 进入容器内的 redis-cli（后续 Part 1 练习都用这个）
docker exec -it redis redis-cli -a changeme_dev
# -a 指定密码，否则执行命令会报 NOAUTH 错误
```

### 安装 Python 依赖

```bash
uv add redis arq
# redis: Python Redis 客户端（支持 async）
# arq: Async Redis Queue（异步任务队列）
```

---

## Part 1：Redis 基础知识

> 在写代码之前，先搞懂 Redis 是什么、能干什么。
> 这部分全程用 `redis-cli` 手动操作，建立直觉。

### 1.1 Redis 是什么？

```
Redis = Remote Dictionary Server（远程字典服务）

核心特性：
  1. 内存存储 — 数据存在内存里，读写速度极快（~100ns，比数据库快 100 倍）
  2. 键值对结构 — 像 Python 的 dict，key → value
  3. 丰富的数据类型 — 不只是字符串，还有列表、哈希、集合等
  4. 持久化 — 虽然在内存，但可以定期写磁盘，重启不丢数据
  5. 单线程 — 所有操作原子性执行，天然线程安全

类比：
  PostgreSQL = 硬盘上的关系型仓库（容量大，查询慢）
  Redis      = 内存中的高速缓存柜（容量小，读写快）

常见用途：
  - 缓存（减少数据库查询）
  - 会话存储（用户登录状态）
  - 任务队列（Arq、Celery 的后端）
  - 计数器和限流（接口调用频率限制）
  - 排行榜（有序集合）
```

### 1.2 Redis 五大数据类型

打开终端，运行 `docker exec -it redis redis-cli -a changeme_dev` 进入 Redis 交互界面，跟着操作：

**String（字符串）— 最基础的类型**

```bash
# 设置键值对
SET name "WindSlice"
# 获取值
GET name
# → "WindSlice"

# 设置带过期时间的键（60 秒后自动删除）
SET token "abc123" EX 60
# 查看剩余生存时间
TTL token
# → 59（秒）

# 计数器（原子操作，天然线程安全）
SET visit_count 0
INCR visit_count
INCR visit_count
GET visit_count
# → "2"
```

**你需要回答自己的问题**：

1. **为什么 `INCR` 是原子操作很重要？**
   - 两个请求同时 `INCR` 同一个 key → Redis 单线程串行执行 → 结果一定是 +2
   - 如果用数据库 `UPDATE count = count + 1`，两个并发请求可能只加了 1（丢失更新）
   - **面试点**："Redis 单线程模型保证所有操作原子性，适合计数器、限流等并发场景。"

2. **`EX 60` 和 `TTL` 有什么用？**
   - `EX` = 设置过期时间，到期后 Redis 自动删除这个 key
   - 缓存场景：缓存用户信息 1 小时 → `SET user:1 "{...}" EX 3600`
   - 不设过期 → 缓存永不更新 → 数据库改了但缓存还是旧的 → 脏数据
   - **面试点**："缓存必须设 TTL。没有 TTL 的缓存就是内存泄露。"

**List（列表）— 任务队列的基础**

```bash
# 从右边推入元素
RPUSH tasks "task_1"
RPUSH tasks "task_2"
RPUSH tasks "task_3"

# 查看列表所有元素
LRANGE tasks 0 -1
# → 1) "task_1"  2) "task_2"  3) "task_3"

# 从左边弹出（先进先出 = 队列）
LPOP tasks
# → "task_1"

# 阻塞式弹出（队列为空时等待，直到有新元素）
# 在另一个终端窗口运行：
BLPOP tasks 30
# 等待 30 秒，如果有新元素立即返回
```

**你需要回答自己的问题**：

1. **`RPUSH` + `LPOP` 为什么是队列？**
   - `RPUSH`：从右边推入（入队）
   - `LPOP`：从左边弹出（出队）
   - 先推入的先弹出 → FIFO（先进先出）= 队列
   - **这就是 Arq 的核心原理**：API 用 `RPUSH` 把任务推入 Redis 列表，Worker 用 `BLPOP` 从列表中取出执行

2. **`BLPOP` 和 `LPOP` 的区别？**
   - `LPOP`：列表为空时返回 nil → Worker 需要不断轮询（浪费 CPU）
   - `BLPOP`：列表为空时阻塞等待 → 有新元素时立即唤醒（事件驱动，零 CPU 开销）
   - **面试点**："Arq 用 Redis BLPOP 实现事件驱动的任务消费，不是轮询。"

**Hash（哈希）— 存储结构化数据**

```bash
# 存储一个任务的信息
HSET task:1 status "completed" total 5 duration_ms 230

# 获取单个字段
HGET task:1 status
# → "completed"

# 获取所有字段
HGETALL task:1
# → 1) "status"  2) "completed"  3) "total"  4) "5"  5) "duration_ms"  6) "230"
```

**你需要回答自己的问题**：

1. **Hash 和 String 存 JSON 有什么区别？**
   - String 存 JSON：`SET task:1 '{"status":"completed","total":5}'`
     - 读取单个字段需要：GET → 反序列化 → 取字段 → 序列化 → SET（全量读写）
   - Hash 存结构化数据：`HSET task:1 status completed total 5`
     - 读取单个字段：`HGET task:1 status`（局部读写，更高效）
   - **面试点**："结构化数据用 Hash 比 String+JSON 更高效，支持字段级读写。Arq 内部就用 Hash 存储 Job 元数据。"

**Set（集合）和 Sorted Set（有序集合）— 简单了解**

```bash
# Set：去重集合
SADD online_users "user_1" "user_2" "user_1"
SMEMBERS online_users
# → 1) "user_1"  2) "user_2"  （自动去重）

# Sorted Set：带分数的有序集合（排行榜）
ZADD leaderboard 95 "user_a" 87 "user_b" 99 "user_c"
ZREVRANGE leaderboard 0 -1 WITHSCORES
# → user_c(99), user_a(95), user_b(87)  按分数倒序
```

### 1.3 Redis 持久化

```
Redis 数据在内存中，断电怎么办？两种持久化机制：

RDB（快照）：
  - 定期把内存数据写到磁盘（dump.rdb）
  - 类比：每隔 5 分钟对整个冰箱拍一张照片
  - 优点：恢复快，文件紧凑
  - 缺点：最近一次快照之后的数据可能丢失（默认间隔 5 分钟）

AOF（追加日志）：
  - 每条写命令追加到日志文件（appendonly.aof）
  - 类比：每次往冰箱放东西都记一笔账
  - 优点：数据几乎不丢（默认每秒同步一次，最多丢 1 秒）
  - 缺点：文件大，恢复慢

我们的配置：
  - Docker 启动时用 --appendonly yes 开启了 AOF
  - -v 挂载确保持久化文件写到宿主机磁盘
  - Redis 默认同时保留 RDB，所以我们实际是 RDB + AOF 双开

为什么任务队列必须开 AOF？
  - 只有 RDB → Redis 崩溃 → 最近 5 分钟的 enqueue_job 丢失
  - 用户上传了图片，任务入了队，Redis 崩了 → 任务消失 → 用户等不到结果
  - 开了 AOF → 最多丢 1 秒 → 可接受
  - 面试点："有状态服务（Redis、数据库）必须保证持久化。任务队列丢任务
    等于对用户承诺了但没兑现，比直接报错更糟糕。"
```

### 1.4 常用管理命令

```bash
# 查看所有 key（开发环境用，生产环境禁用——key 太多会卡死）
KEYS *

# 按模式匹配查找 key
KEYS task:*

# 删除 key
DEL task:1

# 查看 key 的类型
TYPE tasks
# → list

# 查看 Redis 信息
INFO memory
# → used_memory_human: 1.2M（当前内存使用）

# 清空当前数据库（开发环境调试用）
FLUSHDB

# 退出 redis-cli
QUIT
```

**你需要回答自己的问题**：

1. **为什么生产环境不能用 `KEYS *`？**
   - `KEYS` 会遍历所有 key，时间复杂度 O(n)
   - 如果有 100 万个 key → 阻塞 Redis 主线程数秒 → 所有请求超时
   - 生产环境用 `SCAN` 命令代替（游标迭代，不阻塞）
   - **面试点**："Redis 单线程，一个慢命令会阻塞所有请求。KEYS 是最典型的生产禁用命令。"

2. **Redis 的 `/0` 多数据库隔离是怎么回事？**
   - Redis 默认有 16 个数据库（编号 0~15）
   - `redis://localhost:6379/0` 的 `/0` 指定使用第 0 号数据库
   - 不同用途可以用不同数据库隔离（如 `/0` 任务队列、`/1` 缓存）
   - **面试点**：Redis 多数据库是逻辑隔离，共享同一个 Redis 实例的内存和 CPU。生产环境建议用不同 Redis 实例做物理隔离

---

## Part 2：任务队列概念

> 在写 Arq 代码之前，先理解"任务队列"这个模式。

```
什么是任务队列？

生活类比：餐厅的出餐模式

  同步模式（BackgroundTasks）：
    顾客点单 → 厨师当场做 → 做完端上来 → 顾客才能走
    如果厨师晕倒 → 整个餐厅停业

  异步模式（Arq）：
    顾客点单 → 写到订单纸上 → 贴到厨房窗口 → 顾客拿号等着
    厨师从窗口取订单 → 做好后叫号
    厨师晕倒 → 换一个厨师继续做（订单还在纸上）

技术映射：
    顾客   = 用户请求（HTTP POST）
    订单纸 = Redis 列表（任务持久化）
    厨房窗口 = Redis（消息中间件）
    厨师   = Arq Worker 进程
    叫号   = 任务状态更新（数据库 status 字段）
```

```
三个核心角色：

  Producer（生产者）= API 进程
    负责接收请求、创建任务、推入队列
    代码：arq.enqueue_job("run_yolo_detection", task_id)

  Broker（消息中间件）= Redis
    负责存储和分发任务
    存储：Redis List（RPUSH 入队，BLPOP 出队）
    保证：任务不丢失（持久化到磁盘）

  Consumer（消费者）= Arq Worker 进程
    负责从队列取任务、执行、写结果
    代码：uv run arq app.worker.WorkerSettings
    特性：独立进程，OOM 不影响 API
```

**面试话术**：
> "任务队列解决的是异步处理和故障隔离。API 只负责接收请求和入队，
> Worker 独立进程消费任务。Redis 作为中间件保证任务持久化和可靠分发。
> 这是典型的 Producer-Broker-Consumer 模式。"

---

## Part 3：为什么要替换 BackgroundTasks？

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
Docker ：docker start redis                          ← Redis 服务（容器）

三个独立进程，互不影响。
Redis 跑在 Docker 容器中，数据持久化到 ~/.docker-data/redis。
```

---

## Step 1：`app/core/config.py` — 新增 Redis 配置

```python
# === Redis 配置 ===
REDIS_URL: str = "redis://:changeme_dev@localhost:6379/0"
REDIS_MAX_CONNECTIONS: int = 10
```

> `.env` 文件中配置：`REDIS_URL=redis://:changeme_dev@localhost:6379/0`
> 注意 URL 格式：`redis://[:password@]host:port/db`，密码前有一个冒号。

**你需要回答自己的问题**：

1. **为什么密码要放在 `REDIS_URL` 里而不是单独一个配置项？**
   - `redis.asyncio` 的 `ConnectionPool.from_url()` 直接解析 URL 中的密码
   - `parse_redis_settings()` 也从 URL 中提取 `parsed.password`
   - 一个 URL 包含所有连接信息（host、port、password、db）→ 单一配置源
   - 密码在 `.env` 文件中，不硬编码到代码里 → `.env` 已在 `.gitignore` 中
   - **面试点**："连接字符串（DSN）是配置外部服务的标准方式。一个 URL 包含所有参数，环境变量覆盖，不入代码仓库。"

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
  - 提供 RedisSettings 解析（Arq Worker 也需要）

为什么用连接池？
  - 每次操作都新建 TCP 连接 → 建连耗时 1-3ms → 高频操作累积开销大
  - 连接池复用已有连接 → 0ms 开销
  - 类比数据库连接池（SQLAlchemy 的 pool_size）
"""

import logging
from urllib.parse import urlparse

import redis.asyncio as redis
from arq import create_pool
from arq.connections import ArqRedis, RedisSettings

from app.core.config import settings

logger = logging.getLogger(__name__)

# 全局 Arq 连接（用于入队任务）
_arq_pool: ArqRedis | None = None

# 全局 Redis 连接池（用于缓存等通用操作）
_redis_pool: redis.ConnectionPool | None = None


def parse_redis_settings() -> RedisSettings:
    """
    从 REDIS_URL 解析出 Arq 需要的 RedisSettings。

    REDIS_URL 格式：redis://[:password@]host:port/db
    ArqRedis 需要 host, port, database 分开传。

    注意：这个函数是公开的（不带下划线），因为 worker.py 也需要调用。
    """
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
    _arq_pool = await create_pool(parse_redis_settings())
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

3. **`parse_redis_settings` 为什么不带下划线前缀？**
   - Python 约定：`_func` 是模块私有的，`func` 是公开的
   - `worker.py` 需要同样的解析逻辑来配置 Worker 的 Redis 连接
   - 如果各写一份 → 代码重复 + 改一个忘改另一个 → bug
   - 所以放在 `redis.py` 中公开导出，`worker.py` import 使用

4. **连接池什么时候关闭？**
   - 在 lifespan 的 shutdown 阶段（`yield` 之后）调用 `close_redis()`
   - 不关闭 → 连接泄露 → Redis 连接数耗尽 → 新连接被拒绝
   - **面试点**："资源的生命周期要和应用生命周期对齐。lifespan 中 init/close 是标准模式。"

---

## Step 3：`app/tasks/yolo_task.py` — YOLO 异步任务

> 先创建 `app/tasks/` 目录和 `app/tasks/__init__.py`（空文件）。

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
from app.models.task import Task, TaskStatus
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

    对比 Day 4 的 background_detect_task(task_id, file_path, result_path)：
    - Day 4 直接传路径参数 → 和 API 进程共享内存，路径随手可得
    - Day 9 只传 task_id → 从数据库读路径 → 适合跨进程场景
    - 好处：入队时只序列化一个 int，不序列化长字符串；且数据库是唯一真相源
    """
    t0 = time.perf_counter()
    logger.info("开始 YOLO 推理 task_id=%d", task_id)

    # Worker 进程没有 FastAPI 的 Depends(get_db)，必须手动创建 Session
    async with AsyncSessionLocal() as db:
        task = await db.get(Task, task_id)
        if not task:
            logger.error("任务不存在 task_id=%d", task_id)
            return {"task_id": task_id, "error": "task_not_found"}

        if task.status == TaskStatus.COMPLETED.value:
            logger.info("任务已完成，跳过 task_id=%d", task_id)
            return {"task_id": task_id, "status": "already_completed"}

        try:
            # YOLO 推理（CPU 密集，放到线程池）
            # 注意：YOLOService.predict 需要 image_path 和 save_path 两个参数
            # 这两个路径在创建 Task 时已经存到了数据库
            result = await asyncio.to_thread(
                YOLOService.predict, task.original_path, task.result_path
            )

            task.detect_result = result
            task.status = TaskStatus.COMPLETED.value
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

        except Exception:
            task.status = TaskStatus.FAILED.value
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

1. **为什么只传 `task_id` 而不传 `file_path` 和 `result_path`？**
   - Day 4 的 `background_detect_task(task_id, file_path, result_path)` 在同一进程内执行
   - Day 9 入队时参数会序列化到 Redis → 参数越少越好
   - `task_id` 是整数，序列化成本几乎为零
   - Worker 从数据库读 `task.original_path` 和 `task.result_path` → 数据库是唯一真相源
   - **面试点**："跨进程任务队列的参数应该尽量轻量。传 ID 让 Worker 自己查数据库，不传大对象。"

2. **为什么用 `TaskStatus.COMPLETED.value` 而不是字符串 `"completed"`？**
   - `TaskStatus` 是我们在 Day 3 定义的枚举：`PENDING / PROGRESSING / COMPLETED / FAILED`
   - 用枚举常量 → 拼写错误在 import 时就报错（`TaskStatus.COMPELTED` → AttributeError）
   - 用字符串 → 拼写错误只在运行时才发现（`"compelted"` 不会报错但逻辑错）
   - **面试点**："用枚举代替魔术字符串，把运行时错误提前到编译时。"

3. **为什么失败时要 `raise` 而不是 `return {"error": ...}`？**
   - Arq 的重试机制基于异常：函数抛异常 → Arq 捕获 → 等待后重试
   - 如果 `return` 错误信息 → Arq 认为任务成功完成 → 不会重试
   - 所以：先把状态写为 `failed`（让用户看到当前状态），再 `raise`（触发 Arq 重试）
   - 重试成功后状态会变为 `completed`
   - **面试点**："区分业务失败和系统失败。任务不存在是业务问题（return），推理异常是系统问题（raise 触发重试）。"

4. **`ctx` 参数有什么用？**
   - Arq 自动注入，包含 `ctx["redis"]`（Redis 连接）和 `ctx["job_id"]`（任务 ID）
   - 可以用来做进度上报，比如 `await ctx["redis"].set(f"yolo:progress:{task_id}", "50%")`
   - 当前没用到，但保留参数是 Arq 的要求（第一个参数必须是 ctx）

5. **重试时 `task.status` 已经是 `failed`，重试成功后呢？**
   - 重试时重新执行整个函数 → 重新从数据库读 task
   - `if task.status == TaskStatus.COMPLETED.value` 跳过（防止重复处理）
   - 重试成功 → status 改为 `completed` → 覆盖之前的 `failed`
   - **追问**：用户在重试期间看到 `failed` 怎么办？（前端可以显示 "检测中，正在重试..."）

6. **Worker 进程怎么加载 YOLO 模型？**
   - Worker 在 `on_startup` 中主动调用 `YOLOService.load_model()`（启动时加载，避免第一个任务额外等待）
   - **只有 Worker 需要加载模型**，API 主进程不再执行检测，应从 lifespan 中去掉 `YOLOService.load_model()`，节省 100-300MB 内存
   - 原则：**谁用谁加载，不用不加载**
   - **追问**：如果以后有多个 Worker 进程呢？（每个 Worker 各加载一份，进程间不共享内存。流量大时可以用模型服务化——独立起一个推理服务，所有 Worker 通过网络调用它）

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

from app.core.redis import parse_redis_settings
from app.tasks.yolo_task import run_yolo_detection

logger = logging.getLogger(__name__)


async def on_startup(ctx: dict) -> None:
    """
    Worker 启动时执行。

    类似 FastAPI 的 lifespan startup。
    用于初始化 Worker 进程需要的资源。
    """
    logger.info("Arq Worker 启动...")
    # 主动加载 YOLO 模型，避免第一个任务额外等待加载时间
    YOLOService.load_model()


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

    # Redis 连接配置（复用 redis.py 的解析逻辑，不重复写）
    redis_settings = parse_redis_settings()

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

1. **`redis_settings = parse_redis_settings()` 为什么从 redis.py 导入？**
   - 原版在 `redis.py` 和 `worker.py` 各写了一份 `_parse_redis_settings` → 代码重复
   - 重复的后果：改了一个忘改另一个 → Worker 连了错误的 Redis → 任务石沉大海
   - 现在统一放在 `redis.py` 中，`worker.py` import 使用
   - **面试点**："DRY 原则（Don't Repeat Yourself）。解析逻辑只存一份，所有消费者 import 使用。"

2. **`functions = [run_yolo_detection]` 为什么要显式注册？**
   - 安全考量：只有注册的函数才能被执行
   - 如果不限制 → 攻击者通过 Redis 注入任意函数名 → 远程代码执行
   - **面试安全点**："任务函数白名单注册，防止通过 Redis 注入执行任意代码。"

3. **`max_tries=3` 是总共 3 次还是重试 3 次？**
   - 总共 3 次（1 次初始执行 + 2 次重试）
   - 第 3 次还失败 → 任务标记为永久失败（dead letter）
   - **追问**：永久失败的任务怎么处理？（记录日志 + 告警，人工介入排查）

4. **Worker 进程怎么知道有新任务？**
   - Arq 用 Redis 的 `BLPOP`（阻塞式列表弹出）实现
   - 你在 Part 1 的 Redis CLI 练习中已经用过 `BLPOP` 了！
   - Worker 阻塞等待在 Redis 队列上 → 有新任务时立即唤醒
   - 不是轮询（轮询浪费 CPU），是阻塞等待（事件驱动）

5. **`cron_jobs` 定时任务有什么用？**
   - 场景 1：每天凌晨清理 7 天前的临时文件（上传的原始图片）
   - 场景 2：每周重建知识库索引（定期全量更新）
   - 场景 3：每小时清理过期的 Redis 缓存
   - 当前注释掉，后续按需开启

---

## Step 5：改 `app/routers/task.py` — 入队替代 BackgroundTasks

> 注意文件名：实际代码中是 `task.py`（单数），不是 `tasks.py`。

### 核心改动

```python
# === 删掉 ===
from fastapi import BackgroundTasks

# === 新增 ===
from app.core.redis import get_arq_redis
```

### 完整改动对比

```python
# 删掉原来的 background_detect_task 函数（整个函数删除）
# 功能已迁移到 app/tasks/yolo_task.py 的 run_yolo_detection


@router.post("/tasks/upload", response_model=list[TaskSchema])
async def upload_tasks(
    # 删掉：background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    # 限流：每用户每分钟最多 20 次上传
    await rate_limit(current_user.id, "upload", limit=20, window=60)

    created_tasks = []
    r = get_redis()
    arq = get_arq_redis()

    for file in files:
        # 先过滤非图片文件
        if not file.content_type.startswith("image/"):
            continue

        # 读取文件内容用于计算 hash
        content = await file.read()
        await file.seek(0)  # 重置文件指针，后续还要读

        # 分布式锁：防重复提交
        file_hash = hashlib.md5(content).hexdigest()
        lock_key = f"lock:upload:{current_user.id}:{file_hash}"
        # SET NX: key不存在时设置成功并返回True，存在时返回False
        acquired = await r.set(lock_key, "1", nx=True, ex=30)
        if not acquired:
            logger.warning(
                "上传重复文件被拒绝 user_id=%d file_hash=%s",
                current_user.id,
                file_hash,
            )
            raise HTTPException(
                status_code=409,
                detail=f"文件{file.filename}正在处理中，请勿重复提交",
            )

        uuid_str, file_name, save_path = await FileService.save_file(file)
        result_path = FileService.get_result_path(uuid_str, file_name)
        new_task = Task(
            user_id=current_user.id,
            uuid=uuid_str,
            file_name=file_name,
            original_path=save_path,
            result_path=result_path,
            status=TaskStatus.PROGRESSING.value,
        )
        db.add(new_task)
        await db.commit()
        await db.refresh(new_task)

        # === Day 4 的写法（删掉）===
        # background_tasks.add_task(background_detect_task, new_task.id, save_path, result_path)

        # === Day 9 的写法（替换）===
        job = await arq.enqueue_job(
            "run_yolo_detection",        # 任务函数名（必须和 Worker 注册的一致）
            new_task.id,                 # 传给任务函数的参数（只传 task_id）
            _job_id=f"yolo_{new_task.id}",  # 自定义 job ID（方便查询状态）
        )
        logger.info(
            "YOLO 任务已入队 task_id=%d job_id=%s",
            new_task.id, job.job_id if job else "duplicate",
        )

        created_tasks.append(new_task)

    if not created_tasks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="请至少上传一个有效的图片文件"
        )
    return created_tasks
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
    - GET /tasks/{task_id} 查数据库中的 Task 状态（progressing/completed/failed）
    - 这个接口查 Redis 中 Arq Job 的状态（queued/in_progress/complete）
    - 两个维度的信息互补

    注意：这个接口主要用于调试，生产环境前端只需要轮询 GET /tasks/{task_id}。
    """
    arq = get_arq_redis()
    job = Job(job_id=f"yolo_{task_id}", redis=arq)
    job_status = await job.status()
    info = await job.info()

    return {
        "task_id": task_id,
        "job_id": f"yolo_{task_id}",
        "job_status": job_status.value if job_status else "unknown",
        "job_result": info.result if info and info.result else None,
    }
```

**你需要回答自己的问题**：

1. **`_job_id=f"yolo_{new_task.id}"` 为什么要自定义？**
   - 默认 job_id 是随机 UUID → 无法通过 task_id 反查 job 状态
   - 自定义为 `yolo_{task_id}` → 知道 task_id 就能查 job 状态
   - **追问**：如果同一个 task_id 重复入队呢？（Arq 会拒绝重复 job_id，返回 None 而不是 Job 对象。所以代码中用 `job.job_id if job else "duplicate"` 做日志保护）

2. **`enqueue_job` 的第一个参数为什么是字符串？**
   - Arq 入队时只存函数名（字符串）+ 参数到 Redis
   - Worker 进程根据函数名从 `functions` 列表中找到对应函数执行
   - 如果传函数对象 → 无法序列化到 Redis
   - **面试点**："任务入队和执行在不同进程。入队存的是函数名（字符串），Worker 根据名字路由到注册的函数。这就是为什么要显式注册。"

3. **原来的 `background_detect_task` 函数还需要吗？**
   - 不需要了，功能已迁移到 `app/tasks/yolo_task.py` 的 `run_yolo_detection`
   - 直接删掉 `background_detect_task` 整个函数
   - 同时删掉 `from fastapi import BackgroundTasks` 的 import

4. **为什么 `arq = get_arq_redis()` 放在循环外面？**
   - `get_arq_redis()` 只是返回全局连接池引用，几乎零开销
   - 但放在循环外更清晰：一次获取，多次入队
   - 不像数据库操作那样需要每次新建 session

---

## Step 6：改 `app/main.py` — lifespan 管理 Redis 生命周期

```python
from app.core.redis import init_redis, close_redis

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # === startup ===
    setup_logging()
    logger.info("Starting up...")
    await init_models()
    # YOLOService.load_model()    # Day 9 删除：检测已交给 Worker，主进程不需要加载模型
    await RagService.initialize()
    await init_redis()            # Day 9 新增
    yield
    # === shutdown ===
    await close_redis()           # Day 9 新增
    logger.info("Shutting down...")
    await engine.dispose()
```

**你需要回答自己的问题**：

1. **为什么删掉 `YOLOService.load_model()`？**
   - Day 9 之后，YOLO 检测由 Worker 进程执行，主进程不再调用 `predict()`
   - 保留它 = 浪费 100-300MB 内存，毫无意义
   - 原则：**谁用谁加载，不用不加载**
   - Worker 在 `on_startup` 中自己加载模型

2. **为什么 `close_redis()` 要在 shutdown 中调用？**
   - 不关闭 → Redis 连接泄露 → 达到 Redis 的 `maxclients` 限制后新连接被拒绝
   - lifespan 的 `yield` 之后就是 shutdown 代码
   - **面试点**："lifespan 管理所有外部资源的生命周期：数据库连接池、Redis 连接池、ML 模型。应用退出时按依赖顺序逆序关闭。"

3. **启动顺序为什么是 DB → RAG → Redis？**
   - 先启动数据库（其他服务都依赖它）
   - 再初始化 RAG（需要数据库中的知识库数据）
   - 最后 Redis（让 Arq 可以开始接收任务）
   - 如果 Redis 先启动 → 任务入队 → Worker 开始执行 → 但 DB 还没准备好 → 报错

---

## Step 7：Redis 工程实战

> 以下 4 个功能全部必做。每个都是面试高频题，代码量小，收益极高。

---

### 7.1 任务状态缓存（Cache-Aside 模式）

**问题**：前端轮询 `GET /tasks/{task_id}` 查任务状态，每次都打数据库。任务完成后状态不会再变，反复查 DB 纯浪费。

**方案**：任务完成时写 Redis 缓存，查询时先查 Redis，未命中再查 DB。

**改动 1：`app/tasks/yolo_task.py`** — 任务完成后写缓存

在 `run_yolo_detection` 的 `db.commit()` 之后加：

```python
import json
from app.core.redis import get_redis

# --- 在 task.status = TaskStatus.COMPLETED.value 和 db.commit() 之后 ---

# 写入 Redis 缓存（1 小时过期）
# 注意：必须存 user_id，读缓存时要校验权限
r = get_redis()
await r.set(
    f"task:result:{task_id}",
    json.dumps({
        "id": task_id,
        "user_id": task.user_id,
        "status": TaskStatus.COMPLETED.value,
        "detect_result": result,
    }),
    ex=3600,
)
logger.info("任务结果已缓存 task_id=%d TTL=3600s", task_id)
```

**改动 2：`app/routers/task.py`** — 查询时先查缓存

修改 `get_task_detail` 函数：

```python
import json
from app.core.redis import get_redis

@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Task:
    r = get_redis()

    # 1. 先查 Redis 缓存
    cached = await r.get(f"task:result:{task_id}")
    if cached:
        data = json.loads(cached)
        # 权限校验：缓存中的 user_id 必须等于当前用户（防止越权，返回 404 而非 401）
        if data.get("user_id") != current_user.id:
            raise HTTPException(status_code=404, detail="任务不存在")
        logger.debug("缓存命中 task_id=%d", task_id)
        return data  # 校验通过，直接返回，不查 DB

    # 2. 未命中，查数据库
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    # 3. 回填缓存：只缓存已完成的任务（进行中的状态还会变，不能缓存）
    if task.status == TaskStatus.COMPLETED.value:
        await r.set(
            f"task:result:{task_id}",
            json.dumps({
                "id": task.id,
                "user_id": task.user_id,
                "status": task.status,
                "detect_result": task.detect_result,
            }),
            ex=3600,
        )
        logger.debug("缓存回填 task_id=%d", task_id)

    return task
```

**你需要回答自己的问题**：

1. **这是什么缓存模式？**
   - **Cache-Aside（旁路缓存）**：应用自己管理缓存的读写
   - 读：查缓存 → 命中直接返回 → 未命中查 DB → **回填缓存** → 返回
   - 写：更新 DB → 删缓存（下次读时自动回填）
   - **面试点**："Cache-Aside 是最常用的缓存模式。读未命中时回填缓存，写时先写 DB 再删缓存，保证数据库是唯一真相源。"

2. **为什么 yolo_task.py 里是"写缓存"而不是"删缓存"？**
   - 标准 Cache-Aside 写流程是"更新 DB → 删缓存"，防止并发写导致不一致
   - 但任务状态变成 completed 后**永远不会再变**，不存在并发更新
   - 这种"一次性终态"场景，直接写缓存比删缓存更高效（省掉下一次读的回填）
   - **面试点**："标准做法是删缓存，但如果数据写入后不会再变（终态），直接写缓存更高效。关键是判断数据是否还会被修改。"

3. **为什么只缓存 completed 状态？**
   - progressing 状态还会变 → 缓存了就过时了 → 用户看到的永远是"进行中"
   - completed/failed 是终态 → 缓存不会过时
   - 原则：**只缓存不会再变的数据**

4. **为什么 TTL 设 1 小时而不是永久？**
   - 任务完成后状态确实不会再变，理论上可以永久缓存
   - 但设 TTL 是防御性编程：万一代码 bug 写入了错误缓存，1 小时后自动修复
   - **面试点**："任何缓存都应该设 TTL，即使数据看起来不会变。这是防御性设计。"

3. **缓存击穿怎么办？**
   - 击穿：热点 key 过期瞬间，大量请求同时打到 DB
   - 当前场景不严重：单个 task 的查询不会有高并发
   - 如果是高并发场景：用 `SET NX`（分布式锁）保证只有一个请求回源 DB

---

### 7.2 API 限流（FastAPI 依赖注入）

**问题**：没有限流 → 一个用户写个循环就能把 GPU/CPU 打满 → 其他人全卡死。

**新建文件 `app/core/rate_limit.py`**：

```python
"""
API 限流（固定窗口算法）。

原理：
  key = "ratelimit:{user_id}:{endpoint}"
  每次请求 INCR → 返回当前计数
  第一次 INCR 时设置 TTL → 窗口到期 key 自动过期 → 计数归零

为什么用 Redis 而不是 Python 变量？
  Python 变量在进程内存中 → 多个 uvicorn worker 各自计数
  4 个 worker × 限流 10 次 = 实际放行 40 次
  Redis 是集中存储 → 所有进程共享同一个计数器 → 真正限流 10 次
"""

import logging

from fastapi import HTTPException

from app.core.redis import get_redis

logger = logging.getLogger(__name__)


async def check_rate_limit(
    user_id: int,
    endpoint: str,
    limit: int = 10,
    window: int = 60,
) -> None:
    """
    固定窗口限流：每个用户每 {window} 秒最多 {limit} 次请求。

    参数：
      user_id:  当前用户 ID
      endpoint: 端点标识（如 "upload", "chat"）
      limit:    窗口内最大请求数
      window:   窗口大小（秒）
    """
    r = get_redis()
    key = f"ratelimit:{user_id}:{endpoint}"

    # INCR 是原子操作：如果 key 不存在则创建并设为 1，否则 +1
    current = await r.incr(key)

    # 只在第一次 INCR 时设置过期时间
    if current == 1:
        await r.expire(key, window)

    if current > limit:
        logger.warning("限流触发 user_id=%d endpoint=%s count=%d", user_id, endpoint, current)
        raise HTTPException(
            status_code=429,
            detail=f"请求过于频繁，请 {window} 秒后再试",
        )
```

**在路由中使用** — 修改 `app/routers/task.py`：

```python
from app.core.rate_limit import check_rate_limit

@router.post("/tasks/upload", response_model=list[TaskSchema])
async def upload_tasks(
    files: list[UploadFile] = File(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    # 限流：每用户每分钟最多 20 次上传
    await check_rate_limit(current_user.id, "upload", limit=20, window=60)
    # ... 原有逻辑 ...
```

**在聊天路由中使用** — 修改 `app/routers/chat.py`：

```python
from app.core.rate_limit import check_rate_limit

@router.post("/chat/stream")
async def chat_stream(...):
    # 限流：每用户每分钟最多 10 次对话
    await check_rate_limit(current_user.id, "chat", limit=10, window=60)
    # ... 原有逻辑 ...
```

**你需要回答自己的问题**：

1. **为什么 INCR 和 EXPIRE 不用 pipeline / Lua 脚本保证原子性？**
   - 严格来说，`INCR` 和 `EXPIRE` 是两个命令，中间进程崩溃可能导致 key 没有 TTL → 永不过期 → 永久限流
   - 但概率极低（两个命令间隔微秒级），生产中固定窗口一般就这么写
   - 如果要严格原子性，用 Lua 脚本：`redis.call('INCR', key); if tonumber(val) == 1 then redis.call('EXPIRE', key, window) end`
   - **面试点**："固定窗口限流的 INCR+EXPIRE 严格来说不是原子操作，但工程上可接受。严格原子性用 Lua 脚本。"

2. **固定窗口 vs 滑动窗口？**
   - 固定窗口缺陷：`00:59` 打 10 次 + `01:00` 打 10 次 → 2 秒内 20 次
   - 滑动窗口：用 Sorted Set，`ZADD key timestamp timestamp`，`ZRANGEBYSCORE` 统计窗口内请求数
   - 当前用固定窗口，简单够用。滑动窗口面试能说出来就行，不需要实现

#### 深入理解：为什么限流必须用 Redis？

**核心问题：Python 变量在进程内存中，多进程部署时内存不共享。**

开发环境你跑的是单进程：

```bash
uv run uvicorn app.main:app --reload    # 单进程，开发用
```

生产环境必须多进程：

```bash
# 方式 1：uvicorn 自带多 worker
uvicorn app.main:app --workers 4 --host 0.0.0.0 --port 8000

# 方式 2：gunicorn 做进程管理器（生产更常见）
gunicorn app.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

`--workers 4` 启动 4 个独立进程，每个进程是一个完整的 FastAPI 应用。

**为什么要多进程？** Python 有 GIL（全局解释器锁）——同一时刻只有一个线程能执行 Python 代码。async 只解决 I/O 等待（等数据库、等网络），CPU 密集型操作还是被 GIL 卡住。多进程是标准解法。

**多进程下 Python 变量的问题**：

```
生产部署：uvicorn --workers 4

用户第 1 次请求 → 打到 worker 1 → counter_1 = 1
用户第 2 次请求 → 打到 worker 2 → counter_2 = 1  ← 不是 2！
用户第 3 次请求 → 打到 worker 3 → counter_3 = 1  ← 不是 3！

你限流 10 次，4 个 worker 各自数到 10 → 实际放行 40 次 → 限流形同虚设
```

**内存模型**：

```
┌──────────────────────────────────────────┐
│                 操作系统                   │
│                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ worker 1 │ │ worker 2 │ │ worker 3 │ │
│  │counter=3 │ │counter=1 │ │counter=2 │ │
│  │ 自己的内存 │ │ 自己的内存 │ │ 自己的内存 │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│       └────────────┼────────────┘        │
│                    ▼                     │
│            ┌──────────────┐              │
│            │    Redis     │ ← 独立进程    │
│            │  counter = 6 │ ← 所有人共享  │
│            └──────────────┘              │
└──────────────────────────────────────────┘
```

Redis 是所有进程之外的独立服务，所有 worker 共享同一个计数器。多台服务器（水平扩展）也一样——Redis 天然支持跨机器共享。

**面试话术**：
> "生产环境用 gunicorn + uvicorn worker 多进程部署。每个 worker 是独立进程，
> 内存不共享，所以限流计数器、缓存、会话等共享状态必须放 Redis。
> Python 的 GIL 限制了单进程的 CPU 并发，多进程是标准解法。"

**关于 Python 3.13 的 no-GIL（free-threaded mode）**：

3.13 引入了实验性的 free-threaded 模式，3.14 已升级为**官方正式支持**（安装包自带 free-threaded 二进制文件）。但仍然是可选的——默认安装还是带 GIL。

| 版本 | 状态 |
|---|---|
| 3.13（2024.10） | 实验性 no-GIL，默认关闭 |
| 3.14（2025.10） | **官方正式支持**，主流库（NumPy、PyTorch、pydantic 等）已适配 |
| 3.15+（预计 2026.10） | 预计进一步成熟 |

即使 GIL 完全移除，多进程部署模式也不会消失——多进程还有故障隔离的好处（一个 worker 崩了不影响其他的）。

**面试点**："3.14 开始官方支持 free-threaded 模式，但对 Web 服务影响不大——I/O 密集用 async，CPU 密集用多进程。生产部署仍然用多进程，因为故障隔离和内存保护是多线程替代不了的。"

> 更多 GIL 深入知识（引用计数原理、性能影响、生态适配详情）见 `read_port/扩展知识.md` 第 1 节。

#### 深入理解：滑动窗口限流（Sorted Set 实现）

> 当前项目用固定窗口，简单够用。但面试必须能说清楚滑动窗口的原理和实现。

**前置知识：Redis Sorted Set（有序集合）**

Sorted Set = 每个元素带一个分数（score），Redis 自动按分数从小到大排序。

| 命令 | 作用 | 示例 |
|---|---|---|
| `ZADD key score member` | 添加元素（带分数） | `ZADD myset 100 "alice"` |
| `ZCARD key` | 返回元素个数 | `ZCARD myset` → 3 |
| `ZRANGEBYSCORE key min max` | 查分数在 [min, max] 的元素 | `ZRANGEBYSCORE myset 80 95` |
| `ZREMRANGEBYSCORE key min max` | 删分数在 [min, max] 的元素 | `ZREMRANGEBYSCORE myset 0 89` |
| `ZRANGE key start stop WITHSCORES` | 按排名查看（带分数） | `ZRANGE myset 0 -1 WITHSCORES` |

在 redis-cli 中试一下：

```redis
# 添加三个元素
ZADD myset 100 "alice"
ZADD myset 85  "bob"
ZADD myset 92  "charlie"

# 查看全部（自动按 score 排序）
ZRANGE myset 0 -1 WITHSCORES
# → bob(85), charlie(92), alice(100)

# 数元素个数
ZCARD myset
# → 3

# 查 score 在 80~95 之间的
ZRANGEBYSCORE myset 80 95 WITHSCORES
# → bob(85), charlie(92)

# 删掉 score < 90 的
ZREMRANGEBYSCORE myset 0 89
# → 删了 bob(85)
```

**固定窗口的边界突刺问题**

固定窗口把时间切成一格一格的，漏洞在窗口交界处：

```
窗口 1: [00:00 ~ 01:00]  限 10 次
窗口 2: [01:00 ~ 02:00]  限 10 次

00:59 → 用户打了 10 次 → 窗口 1 计数 = 10 → 刚好没超
01:00 → 窗口切换，计数归零 → 用户又打 10 次 → 窗口 2 计数 = 10

结果：2 秒内打了 20 次，但两个窗口都没超限！
```

**滑动窗口的解决方案**

不切固定格子，以当前时刻为终点，往前看 60 秒。任何时刻往前数 60 秒，都不能超过 10 次。

```
每次请求执行 4 步：

1. ZREMRANGEBYSCORE key 0 {当前时间 - 60}
   → 删掉 60 秒之前的旧记录

2. ZCARD key
   → 数窗口内有几条

3. 如果 count >= limit → 拒绝（429）

4. ZADD key {当前时间} {当前时间}
   → 放行，记录本次请求
```

**完整示例**：限流 10 次/60 秒

```
用户在第 10s~58s 发了 10 次请求：
  集合：{ 10, 15, 20, 25, 30, 35, 40, 45, 50, 58 }

第 61s，用户又发请求：
  Step 1: ZREMRANGEBYSCORE key 0 1   → 删 score ≤ 1 的 → 没有要删的
  Step 2: ZCARD → 10
  Step 3: 10 >= 10 → 拒绝！

第 71s，用户再试：
  Step 1: ZREMRANGEBYSCORE key 0 11  → 删 score ≤ 11 的 → 删掉了 "10"
  集合变成：{ 15, 20, 25, 30, 35, 40, 45, 50, 58 }（9 个）
  Step 2: ZCARD → 9
  Step 3: 9 < 10 → 放行！
  Step 4: ZADD key 71 "71"
```

第 10 秒的请求到了第 71 秒已经"滑出窗口"，腾出了名额。**窗口跟着当前时间滑动，没有边界漏洞。**

**对比**：

```
同样场景（58s 打 10 次，61s 再打 10 次）：

固定窗口：58s 在窗口 1，61s 在窗口 2 → 两个窗口都没超 → 放行 20 次 ✗
滑动窗口：61s 往前看 60 秒 [1s~61s] → 58s 的 10 次都在窗口内 → 拒绝 ✓
```

| | 固定窗口 | 滑动窗口 |
|---|---|---|
| 实现 | INCR + EXPIRE（2 个命令） | ZADD + ZREMRANGEBYSCORE + ZCARD（3 个命令） |
| 内存 | 每个 key 一个整数 | 每个 key 存 N 个时间戳 |
| 精度 | 边界处有 2x 突刺 | 严格精确 |
| 适用 | 大多数场景够用 | 对突刺敏感的场景（支付、短信验证码） |

**滑动窗口 Python 实现**（了解即可，当前项目不需要）：

```python
async def check_rate_limit_sliding(
    user_id: int,
    endpoint: str,
    limit: int = 10,
    window: int = 60,
) -> None:
    """滑动窗口限流：用 Sorted Set 实现。"""
    import time

    r = get_redis()
    key = f"ratelimit:{user_id}:{endpoint}"
    now = time.time()
    window_start = now - window

    # 1. 删掉窗口外的旧记录
    await r.zremrangebyscore(key, 0, window_start)

    # 2. 数窗口内有几条
    current = await r.zcard(key)

    if current >= limit:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")

    # 3. 放行，记录本次请求
    await r.zadd(key, {str(now): now})

    # 4. 设过期时间，防止用户不再请求后 key 永远留着
    await r.expire(key, window + 1)
```

**面试话术**：
> "固定窗口用 INCR+EXPIRE，简单但窗口交界处有 2 倍突刺。
> 滑动窗口用 Sorted Set 记录每次请求的时间戳，每次请求时删除窗口外的旧记录再计数，
> 任意时刻都严格限流。我们项目用固定窗口，因为上传和聊天对突刺不敏感。
> 如果是支付接口会换滑动窗口。"

---

### 7.3 JWT 黑名单（登出失效）

**问题**：JWT 是无状态的，签发后你无法让它失效。用户点"退出登录"→ token 仍然有效 → 安全隐患。

**原理**：用户登出时，把 token 存入 Redis 黑名单，TTL = token 剩余有效期。每次鉴权时检查黑名单。

**改动 1：`app/routers/auth.py`** — 新增登出端点 + 修改 `get_current_user`

```python
import hashlib
from datetime import UTC, datetime

from app.core.redis import get_redis


@router.post("/auth/logout", status_code=204)
async def logout(token: str = Depends(oauth2_scheme)) -> None:
    """
    登出：将当前 token 加入 Redis 黑名单。

    为什么用 token 的 SHA256 而不是原文？
    - token 可能很长（几百字节），SHA256 固定 64 字节，节省 Redis 内存
    - 黑名单只需要判断"存不存在"，不需要还原原文
    """
    # 解码 token 获取过期时间
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        remaining = int((exp - datetime.now(UTC)).total_seconds())
        if remaining <= 0:
            return  # token 已过期，无需加黑名单
    except jwt.InvalidTokenError:
        return  # token 无效，无需处理

    # 存入 Redis 黑名单，TTL = 剩余有效期
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    await r.set(f"blacklist:{token_hash}", "1", ex=remaining)


async def get_current_user(
    token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )

    # === Day 9 新增：检查黑名单 ===
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    if await r.get(f"blacklist:{token_hash}"):
        raise credentials_exception
    # === 黑名单检查结束 ===

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
    user = await db.get(User, token_data.user_id)
    if user is None:
        raise credentials_exception
    return user
```

**你需要回答自己的问题**：

1. **为什么 TTL = 剩余有效期，而不是固定 7 天？**
   - 固定 7 天 → 已经自然过期的 token 还在 Redis 占内存 → 浪费
   - 剩余有效期 → token 过期时 Redis key 也刚好过期 → 自动清理，零运维
   - **面试点**："JWT 黑名单的 TTL 应该等于 token 的剩余有效期。token 过期后黑名单自动消失，避免无限增长。"

2. **每次请求都查 Redis，性能有影响吗？**
   - Redis 单次 GET 延迟 ~0.1ms（本机），相比 DB 查询 ~1-5ms 可忽略
   - 鉴权是每个请求都要做的，这 0.1ms 是安全的必要成本
   - **面试点**："JWT 黑名单是'有状态的无状态认证'，用极小的性能代价换取了登出能力。"

3. **黑名单 vs 短 token + Refresh Token？**
   - 另一种方案：access_token 有效期缩短到 15 分钟，用 refresh_token 续期
   - 登出时废弃 refresh_token → access_token 最多 15 分钟后失效
   - 当前方案（黑名单）更简单直接，适合中小项目
   - **面试点**：能说出两种方案并比较，就是加分项

---

### 7.4 分布式锁（防重复提交）

**问题**：用户快速双击"上传"按钮 → 同一张图片创建两个任务 → Worker 执行两次推理 → 浪费资源。

**原理**：上传时用文件内容的 hash 作为锁 key，`SET NX`（不存在才写入）。如果 key 已存在 → 说明相同文件正在处理 → 拒绝重复提交。

**新增到 `app/routers/task.py`**：

```python
import hashlib
from app.core.redis import get_redis

@router.post("/tasks/upload", response_model=list[TaskSchema])
async def upload_tasks(
    files: list[UploadFile] = File(),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    # 限流
    await check_rate_limit(current_user.id, "upload", limit=20, window=60)

    results: list[Task] = []
    r = get_redis()

    for file in files:
        content = await file.read()
        await file.seek(0)  # 重置文件指针，后续还要读

        # --- 分布式锁：防重复提交 ---
        file_hash = hashlib.md5(content).hexdigest()
        lock_key = f"lock:upload:{current_user.id}:{file_hash}"
        # SET NX：key 不存在时才设置成功（返回 True），已存在返回 False
        # EX 30：30 秒后自动释放（防止异常情况下锁永不释放）
        acquired = await r.set(lock_key, "1", nx=True, ex=30)
        if not acquired:
            logger.warning("重复提交被拒绝 user=%d hash=%s", current_user.id, file_hash)
            raise HTTPException(
                status_code=409,
                detail=f"文件 {file.filename} 正在处理中，请勿重复提交",
            )
        # --- 锁获取成功，继续处理 ---

        # ... 保存文件、创建 Task、入队 Arq 的原有逻辑 ...
```

**你需要回答自己的问题**：

1. **为什么用 `SET NX` 而不是先 `GET` 再 `SET`？**
   - `GET` → `SET` 是两步操作，中间可能有另一个请求也 `GET` 到空值 → 两个都 `SET` → 锁失效
   - `SET NX` 是原子操作：检查 + 写入在 Redis 内部一步完成 → 保证只有一个请求拿到锁
   - **面试点**："分布式锁的核心是 `SET key value NX EX ttl`，NX 保证原子性，EX 防止死锁。"

2. **为什么 EX 设 30 秒？**
   - 正常上传流程 < 5 秒，30 秒足够
   - 如果不设 EX → 进程崩溃时锁永不释放 → 该文件永远无法上传（死锁）
   - 30 秒后自动释放 → 即使出异常，30 秒后用户可以重新上传
   - **面试点**："分布式锁必须设过期时间，防止持有锁的进程崩溃导致死锁。"

3. **任务完成后要不要主动删锁？**
   - 当前设计不需要：30 秒后自动释放，短暂的"防抖"效果刚好
   - 如果业务需要"同一文件只处理一次"（幂等），则不删锁，改为更长的 TTL 或永久

**改动 2：`app/routers/chat.py`** — 聊天流也要加分布式锁

**问题**：用户双击发送 → 同一条消息触发两次 LLM 调用 → 浪费真金白银的 token 费用 + DB 存两条重复的 assistant 消息。

```python
from app.core.redis import get_redis

@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    question: str = Form(...),
    task_id: int | None = Form(None),
    images: list[UploadFile] = File(default=[]),
    current_user: user.User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    await rate_limit(current_user.id, "chat_stream", limit=10, window=60)

    # --- 分布式锁：同一用户同时只能有一个活跃的聊天流 ---
    r = get_redis()
    lock_key = f"lock:chat:{current_user.id}"
    acquired = await r.set(lock_key, "1", nx=True, ex=120)  # 2 分钟兜底
    if not acquired:
        raise HTTPException(status_code=409, detail="上一条消息还在生成中，请稍候")
    # --- 锁获取成功 ---

    # ... 原有逻辑（处理图片、存消息、获取历史等）...

    async def event_generator():
        try:
            # ... 流式生成逻辑 ...
            pass
        finally:
            # 生成完毕（无论成功/失败/取消）必须释放锁
            await r.delete(lock_key)

    return StreamingResponse(event_generator(), ...)
```

**和 upload 锁的关键区别**：

| | upload 锁 | chat 锁 |
|---|---|---|
| 锁 key | `lock:upload:{user_id}:{file_hash}` | `lock:chat:{user_id}` |
| 锁的维度 | 按文件内容（同一文件不能重复提交） | 按用户（同一用户不能并发生成） |
| 释放方式 | **不主动删**，30s 自动过期（防抖效果） | **必须主动删**（try/finally），120s 兜底 |
| 为什么这样设计 | upload 要"防抖"——同一张图 30s 内不让再传 | chat 要"即时释放"——生成完毕后用户应该立刻能发下一条 |
| EX 时间 | 30s（上传流程 < 5s） | 120s（LLM 生成可能 30-60s） |

**你需要回答自己的问题**：

4. **为什么 chat 锁必须 try/finally 主动释放，而 upload 锁不用？**
   - upload 的 30s 自动过期本身就是功能——"防抖"，同一文件短时间内不让再传
   - chat 如果不主动释放，用户发完一条消息要等 120s 才能发第二条 → 体验灾难
   - try/finally 保证即使流式生成抛异常，锁也一定被释放
   - **面试点**："分布式锁的释放策略取决于业务语义：防抖场景靠 TTL 自动过期，互斥场景靠 try/finally 主动释放 + TTL 兜底。"

5. **知识库重建为什么不需要额外加锁？**
   - Arq 的 `_job_id=f"rebuild_{mode}"` 天然去重：同一个 job_id 入队会被 Arq 拒绝
   - 效果等同于分布式锁，但不需要自己管理锁的生命周期
   - **面试点**："任务队列的 job_id 去重机制可以替代分布式锁实现任务单例。"

6. **只靠后端锁够吗？前端要不要也做防护？**
   - 前端应该做：用户点发送后，按钮变成"停止生成"图标，禁用输入框
   - 点击停止 → `AbortController.abort()` → 后端 `request.is_disconnected()` 检测到断开 → 停止生成
   - 但前端防护只挡"正常用户在浏览器里操作"，挡不住：多 tab、脚本调 API、前端 JS bug
   - **正确分层**：前端管体验（按钮禁用 + abort），后端管安全（Redis 分布式锁）
   - **面试点**："防重复提交是前后端协作：前端做乐观防护提升体验，后端做悲观防护保证安全，两层缺一不可。"

**项目所有需要防重复的端点汇总**：

| 端点 | 防重复方式 | 锁 key | 释放方式 |
|---|---|---|---|
| `POST /tasks/upload` | Redis SET NX | `lock:upload:{user_id}:{file_hash}` | 不主动删，30s 自动过期 |
| `POST /chat/stream` | Redis SET NX + try/finally | `lock:chat:{user_id}` | 主动删，120s 兜底 |
| `POST /knowledge/rebuild` | Arq job_id 去重 | 不需要额外加锁 | Arq 自动管理 |
| `GET` 类接口 | 不需要 | — | — |
| `POST /auth/login` | 限流即可 | — | — |

---

### 7.5 聊天上下文缓存（当前不做，面试必须能说清楚）

> 当前项目不需要实现，但面试官可能会问"你的聊天系统有没有用 Redis 缓存？"，你必须能回答清楚为什么做、为什么不做。

**场景**：每次用户发消息 → 查 DB 取最近 N 轮对话历史 → 拼接后发给 LLM。

**缓存方案**：用 Redis Hash 缓存对话历史，key = `chat:history:{session_id}`，TTL 30 分钟。命中直接用，未命中再查 DB。新消息产生时追加到 Redis 并滑动窗口。

**为什么当前不做？**
- 窗口只有 4 轮（8 条记录），DB 查询走主键/时间索引，耗时 < 1ms
- 加缓存要处理：新消息追加、窗口滑动、删除消息时缓存失效 → 一致性代码复杂度高
- **省掉的 1ms 查询，换来的是缓存一致性维护成本** → 投入产出比不划算

**什么时候必须做？**（满足任一条件即触发）
- 聊天历史窗口变大（几十轮甚至全量历史），DB 查询变慢
- 高并发场景（几千人同时在线聊天），DB 连接池成为瓶颈
- 历史需要复杂预处理（向量检索、摘要压缩），每次重算太贵

**面试话术**：
> "当前聊天历史窗口只有 4 轮，DB 索引查询 < 1ms，加缓存的收益不足以覆盖一致性维护的成本。
> 但如果窗口扩大到几十轮、或并发上千、或历史需要预处理（摘要/向量化），
> 就应该用 Redis Hash 缓存对话历史，TTL 30 分钟，写时同步更新缓存。
> 核心判断标准是：**缓存省下的时间 > 维护缓存一致性的成本**。"

---

## Step 8：知识库重建迁移 Arq（替换 asyncio.create_task）

> 当前知识库重建用 `asyncio.create_task` + 子进程，存在三个问题：
> 1. **火后不管**：API 进程重启 → 任务丢失，没有重试
> 2. **无进度追踪**：前端只能通过文件锁判断"是否在运行"，不知道进度
> 3. **无任务历史**：完成后没有记录，不知道上次重建是什么时候、耗时多久
>
> 迁移到 Arq 后，自动获得持久化 + 重试 + 状态查询能力。模式和 YOLO 任务完全相同。

**新建 `app/tasks/knowledge_task.py`**：

```python
"""
知识库重建异步任务（Arq Worker 执行）。

和 yolo_task.py 同理：
  - 耗时操作不在 API 进程执行
  - 通过 Redis 队列入队，Worker 独立进程消费
  - 崩溃自动重试，任务状态可查询
"""

import asyncio
import logging
import os
import sys
import time

from app.core.config import settings

logger = logging.getLogger(__name__)

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


async def run_knowledge_rebuild(
    ctx: dict,
    mode: str = "full",
    doc_keys: list[str] | None = None,
    chunk_config: dict | None = None,
    chunk_config_id: int | None = None,
) -> dict:
    """
    执行知识库重建（和原来的 trigger_build_knowledge 逻辑相同）。

    区别：
    - 原来：asyncio.create_task → fire-and-forget → 没有重试
    - 现在：Arq Worker 执行 → 持久化 + 重试 + 状态查询
    """
    timeout = settings.KNOWLEDGE_BUILD_TIMEOUT_S
    source_dir = str(settings.KNOWLEDGE_DIR)

    env = dict(os.environ)
    env["KNOWLEDGE_DIR"] = source_dir
    if chunk_config:
        for key, value in chunk_config.items():
            env[f"CHUNK_{key.upper()}"] = str(value)

    cmd = [sys.executable, "build_knowledge.py", f"--mode={mode}"]
    if mode == "incremental" and doc_keys:
        cmd.append(f"--doc-keys={','.join(doc_keys)}")
    if chunk_config_id:
        cmd.append(f"--chunk-config-id={chunk_config_id}")

    logger.info("知识库重建开始 mode=%s cmd=%s", mode, cmd)
    start = time.perf_counter()

    process = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=BACKEND_DIR,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        process.kill()
        raise RuntimeError(f"知识库重建超时 ({timeout}s)") from None

    elapsed = round(time.perf_counter() - start, 1)

    if process.returncode != 0:
        error_msg = stderr.decode().strip()[-500:]  # 取最后 500 字符
        logger.error("知识库重建失败 code=%d stderr=%s", process.returncode, error_msg)
        raise RuntimeError(f"知识库重建失败: {error_msg}")

    logger.info("知识库重建完成 mode=%s elapsed=%.1fs", mode, elapsed)
    return {"mode": mode, "elapsed": elapsed, "returncode": 0}
```

**修改 `app/worker.py`** — 注册新任务：

```python
from app.tasks.knowledge_task import run_knowledge_rebuild

class WorkerSettings:
    functions = [run_yolo_detection, run_knowledge_rebuild]  # 新增
    # ... 其余不变 ...
```

**修改 `app/routers/knowledge.py`** — 入队替代 create_task：

```python
# 原来（fire-and-forget，无重试无追踪）：
# asyncio.create_task(
#     knowledge_service.trigger_build_knowledge(mode="full", ...)
# )

# 改为（Arq 入队，持久化 + 重试 + 可查询）：
from app.core.redis import get_arq_redis

arq = get_arq_redis()
job = await arq.enqueue_job(
    "run_knowledge_rebuild",
    mode="full",
    chunk_config=config_dict,
    chunk_config_id=used_config_id,
    _job_id=f"rebuild_{mode}",  # 固定 job_id → 防止重复入队
)
```

**你需要回答自己的问题**：

1. **为什么 `_job_id` 设为固定值 `rebuild_full`？**
   - Arq 的 `_job_id` 如果重复，入队会被拒绝（去重）
   - 知识库重建同一时刻只能跑一个 → 固定 ID 天然实现了并发防护
   - 效果等同于原来的文件锁（`fcntl.flock`），但更简洁
   - **面试点**："Arq 的 job_id 去重机制可以替代分布式锁实现任务单例。"

2. **原来的子进程方式还需要保留吗？**
   - `trigger_build_knowledge` 函数可以保留作为底层实现
   - 但调用方从 `asyncio.create_task` 改为 `arq.enqueue_job`
   - 或者直接把子进程逻辑移到 `run_knowledge_rebuild` 里（当前方案）

---

## Day 9 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 确保 Redis 运行
docker exec redis redis-cli -a changeme_dev ping  # → PONG

# 3. 启动 API（终端 1）
uv run uvicorn app.main:app --reload --port 8000
# 日志应该看到：
# "Arq Redis 连接池已创建"
# "Redis 通用连接池已创建"

# 4. 启动 Worker（终端 2）
uv run arq app.worker.WorkerSettings
# 日志应该看到：
# "Arq Worker 启动..."
# "YOLO 模型加载完成"

# 5. Arq 任务队列验证：

# a) 上传图片
#    POST /api/tasks/upload
#    API 终端日志：YOLO 任务已入队 task_id=1 job_id=yolo_1
#    Worker 终端日志：开始 YOLO 推理 task_id=1 → 推理成功

# b) 轮询任务状态
#    GET /api/tasks/1
#    progressing → 几秒后 → completed + 检测结果

# c) 查 Arq Job 状态
#    GET /api/tasks/1/job-status
#    job_status=complete, job_result={...}

# d) 验证重试：
#    把 YOLO 模型路径改错 → 上传图片 → Worker 日志显示失败+重试
#    改回正确路径 → 重启 Worker → 不需要重新上传，Redis 中的任务会被重新消费

# 6. Redis 缓存验证：

# a) 上传图片并等待检测完成
#    GET /api/tasks/1 → 返回 completed
#    docker exec redis redis-cli -a changeme_dev GET task:result:1
#    应该看到缓存的 JSON 数据

# 7. 限流验证：

# a) 快速连续发 21 次 POST /api/tasks/upload
#    前 20 次正常，第 21 次返回 429 "请求过于频繁"

# 8. JWT 黑名单验证：

# a) 登录获取 token
#    POST /api/auth/login → 拿到 access_token

# b) 用 token 访问受保护接口
#    GET /api/users/me → 200 正常

# c) 登出
#    POST /api/auth/logout（带 Authorization header）→ 204

# d) 再次用同一 token 访问
#    GET /api/users/me → 401 "无法验证凭据"

# 9. 分布式锁验证：

# a) 上传同一张图片两次（30 秒内）
#    第一次正常，第二次返回 409 "正在处理中，请勿重复提交"

# 10. Redis 中查看数据
docker exec -it redis redis-cli -a changeme_dev
# > KEYS *
# 应该能看到：
#   arq:job:yolo_1          — Arq 任务
#   task:result:1            — 任务缓存
#   ratelimit:1:upload       — 限流计数器
#   blacklist:abc123...      — JWT 黑名单（登出后才有）
#   lock:upload:1:md5hash    — 分布式锁（30 秒后自动消失）
```

---

## 文件写作顺序

```
1.  app/core/config.py         <- 改（加 Redis 配置，2 行）
2.  app/core/redis.py          <- 新建（连接管理 + parse_redis_settings）
3.  app/tasks/__init__.py      <- 新建（空文件，创建 tasks 包）
4.  app/tasks/yolo_task.py     <- 新建（YOLO 任务函数 + 缓存写入）
5.  app/tasks/knowledge_task.py <- 新建（知识库重建任务函数）
6.  app/worker.py              <- 新建（注册 yolo + knowledge 两个任务）
7.  app/core/rate_limit.py     <- 新建（限流函数）
8.  app/routers/task.py        <- 改（Arq 入队 + 缓存读取 + 限流 + 分布式锁）
9.  app/routers/auth.py        <- 改（登出端点 + 黑名单检查）
10. app/routers/chat.py        <- 改（加限流，1 行）
11. app/routers/knowledge.py   <- 改（Arq 入队替换 asyncio.create_task）
12. app/main.py                <- 改（lifespan 删 YOLO 加 Redis）
13. uv add redis arq           <- 安装依赖
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
> Redis 还承担了四个额外职责：
> Cache-Aside 模式缓存已完成的任务结果，减少 DB 查询；
> INCR + EXPIRE 固定窗口限流，防止单用户打满 GPU；
> JWT 黑名单实现真正的登出能力，TTL 等于 token 剩余有效期，自动清理；
> SET NX 分布式锁防止用户重复提交同一文件。
>
> 知识库重建也从 asyncio.create_task 迁移到 Arq，
> 利用 job_id 去重替代文件锁实现任务单例，获得了重试和状态查询能力。

---

# 附录：RAG 增强优化（Day 6~8 遗留问题）

> 以下优化不阻塞主流程学习，在完成 Day 9 核心内容后按需实现。
> 按重要性排序：Step A（最高优先）→ Step D（最低优先）。

---

## RAG 增强 Step A：多轮对话 Query 改写

**问题**：当前 `build_augmented_query` 只附加 YOLO 标签，不处理代词和省略。

```
用户第 1 轮：风电叶片腐蚀怎么修复？
用户第 2 轮：那需要停机多久？
           ↓ 原始写法发给检索器的是「那需要停机多久？」
           → 无主语，BGE-M3 无法命中相关文档 → top_score 极低 → 走 fallback
```

**设计思路**：

```
原始 question（用于构建 Prompt，保持用户意图）
       ↓ 只在有 chat_window 时
rewrite_conversational_query()   ← 轻量 LLM acomplete，8 秒超时
       ↓
retrieval_question（独立完整的查询，用于检索）
       ↓
build_augmented_query(retrieval_question, image_context)
       ↓
BGE-M3 向量检索
```

### Step A.1：在 `app/services/rag_service.py` 中新增改写函数

放在 `build_source` 之后：

```python
async def rewrite_conversational_query(
    question: str,
    chat_window: list[dict[str, str]],
) -> str:
    """
    多轮对话 Query 改写。

    当存在会话历史时，用轻量 LLM 调用把代词/省略补全为独立查询，
    让检索器能正确命中相关文档。

    设计决策：
    - 只在有 chat_window 时改写（首问通常已经完整，改写无意义）
    - 改写 prompt 要求"一句话，不解释"，防止 LLM 输出过长
    - 改写失败（异常 / 超时）→ 降级返回原始 question
    - 改写结果只用于检索，不用于生成 Prompt——即使改写有偏差，
      LLM 看到的仍是原始 question，不会影响回答质量

    示例：
        chat_window 末尾：
            user: "风电叶片腐蚀怎么修复？"
            assistant: "主要有打磨、填充、涂层三个步骤..."
        question: "那需要停机多久？"
        → 改写为: "风电叶片腐蚀修复作业需要停机多久？"
    """
    if not chat_window:
        return question

    history_str = "\n".join(
        f"{'用户' if m['role'] == 'user' else '助手'}: {m['content'][:200]}"
        for m in chat_window[-4:]  # 最近 4 条，控制 context 开销
    )

    prompt = (
        f"对话历史：\n{history_str}\n\n"
        f"用户最新问题：{question}\n\n"
        "任务：将最新问题改写为无需上下文也能理解的独立检索查询。\n"
        "要求：一句话，不解释，不加任何前缀。\n"
        "如果最新问题本身已经完整（无代词、无省略），原样返回。"
    )

    try:
        resp = await asyncio.wait_for(
            LlamaSettings.llm.acomplete(prompt),
            timeout=8.0,  # 改写不能拖慢整体流程，硬限 8 秒
        )
        rewritten = (resp.text or "").strip()

        # 防御性检查：改写结果为空或异常长 → 降级
        if not rewritten or len(rewritten) > len(question) * 5:
            return question

        logger.info(
            "rag query_rewrite original=%.50s rewritten=%.50s",
            question, rewritten,
        )
        return rewritten

    except Exception:
        logger.warning("rag query_rewrite 失败，降级为原始 question", exc_info=True)
        return question
```

### Step A.2：在 `generate_chat_stream` 中接入

在 `# === [2] Query 增强 ===` 之前插入：

```python
                # === [1.5] 多轮 Query 改写（仅在有会话历史时执行）===
                # retrieval_question 只用于检索，Prompt 构建仍用原始 question
                retrieval_question = await rewrite_conversational_query(
                    question, chat_window or []
                )

                # === [2] Query 增强 ===
                # 注意：传入 retrieval_question（改写后）而非 question
                augmented_query = build_augmented_query(retrieval_question, image_context)
                logger.info(
                    "rag stage=query len=%d rewritten=%s",
                    len(augmented_query),
                    retrieval_question != question,  # True = 触发了改写
                )
```

> `_build_prompt` 中的 `question=question` 保持不变，传原始问题给 LLM。

**你需要回答自己的问题**：

1. **为什么改写 question 用于检索，但 Prompt 仍用原始 question？**
   - 改写的目标是让检索器命中文档，不是改变用户意图
   - 如果 Prompt 也用改写版 → LLM 回答的是改写后的问题，不是用户实际问的
   - 两者职责分离：改写 question 服务检索精度，原始 question 服务生成质量

2. **改写本身也调一次 LLM，不会让整体变慢吗？**
   - 改写用 `acomplete`（非流式），qwen3:14b 本地约 0.5~2 秒
   - 换来更准确的检索命中，避免"fallback 路由 → LLM 无上下文硬猜"的糟糕体验
   - 8 秒超时兜底，即使 LLM 卡住也不会阻塞整个请求
   - **面试话术**："多轮改写是以 ~1s 的延迟换取更高的检索命中率。这是典型的计算换质量权衡，在多轮对话场景下 ROI 很高。"

3. **首问（没有 chat_window）为什么不需要改写？**
   - 首问通常是完整的独立句子，无代词无省略
   - 强行改写首问反而可能引入偏差（LLM 改写并不总比原文好）
   - `if not chat_window: return question` 是正确的快速路径

4. **`len(rewritten) > len(question) * 5` 这个防御是什么？**
   - LLM 偶尔无视"一句话"的要求，输出多段解释
   - 检索 query 太长 → BGE-M3 最优输入约 512 token，超出后质量下降
   - 长度超过原问题 5 倍 → 改写失控 → 降级到原始 question

5. **除了 Query 改写，还有哪些多轮检索增强方案？**
   - **多查询扩展（Multi-Query）**：改写 2~3 个不同角度的 query，分别检索后 RRF 融合
   - **HyDE（Hypothetical Document Embeddings）**：让 LLM 先生成一段假设性答案，用答案的 embedding 做检索（命中率更高，但额外 LLM 调用成本更大）
   - Query 改写是三者中最轻量、最稳定的方案
   - **面试话术**："改写、多查询、HyDE 是三种主流多轮检索增强方案。改写最轻量，HyDE 命中率最高但成本高，多查询适合复杂问题分解。"

---

## RAG 增强 Step B：`build_knowledge.py` — 按文件类型选分块策略

**问题**：当前所有文件统一用 `SentenceSplitter`，无视格式差异。

```
Markdown 文件 → SentenceSplitter → 按字符数切块 → 破坏标题/列表结构
               应该用 → MarkdownNodeParser → 按标题层级切块 → 语义边界完整

PDF / 纯文本  → SentenceSplitter → 合理（连续文本，按句子边界即可）
```

**修改位置**：`build_knowledge.py`，文档加载和分块部分。

```python
from llama_index.core.node_parser import (
    MarkdownNodeParser,
    SentenceSplitter,
)


def get_node_parser(suffix: str, chunk_size: int, chunk_overlap: int):
    """
    根据文件后缀选择分块策略。

    Markdown：用 MarkdownNodeParser 保留标题层级和列表结构。
      - 按 # / ## / ### 标题边界切块 → 每块语义完整
      - 用户问"修复方案是什么" → 命中"## 修复方案"整节 → 回答更完整

    PDF / 其他：用 SentenceSplitter 按句子边界切块。
      - chunk_size 和 chunk_overlap 参考 config.py 中的默认值
      - overlap 确保跨块的句子在两块都出现（检索边界不丢失信息）
    """
    if suffix.lower() == ".md":
        return MarkdownNodeParser()
    else:
        return SentenceSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
        )


# 在文档处理循环中替换原来的硬编码分块：
for doc_path in docs_to_process:
    suffix = Path(doc_path).suffix
    parser = get_node_parser(
        suffix=suffix,
        chunk_size=chunk_config.get("chunk_size", 800),
        chunk_overlap=chunk_config.get("chunk_overlap", 150),
    )

    documents = SimpleDirectoryReader(input_files=[str(doc_path)]).load_data()
    nodes = parser.get_nodes_from_documents(documents)
    # ... 后续 embedding + 入库流程不变
```

**你需要回答自己的问题**：

1. **`MarkdownNodeParser` 比 `SentenceSplitter` 强在哪？**
   - `SentenceSplitter` 按字符数切块，可能把 `## 修复方案` 的标题和下面的正文切到不同块
   - `MarkdownNodeParser` 按标题边界切块，`## 修复方案` 整个小节在同一块
   - 检索时：用户问"修复方案是什么" → 命中该节完整内容 → 回答更准确

2. **`chunk_overlap=150` 为什么要有重叠？**
   - 切块时句子在块边界被截断，关键句子可能正好在两块之间
   - 重叠 150 字符 = 前一块的末尾 150 字符出现在后一块的开头
   - 被截断的句子在两块都能被检索到
   - **面试点**："chunk_overlap 是处理切块边界信息丢失的标准方案，代价是少量存储冗余。"

3. **为什么不用 Parent-Child 分块（小块检索，大块送 LLM）？**
   - 原理：检索时用小块（128 字符，精准命中），送 LLM 时用父块（512 字符，更多上下文）
   - 优点：检索精度和生成上下文质量两全
   - 缺点：需要存储父子关系，查询时额外取父块，实现复杂度高
   - 当前 chunk_size=800 是中等大小，兼顾了两者
   - **进阶方向**：如果发现回答质量因上下文太少不够好，升级到 Parent-Child retrieval

4. **`SentenceSplitter` 的 `chunk_size` 单位是 token 还是字符？**
   - LlamaIndex 的 `SentenceSplitter` 默认用 token 计数（基于 tiktoken）
   - 800 token ≈ 中文约 500~600 汉字 / 英文约 600 单词
   - **追问**：中文场景需要注意什么？（tiktoken 按 UTF-8 bytes 算 token，中文 1 字约 2~3 token。如果发现块太短，考虑调高 chunk_size）

---

## RAG 增强 Step C：检索可观测性增强（日志补充）

> 不需要新建文件，只在现有日志中补充结构化字段。

在 `generate_chat_stream` 末尾的 `stage=done` 日志中追加以下字段：

```python
total_ms = (time.perf_counter() - t0) * 1000
logger.info(
    "rag stage=done route=%s vision=%s sources=%d "
    "nodes_retrieved=%d nodes_after_security=%d "   # [新增] 安全过滤前后节点数对比
    "query_rewritten=%s "                            # [新增] 是否触发了 Query 改写
    "top_score=%s injection_score=%d ms=%.1f",
    route,
    use_vision,
    len(sources),
    len(nodes),          # reranker 后、安全过滤前的节点数
    len(context_nodes),  # 安全过滤后的节点数
    retrieval_question != question,  # True = 触发了改写（需要 Step A 的变量）
    f"{top_score:.4f}" if top_score is not None else "n/a",
    injection_score,
    total_ms,
)
```

**这几个字段能发现什么问题**：

| 字段 | 能发现的问题 |
|---|---|
| `nodes_retrieved` vs `nodes_after_security` | 安全过滤是否过于激进（剔除太多正常节点） |
| `query_rewritten=True` | 多轮改写触发比例，评估改写是否在正确场景工作 |
| `top_score` 长期低 | 知识库覆盖盲区（用户在问知识库里没有的内容） |
| `route=fallback` 比例高 | 知识库内容不够 OR 置信度阈值设得太严 |

**面试话术**："RAG 系统的阈值调优依赖可观测性。结构化日志记录每次检索的关键指标，长期汇总后能发现知识库盲区（top_score 分布）、安全过滤漂移（nodes 过滤比例）、多轮改写效果（rewritten 比例）。没有这些数据，阈值调整只能靠猜。"

---

## RAG 增强 Step D：增量重建性能说明（当前约束）

**当前设计的限制**（`build_knowledge.py` 子进程模式）：

每次增量重建，无论新增文档多少，都需要：

```
子进程启动：~1s
BGE-M3 模型从磁盘加载到内存：~20~40s（约 500MB 权重）
实际文档 embedding：~5s/文档
```

因此**不应该做"上传即自动触发增量重建"的逻辑**。

**推荐使用策略**：

```
合理触发方式：
  1. 批量上传 5~10 个文档后，管理员手动触发一次增量重建
  2. 通过 Day 9 的 Arq cron job 每天凌晨自动全量重建（最简单可靠）

在 Day 9 的 WorkerSettings 中启用定时全量重建（示意）：

  from arq import cron

  async def rebuild_knowledge_nightly(ctx: dict) -> None:
      """每天凌晨 3 点触发全量重建。"""
      import subprocess
      subprocess.run(["uv", "run", "python", "build_knowledge.py", "--mode", "full"])

  class WorkerSettings:
      ...
      cron_jobs = [
          cron(rebuild_knowledge_nightly, hour=3, minute=0),
      ]
```

**长期优化方向**（当前阶段不需要实现）：

```
当前：API → 触发子进程 → 进程内重载 BGE-M3（每次 ~30s）

长期：
  API → 入队 embedding 任务（Redis）
     → Embedding Worker（常驻进程，BGE-M3 常驻内存）
     → 处理任务（无模型加载开销，~5s/文档）
     → 写入 pgvector
```

**面试话术**："当前 build_knowledge.py 是独立子进程，每次都重新加载 BGE-M3，适合批量处理和定时任务，不适合频繁增量更新。生产级方案是把 Embedding 做成常驻 Worker——模型常驻内存，任务通过 Redis 队列分发，消除每次的模型加载开销。"
