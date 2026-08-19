# Redis 面试知识体系 — 从原理到项目实战

> 本文档面向面试准备，涵盖 Redis 核心原理与本项目（风电运维平台）中的实际应用。
> 每个知识点力求讲透：**是什么 → 为什么需要 → 底层原理 → 项目中怎么用的**。
>
> 审校状态（2026-04-03）：
> - 当前仓库里 Redis 的真实落地点主要是：JWT 黑名单、限流、上传/聊天分布式锁、Arq/业务连接池
> - 文中涉及 `Short Token + Refresh Token` 的部分属于**改进方向 / 扩展设计**，不能讲成当前仓库已落地能力
> - 面试时优先讲当前代码里的黑名单、限流、锁和连接池，再讲 refresh token 作为升级方案

---

## 一、Redis 基础

### 1.1 什么是 Redis？为什么叫「Remote Dictionary Server」？

**Redis = Remote Dictionary Server（远程字典服务）。**

这个名字精确概括了它的本质：
- **Remote**：它是一个独立的网络服务进程，客户端通过 TCP 连接访问，而不是嵌入到应用进程内部。这与 SQLite（嵌入式数据库）形成对比。
- **Dictionary**：它的核心数据模型是 **Key-Value 字典**。所有数据都通过 key 索引，key 是字符串，value 可以是多种数据结构（String、Hash、List、Set、Sorted Set 等）。
- **Server**：它是一个服务端程序，监听端口（默认 6379），接受客户端的命令请求，执行后返回结果。

**一句话定义**：Redis 是一个基于内存的高性能 Key-Value 数据结构存储系统，可以用作数据库、缓存和消息中间件。

### 1.2 Redis 的核心特点

#### (1) 内存存储（In-Memory）

Redis 的所有数据都存储在内存中。这是它快的根本原因。

- 内存读写速度：**~100ns**（纳秒级）
- 磁盘读写速度：SSD ~100μs，HDD ~10ms
- 差距：**内存比磁盘快 1000~100000 倍**

但内存是易失的（断电丢数据），所以 Redis 提供了持久化机制（RDB/AOF）来保证数据安全。

#### (2) 单线程模型

Redis 6.0 之前，**核心命令执行是严格单线程的**。这里需要精确理解：

- **单线程指的是**：命令的解析和执行在一个线程中串行完成
- **不是说整个 Redis 进程只有一个线程**：后台持久化（bgsave）、异步删除（unlink）、集群通信等都有独立线程

为什么用单线程？
1. **避免锁竞争**：多线程操作共享数据需要加锁，锁的开销可能抵消多线程带来的性能提升
2. **避免上下文切换**：线程切换本身有 CPU 开销
3. **代码简单可靠**：不需要考虑并发安全问题，bug 更少
4. **瓶颈不在 CPU**：Redis 的瓶颈在内存和网络 I/O，不在 CPU 计算

> **面试关键点**：Redis 6.0 引入了多线程 I/O（`io-threads`），但**命令执行仍然是单线程的**。多线程只用于网络读写（read/write 系统调用），核心的命令处理逻辑没有变。

#### (3) I/O 多路复用（I/O Multiplexing）

这是 Redis 单线程却能处理大量并发连接的关键技术。

**问题**：如果 Redis 是单线程，怎么同时处理几万个客户端连接？

**答案**：使用操作系统提供的 I/O 多路复用机制（Linux 上是 `epoll`，macOS 上是 `kqueue`）。

**原理**：
```
传统阻塞 I/O：
  线程1 → 等待客户端A数据 → 阻塞... → 收到数据 → 处理
  线程2 → 等待客户端B数据 → 阻塞... → 收到数据 → 处理
  （每个连接需要一个线程，1万连接就需要1万个线程）

I/O 多路复用：
  单线程 → epoll 监控所有连接 → 哪个连接有数据就处理哪个 → 处理完继续监控
  （一个线程就能处理所有连接）
```

**epoll 工作流程**：
1. 将所有客户端 socket 注册到 epoll 实例
2. 调用 `epoll_wait()`，线程阻塞等待
3. 当任意 socket 有数据可读时，`epoll_wait()` 返回就绪的 socket 列表
4. 依次处理这些 socket 上的命令
5. 回到步骤 2

**关键概念区分**：
- **select**：轮询所有 fd，O(n) 复杂度，最大 1024 个 fd → 淘汰
- **poll**：改进 select，无 fd 数量限制，但仍是 O(n) 轮询 → 淘汰
- **epoll**：事件驱动，O(1) 复杂度，只返回就绪的 fd → Linux 标准方案
- **kqueue**：BSD/macOS 的等价方案

### 1.3 Redis 为什么这么快？

面试必答的 4 个原因（按重要性排序）：

| 序号 | 原因 | 说明 |
|------|------|------|
| 1 | **纯内存操作** | 所有数据在内存中，读写都是内存操作，纳秒级延迟 |
| 2 | **I/O 多路复用** | 单线程通过 epoll 高效处理大量并发连接 |
| 3 | **单线程无锁** | 避免多线程的锁竞争、上下文切换开销 |
| 4 | **高效数据结构** | 内部使用 SDS、ziplist、quicklist、skiplist、intset 等优化结构 |

**量化指标**：单机 Redis 通常可以达到 **10~15 万 QPS**（GET/SET 操作），这已经远超大多数应用的需求。

### 1.4 Redis 的数据结构

Redis 有 **5 种基础数据结构** + 几种特殊类型。面试中必须能说出每种结构的典型使用场景。

#### (1) String（字符串）

**底层实现**：SDS（Simple Dynamic String），不是 C 语言原生字符串。

SDS 相比 C 字符串的优势：
- 保存了字符串长度，`strlen` 是 O(1) 而不是 O(n)
- 二进制安全（可以存储任意二进制数据，不像 C 字符串遇到 `\0` 就截断）
- 预分配空间，减少内存重分配次数

**常用命令**：`SET`、`GET`、`INCR`、`DECR`、`SETNX`、`SETEX`、`MGET`、`MSET`

**使用场景**：
- 缓存：存储序列化后的对象（如 JSON）
- 计数器：`INCR` 实现原子计数（如本项目的速率限制）
- 分布式锁：`SET key value NX EX`（如本项目的防重复提交）
- Token 黑名单：`SET blacklist:hash 1 EX ttl`（如本项目的 JWT 登出）
- 分布式 Session

**项目实际使用**：
```python
# 速率限制 — INCR 原子计数
current = await r.incr(key)  # key 不存在时创建并设为 1，存在时 +1

# 分布式锁 — SET NX EX
acquired = await r.set(lock_key, "1", nx=True, ex=30)

# Token 黑名单 — SET EX
await r.set(f"blacklist:{token_hash}", "1", ex=remaining)

# 任务缓存 — SET EX + JSON 序列化
await r.set(f"task:result:{task_id}", json.dumps(data), ex=3600)
```

#### (2) Hash（哈希）

**底层实现**：当元素少且值短时用 ziplist（紧凑编码），否则用 hashtable。

**常用命令**：`HSET`、`HGET`、`HMSET`、`HMGET`、`HGETALL`、`HDEL`、`HINCRBY`

**使用场景**：
- 存储对象属性：`HSET user:1001 name "张三" age 25 role "admin"`
- 购物车：`HSET cart:user_id product_id quantity`
- 统计信息：每个字段可以独立更新

**Hash vs String 存储对象的区别**：
| 方式 | 读取单个字段 | 更新单个字段 | 内存占用 |
|------|-------------|-------------|---------|
| String + JSON | 需要反序列化整个 JSON | 需要读取 → 修改 → 写回 | 较大（JSON 有冗余字符）|
| Hash | `HGET` 直接取字段 | `HSET` 直接改字段 | 较小（ziplist 编码时） |

#### (3) List（列表）

**底层实现**：quicklist（ziplist 组成的双向链表）。

**常用命令**：`LPUSH`、`RPUSH`、`LPOP`、`RPOP`、`LRANGE`、`LLEN`、`BRPOP`（阻塞弹出）

**使用场景**：
- 消息队列：`LPUSH` 入队 + `BRPOP` 阻塞出队
- 最新消息列表：`LPUSH` 添加新消息 + `LRANGE 0 9` 取最新 10 条
- 时间线（Timeline）：微博/朋友圈的 Feed 流

#### (4) Set（集合）

**底层实现**：当元素都是整数且数量少时用 intset，否则用 hashtable。

**常用命令**：`SADD`、`SREM`、`SMEMBERS`、`SISMEMBER`、`SINTER`（交集）、`SUNION`（并集）、`SDIFF`（差集）

**使用场景**：
- 标签系统：`SADD post:1:tags "Redis" "面试"`
- 共同好友：`SINTER user:A:friends user:B:friends`
- 去重：利用 Set 元素唯一性
- 抽奖：`SRANDMEMBER`、`SPOP`

#### (5) Sorted Set（有序集合，ZSet）

**底层实现**：skiplist（跳跃表）+ hashtable。

**跳跃表原理**：
```
Level 3:  1 ────────────────────── 9
Level 2:  1 ──────── 5 ──────── 9
Level 1:  1 ── 3 ── 5 ── 7 ── 9
```
- 每个节点随机决定层数（类似二叉搜索树的平衡）
- 查找、插入、删除的平均时间复杂度都是 O(log n)
- 比红黑树实现更简单，范围查询更高效

**常用命令**：`ZADD`、`ZREM`、`ZSCORE`、`ZRANK`、`ZRANGE`、`ZREVRANGE`、`ZRANGEBYSCORE`

**使用场景**：
- 排行榜：`ZADD leaderboard score player_name`
- 延迟队列：score 设为执行时间戳，轮询取 score < now 的任务
- 滑动窗口限流：score 设为请求时间戳

### 1.5 Redis 持久化：RDB vs AOF

Redis 是内存数据库，但提供两种持久化机制来防止数据丢失。

#### RDB（Redis Database）— 快照

**原理**：在某个时间点，将内存中的所有数据生成一个快照（snapshot），写入磁盘（dump.rdb 文件）。

**触发方式**：
1. **手动触发**：`SAVE`（阻塞主线程，生产禁用）或 `BGSAVE`（后台 fork 子进程执行）
2. **自动触发**：配置 `save 60 1000`（60 秒内有 1000 次写操作就触发 BGSAVE）

**BGSAVE 的 fork + COW 机制**：
1. 主进程调用 `fork()` 创建子进程
2. 子进程与主进程共享相同的物理内存页（Copy-On-Write）
3. 子进程遍历内存数据，写入 RDB 文件
4. 如果主进程在此期间修改了某个数据页，操作系统会复制该页（COW），子进程仍然读到旧数据
5. 子进程完成后，用新 RDB 文件替换旧文件

**优点**：
- 文件紧凑，适合备份和灾难恢复
- 恢复速度快（直接加载二进制文件）
- fork 子进程做持久化，不影响主线程性能

**缺点**：
- 可能丢失最后一次快照到崩溃之间的数据（分钟级别的数据丢失）
- 大数据量时 fork 操作可能短暂阻塞主线程（需要复制页表）

#### AOF（Append Only File）— 追加日志

**原理**：将每一条写命令追加到 AOF 文件末尾。恢复时重新执行所有命令。

**三种刷盘策略**（fsync）：
| 策略 | 含义 | 数据安全性 | 性能 |
|------|------|-----------|------|
| `always` | 每条命令都 fsync | 最高（最多丢 1 条命令） | 最差 |
| `everysec` | 每秒 fsync 一次 | 较高（最多丢 1 秒数据） | 推荐折中 |
| `no` | 由操作系统决定何时 fsync | 最低 | 最好 |

**AOF 重写（Rewrite）**：
- AOF 文件会越来越大（记录了所有历史写命令）
- Redis 定期执行 AOF 重写：fork 子进程，根据当前内存状态生成最精简的命令集
- 例如：对同一个 key 执行了 100 次 SET，重写后只保留最后一次
- 重写期间新命令写入"重写缓冲区"，重写完成后追加到新 AOF 文件

**优点**：
- 数据安全性高（默认每秒刷盘，最多丢 1 秒数据）
- AOF 文件是人类可读的纯文本（方便排查问题）
- AOF 重写机制控制文件大小

**缺点**：
- AOF 文件通常比 RDB 文件大
- 恢复速度比 RDB 慢（需要重放所有命令）

#### 为什么项目中用 `--appendonly yes`？

在项目的 `docker-compose.yml` 中：

```yaml
redis:
  image: redis:7-alpine
  restart: unless-stopped
  command: redis-server --requirepass ${REDIS_PASSWORD:?请在 .env 中设置 REDIS_PASSWORD} --appendonly yes
  volumes:
    - redis_data:/data
```

原因：
1. **`--appendonly yes` 开启 AOF 持久化**：默认的刷盘策略是 `everysec`（每秒一次），最多丢失 1 秒数据
2. **为什么不用 RDB？** RDB 的默认策略是几分钟触发一次，如果容器意外重启，会丢失几分钟的数据
3. **项目中 Redis 存储了什么关键数据？**
   - Token 黑名单（丢失 = 已登出的用户 token 可以继续使用）
   - 速率限制计数器（丢失 = 限流重置，影响不大）
   - 分布式锁状态（丢失 = 锁释放，可能允许重复操作）
   - 任务缓存（丢失 = 回源数据库，无数据丢失）
   - Arq 任务队列（丢失 = 正在排队的任务丢失，需要重新提交）
4. **数据卷挂载 `redis_data:/data`**：确保容器删除/重建后 AOF 文件不丢失。**如果不挂载数据卷，AOF 等于没开——容器删了数据也跟着丢。**

> **面试加分点**：生产环境通常 RDB + AOF 同时开启。RDB 用于冷备和快速恢复，AOF 保证数据安全。恢复时优先加载 AOF（数据更完整）。

---

## 二、Redis 连接管理

### 2.1 连接池（Connection Pool）的概念和必要性

**什么是连接池？**

连接池是一个预先创建好的、可复用的网络连接集合。应用程序需要操作 Redis 时，从池中借一个连接，用完归还，而不是每次新建连接。

**为什么需要连接池？**

每次新建 TCP 连接的代价：
```
客户端                    Redis 服务器
   |--- SYN --------→|
   |←--- SYN+ACK ----|       TCP 三次握手：~1-3ms
   |--- ACK --------→|
   |--- 命令 --------→|
   |←--- 响应 --------|
   |--- FIN --------→|       TCP 四次挥手
   |←--- FIN+ACK ----|
```

- 每次操作新建 TCP 连接 → 建连耗时 1-3ms → 高频操作累积开销巨大
- 如果每秒 1000 次 Redis 操作，每次都新建连接 → 1-3 秒浪费在建连上
- 连接池复用已有连接 → 0 建连开销，直接发命令

**类比**：数据库连接池（SQLAlchemy 的 `create_async_engine` 也内置了连接池）

### 2.2 连接池的关键参数

| 参数 | 含义 | 设置建议 |
|------|------|---------|
| `max_connections` | 连接池最大连接数 | 根据并发量设置，通常 10-50 |
| `timeout` | 获取连接的超时时间 | 不宜太长，建议 5-10 秒 |
| `decode_responses` | 是否自动将 bytes 解码为 str | 缓存场景建议 True |

### 2.3 项目中的双连接池设计

本项目使用了 **两个独立的 Redis 连接池**，这是一个重要的架构决策。

#### 源码分析（`app/core/redis.py`）

```python
# 全局arq连接（用于入队）
_arq_pool: ArqRedis | None = None
# 全局redis连接（用于缓存等通用操作）
_redis_pool: redis.ConnectionPool | None = None
```

**为什么需要两个连接池？**

1. **ArqRedis 连接池**（`_arq_pool`）：
   - 用途：通过 Arq 将任务入队到 Redis 队列
   - 由 `arq.create_pool()` 创建，内部维护自己的连接管理
   - 使用 Arq 特定的协议格式（键前缀 `arq:queue:*`、`arq:job:*`）

2. **通用 Redis 连接池**（`_redis_pool`）：
   - 用途：缓存、速率限制、分布式锁、Token 黑名单等业务操作
   - 由 `redis.ConnectionPool.from_url()` 创建
   - 配置了 `max_connections=10` 和 `decode_responses=True`

**连接池隔离的好处**：

| 维度 | 共享连接池 | 隔离连接池 |
|------|----------|----------|
| 资源竞争 | 高并发入队任务可能耗尽所有连接，导致缓存查询超时 | 各自独立，互不影响 |
| 故障隔离 | 一个模块出问题影响所有模块 | 隔离故障爆炸半径 |
| 配置灵活性 | 只能用一套配置 | 可以分别优化（如不同的 max_connections、timeout） |
| 监控 | 难以区分连接来源 | 可以独立监控每个池的使用情况 |

**连接的创建与销毁（生命周期管理）**：

```python
# FastAPI lifespan 启动时初始化
async def init_redis() -> None:
    global _arq_pool, _redis_pool
    _arq_pool = await create_pool(parse_redis_settings())
    _redis_pool = redis.ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        decode_responses=True,
    )

# FastAPI lifespan 关闭时释放
async def close_redis() -> None:
    global _arq_pool, _redis_pool
    if _arq_pool:
        await _arq_pool.aclose()
        _arq_pool = None
    if _redis_pool:
        await _redis_pool.aclose()
        _redis_pool = None
```

在 `app/main.py` 的 lifespan 中调用：

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ...
    await init_redis()   # 启动时初始化
    yield
    await close_redis()  # 关闭时释放
```

> **面试关键点**：连接池的初始化和关闭必须在应用的 lifespan 中管理。如果不显式关闭连接池，会导致连接泄漏——Redis 服务端会积累大量空闲连接，最终触发 `maxclients` 限制。

### 2.4 Redis URL 解析

项目中 Redis 连接 URL 的格式：

```
redis://:${REDIS_PASSWORD}@redis:6379/0
```

- `redis://`：协议前缀
- `:${REDIS_PASSWORD}`：认证密码（用户名为空，所以冒号前没有内容）
- `@redis`：主机名（Docker 网络中 Redis 容器的服务名）
- `:6379`：端口
- `/0`：数据库编号（Redis 默认有 16 个数据库，0-15）

解析代码：

```python
def parse_redis_settings() -> RedisSettings:
    parsed = urlparse(settings.REDIS_URL)
    return RedisSettings(
        host=parsed.hostname or "localhost",
        port=parsed.port or 6379,
        database=int(parsed.path.lstrip("/") or "0"),
        password=parsed.password,
    )
```

### 2.5 Worker 进程的连接管理

Arq Worker 是一个独立进程（不是 FastAPI 的一部分），它有自己的 Redis 连接：

```python
# app/worker.py
class WorkerSettings:
    redis_settings = parse_redis_settings()  # Worker 自己的连接配置
```

**为什么 Worker 和 API 进程需要分开的连接？**

- Worker 是通过 `uv run arq app.worker.WorkerSettings` 启动的独立进程
- 它有自己的内存空间，无法访问 API 进程中的 `_arq_pool` 和 `_redis_pool`
- Worker 内部 Arq 框架会自动创建自己的 Redis 连接来监听队列

```
Docker 网络拓扑：

  ┌──────────────┐     ┌──────────────┐
  │ Backend API  │     │  Arq Worker  │
  │              │     │              │
  │ _arq_pool ───┼──→  │              │
  │ _redis_pool ─┼──→  │ (Arq 内部    │
  │              │  │  │  连接池) ────┼──→ ┌───────┐
  └──────────────┘  │  └──────────────┘    │ Redis │
                    └──────────────────────→│  :6379│
                                           └───────┘
```

---

## 三、分布式锁

### 3.1 为什么需要分布式锁？

**场景**：在单机应用中，用 Python 的 `threading.Lock` 或 `asyncio.Lock` 就能保护临界资源。但在分布式架构中（多个 API 实例、多个 Worker 进程），进程级别的锁无法跨进程生效。

**本项目的具体问题**：
1. **防止重复上传**：用户快速双击上传按钮，可能同时发出两个请求到不同的 API 实例，如果没有分布式锁，同一张图片可能被处理两次
2. **防止并发对话**：同一用户同时发起两个聊天请求，可能导致会话上下文混乱

**分布式锁的需求**：
- 互斥性：同一时刻只有一个客户端能持有锁
- 无死锁：即使持有锁的客户端崩溃，锁也能在一定时间后自动释放
- 容错性：Redis 节点正常运行就能提供锁服务

### 3.2 Redis 实现分布式锁的原理

核心命令：**`SET key value NX EX seconds`**

```
SET lock:upload:user1:abc123 "1" NX EX 30
```

**逐个参数解释**：

| 参数 | 含义 | 作用 |
|------|------|------|
| `lock:upload:user1:abc123` | key 名称 | 唯一标识这把锁（用户 ID + 文件 hash） |
| `"1"` | value | 简单场景用固定值，高级场景用 UUID 标识持有者 |
| `NX` | Not eXists | **只有当 key 不存在时才设置成功**，这是互斥性的保证 |
| `EX 30` | Expire 30 seconds | 设置过期时间 30 秒，防止死锁 |

**为什么 NX 和 EX 必须是原子操作？**

如果分成两步：
```python
# 错误写法！非原子！
if await r.setnx(key, "1"):      # 第 1 步：设置 key（如果不存在）
    await r.expire(key, 30)       # 第 2 步：设置过期时间
```

**竞态条件**：
1. 客户端 A 执行 `setnx` 成功
2. 客户端 A 在执行 `expire` 之前崩溃
3. 这个 key 永远不会过期 → **死锁**

`SET NX EX` 是一条命令，Redis 单线程串行执行，天然原子——要么 key 不存在且设置成功（同时带上过期时间），要么 key 已存在则什么都不做。

### 3.3 项目中分布式锁的应用

#### 场景一：防重复上传（`app/routers/task.py`）

```python
# 计算文件 MD5 hash
file_hash = hashlib.md5(content).hexdigest()
lock_key = f"lock:upload:{current_user.id}:{file_hash}"

# SET NX: key不存在时设置成功并返回True，存在时返回False
acquired = await r.set(lock_key, "1", nx=True, ex=30)
if not acquired:
    raise HTTPException(
        status_code=409,
        detail=f"文件{file.filename}正在处理中，请勿重复提交",
    )
```

**设计要点**：
- **key 设计**：`lock:upload:{user_id}:{file_hash}`，精确到用户 + 文件内容
  - 不同用户上传同一文件不互斥（各自独立的任务）
  - 同一用户上传不同文件不互斥（并行处理不同任务）
  - 只有同一用户上传同一文件才互斥（防重复提交）
- **过期时间 30 秒**：正常处理流程不超过 30 秒，即使服务崩溃锁也会自动释放
- **返回 409 Conflict**：HTTP 语义正确——客户端重复提交资源

#### 场景二：防并发对话（`app/routers/chat.py`）

```python
lock_key = f"lock:chat:{current_user.id}"
acquired = await r.set(lock_key, "1", ex=120, nx=True)
if not acquired:
    raise HTTPException(status_code=409, detail="上一条消息还在生成中，请稍后")
```

**设计要点**：
- **key 设计**：`lock:chat:{user_id}`，一个用户同时只能有一个进行中的对话
- **过期时间 120 秒**：LLM 生成可能较慢，给足时间
- **手动释放**：正常流程结束后主动删除锁

```python
# 在 finally 块中释放锁
finally:
    await r.delete(lock_key)
```

**为什么要手动释放？** 如果等 120 秒自然过期，用户在这段时间内无法发起新对话。主动释放可以让用户立即发送下一条消息。

### 3.4 锁的过期时间设置

过期时间的设置是一个两难问题：

| 问题 | 太短 | 太长 |
|------|------|------|
| 场景 | 业务还没执行完，锁就过期了 | 持有锁的进程崩溃后，其他进程要等很久 |
| 后果 | 其他客户端获取到锁，两个客户端同时操作 → 数据不一致 | 服务降级，用户体验差 |
| 解决方案 | 看门狗（Watchdog）续期 | 设置合理超时 + 主动释放 |

**看门狗机制（Redisson 的方案）**：
- 获取锁时启动一个后台线程
- 每隔锁超时时间的 1/3，检查业务是否还在执行
- 如果还在执行，就自动续期
- 如果进程崩溃，后台线程也死了，锁自然过期

本项目没有实现看门狗，而是采用了更简单的策略：**设置足够长的超时 + 业务完成后主动删除**。

### 3.5 防止误删别人的锁

**问题场景**：

```
时间线：
t1: 客户端 A 获取锁（过期时间 30s）
t2: 客户端 A 执行业务...（执行了 31 秒）
t3: 锁自动过期（A 不知道锁已经过期）
t4: 客户端 B 获取锁（成功，因为锁已过期）
t5: 客户端 A 业务完成，执行 DELETE lock_key
t6: 客户端 A 删掉了客户端 B 的锁！
t7: 客户端 C 获取锁（成功，因为 B 的锁被 A 误删了）
→ B 和 C 同时持有"锁" → 互斥性被破坏
```

**解决方案**：value 中存储持有者的唯一标识（通常是 UUID），释放锁时先检查 value 是否匹配。

```python
import uuid

lock_value = str(uuid.uuid4())  # 唯一标识
acquired = await r.set(lock_key, lock_value, nx=True, ex=30)

# 释放锁时 — 必须用 Lua 脚本保证原子性
release_script = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""
await r.eval(release_script, 1, lock_key, lock_value)
```

**为什么释放锁要用 Lua 脚本？**

如果分成两步（GET + DEL）：
```python
# 错误写法！
if await r.get(lock_key) == lock_value:  # 步骤1: 检查
    await r.delete(lock_key)              # 步骤2: 删除
```
在步骤 1 和步骤 2 之间，锁可能刚好过期，另一个客户端获取了新锁，然后步骤 2 删掉了新锁。

Lua 脚本在 Redis 中是原子执行的（单线程，脚本执行期间不会穿插其他命令）。

> **本项目的简化处理**：项目中 value 固定为 `"1"`，直接 `delete` 释放。这在当前场景下是可以接受的，因为：
> - 对话锁的 120 秒超时远大于正常生成时间
> - 上传锁的 30 秒超时远大于文件保存时间
> - 但如果要做到严格正确，应该使用 UUID + Lua 脚本释放

### 3.6 Redlock 算法简介

**问题**：单个 Redis 实例挂了怎么办？

单机 Redis 做分布式锁有一个致命问题：Redis 本身是单点故障。如果 Redis 挂了，所有锁都失效。即使用了 Redis 主从复制，也有问题：

```
1. 客户端 A 在 Master 上获取锁
2. Master 把锁的 key 异步复制给 Slave（还没复制完）
3. Master 崩溃
4. Slave 晋升为新 Master（但没有锁的 key）
5. 客户端 B 在新 Master 上获取同一把锁（成功！）
→ A 和 B 同时持有锁 → 互斥性被破坏
```

**Redlock 算法**（Redis 作者 antirez 提出）：

1. 部署 N 个（通常 5 个）**完全独立**的 Redis 实例（不是主从）
2. 客户端依次向 N 个实例请求加锁
3. 如果在超过 N/2+1 个实例上加锁成功（即多数派），且总耗时小于锁的过期时间 → 加锁成功
4. 否则加锁失败，向所有实例释放锁

**争议**：Martin Kleppmann 在 2016 年发表了一篇文章批评 Redlock 的正确性（时钟跳跃问题）。如果面试官问到，可以提及这个争议，说明如果需要严格的分布式锁，应该使用 ZooKeeper 或 etcd。

> **本项目**：使用单机 Redis，没有用 Redlock。因为本项目的锁不保护资金等强一致性场景，偶尔的锁失效（如 Redis 重启导致锁丢失）只会导致一次重复操作，不会造成数据不一致。

---

## 四、速率限制（Rate Limiting）

### 4.1 为什么需要速率限制？

速率限制（也叫限流）的目的：
1. **防止滥用**：阻止恶意用户或脚本刷接口
2. **保护后端资源**：AI 推理（本项目的 YOLO 和 LLM）非常消耗 GPU/CPU，不限制会耗尽资源
3. **保证公平性**：防止单个用户占用所有资源，影响其他用户
4. **防止 DDoS**：超频请求直接拒绝，减少后端压力

### 4.2 四种经典限流算法

#### (1) 固定窗口（Fixed Window）

**原理**：
- 将时间划分为固定大小的窗口（如每 60 秒一个窗口）
- 每个窗口内维护一个计数器
- 请求到来时计数器 +1，超过阈值则拒绝
- 窗口结束时计数器重置为 0

```
|--- 窗口 1 (0-60s) ---|--- 窗口 2 (60-120s) ---|
| 请求计数: 1,2,3...10 | 请求计数: 1,2,3...     |
| 第11个请求被拒绝      | 计数器重置              |
```

**优点**：
- 实现简单，只需要一个计数器 + 过期时间
- 内存占用小

**缺点 — 临界问题（Critical Edge Problem）**：
```
|--- 窗口 1 (0:00-1:00) ---|--- 窗口 2 (1:00-2:00) ---|
|              ↑ 0:55 打了10个请求                       |
|                           ↑ 1:05 又打了10个请求        |
```
在 0:55~1:05 这 10 秒内，实际打了 20 个请求（窗口 1 的尾部 10 个 + 窗口 2 的头部 10 个），但每个窗口内都没超限。**实际速率是阈值的 2 倍。**

**适用场景**：对精度要求不高的场景（如本项目的 API 限流）

#### (2) 滑动窗口（Sliding Window）

**原理**：
- 不再使用固定的时间窗口边界
- 每次请求时，检查过去 N 秒内的请求数量
- 通常用 Redis Sorted Set 实现：score 是时间戳，value 是请求标识

```
任意时刻都看"过去60秒"的请求数：
  当前时间 t，计算 [t-60, t] 内的请求数
```

**Redis 实现**：
```
ZADD   rate:user:1   <timestamp>   <request_id>     # 添加请求记录
ZREMRANGEBYSCORE rate:user:1  0  <timestamp-60>      # 删除60秒前的记录
ZCARD  rate:user:1                                    # 统计当前窗口内的请求数
```

**优点**：解决了固定窗口的临界问题
**缺点**：
- 需要存储每个请求的时间戳，内存占用大
- 需要三条 Redis 命令（可以用 Lua 脚本合并）

#### (3) 漏桶（Leaky Bucket）

**原理**：
- 想象一个底部有小孔的桶
- 请求（水滴）以任意速率流入桶中
- 桶以**固定速率**从底部漏出（处理请求）
- 桶满了则溢出（拒绝请求）

```
       请求流入（任意速率）
         ↓ ↓ ↓ ↓ ↓
    ┌─────────────────┐
    │  ████████████    │  ← 桶（有容量上限）
    │  ██████████      │
    │  ████████        │
    └───────┬──────────┘
            ↓
    以固定速率流出（处理请求）
```

**优点**：
- 输出速率恒定，适合需要平滑流量的场景
- 能应对突发流量（桶起到缓冲作用）

**缺点**：
- 无法利用系统空闲时的处理能力（即使系统空闲，也只能以固定速率处理）
- 实现相对复杂

#### (4) 令牌桶（Token Bucket）

**原理**：
- 以**固定速率**向桶中添加令牌（token）
- 每个请求需要消耗一个令牌
- 桶满了则新生成的令牌被丢弃
- 没有令牌则拒绝请求

```
    令牌以固定速率生成
         ↓ ↓ ↓
    ┌─────────────────┐
    │  🪙🪙🪙🪙🪙     │  ← 桶（有令牌上限）
    │  🪙🪙🪙🪙       │
    └───────┬──────────┘
            ↓
    请求消耗令牌（有令牌就放行）
```

**优点**：
- 允许一定程度的突发流量（桶里攒了很多令牌时，可以一次性处理多个请求）
- 平均速率可控

**缺点**：
- 实现相对复杂

**四种算法对比**：

| 算法 | 实现复杂度 | 突发流量处理 | 精确性 | 内存占用 |
|------|----------|------------|--------|---------|
| 固定窗口 | 最简单 | 有临界问题 | 低 | 最小 |
| 滑动窗口 | 中等 | 精确控制 | 高 | 较大 |
| 漏桶 | 较高 | 平滑输出 | 高 | 中等 |
| 令牌桶 | 较高 | 允许突发 | 高 | 中等 |

### 4.3 项目中的速率限制实现

本项目使用的是 **固定窗口算法**，通过 Redis 的 `INCR` + `EXPIRE` 实现。

#### 源码分析（`app/core/rate_limit.py`）

```python
async def rate_limit(user_id: int, endpoint: str, limit: int = 10, window: int = 60) -> None:
    r = get_redis()
    key = f"ratelimit:{user_id}:{endpoint}"

    # INCR命令是原子操作，如果Key不存在则创建并设置为1，如果存在则增加1
    current = await r.incr(key)
    if current == 1:
        await r.expire(key, window)  # 设置过期时间，窗口结束后自动重置计数

    if current > limit:
        raise HTTPException(status_code=429, detail=f"请求过于频繁，请{window}秒后再试")
```

**逐行解析**：

1. **key 设计**：`ratelimit:{user_id}:{endpoint}`
   - 按用户 + 端点粒度限流
   - 用户 A 的上传限流不影响用户 B
   - 用户 A 的上传限流不影响用户 A 的聊天限流

2. **`INCR` 命令**：
   - 如果 key 不存在 → 创建 key，值设为 1，返回 1
   - 如果 key 存在 → 值 +1，返回新值
   - **原子操作**：即使多个请求并发到达，INCR 在 Redis 内部是串行执行的

3. **`EXPIRE` 只在 `current == 1` 时设置**：
   - 第一次请求时 key 不存在，INCR 创建了 key，此时设置过期时间
   - 后续请求 key 已存在，不需要重复设置过期时间
   - 注意：这里有一个竞态条件的风险（见下方分析）

4. **`current > limit` 时返回 429**：HTTP 429 Too Many Requests

**竞态条件分析**：

```python
current = await r.incr(key)   # 步骤 1
if current == 1:
    await r.expire(key, window)  # 步骤 2
```

如果步骤 1 执行完（key 被创建，值为 1），步骤 2 执行前进程崩溃了 → key 永远不会过期 → 这个用户的这个端点永远被限流。

**更安全的实现方案（Lua 脚本保证原子性）**：
```lua
local current = redis.call("INCR", KEYS[1])
if current == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
```

**但在本项目中这不是大问题**：即使出现这个极小概率的竞态，重启 Redis 或手动删除 key 即可恢复。权衡之下，简单实现的可维护性更重要。

**项目中的限流配置**：

| 端点 | 限制 | 窗口 | 说明 |
|------|------|------|------|
| `upload` | 20 次/分钟 | 60 秒 | 每分钟最多上传 20 张图片 |
| `chat_stream` | 10 次/分钟 | 60 秒 | 每分钟最多发起 10 次对话 |

```python
# task.py 中的调用
await rate_limit(current_user.id, "upload", limit=20, window=60)

# chat.py 中的调用
await rate_limit(current_user.id, "chat_stream", limit=10, window=60)
```

---

## 五、Token 黑名单

### 5.1 JWT Token 黑名单的需求场景

**JWT 的特点**：JWT 是无状态的（stateless），服务端不存储 token 信息。这意味着：
- 优点：不需要查数据库就能验证 token（解析 + 验签）
- 缺点：**一旦签发就无法撤销**（在过期之前一直有效）

**问题场景**：
1. 用户主动登出 → 希望 token 立即失效
2. 用户修改密码 → 旧 token 应该失效
3. 发现 token 被盗 → 需要紧急作废
4. 用户被管理员禁用 → 已签发的 token 应该失效

**解决方案**：在 Redis 中维护一个"黑名单"，记录已作废的 token。每次请求时检查 token 是否在黑名单中。

> **面试关键点**：这实际上是给无状态的 JWT 加了一层有状态的校验。代价是每次请求多一次 Redis 查询（~0.1ms），但换来了 token 撤销能力。

### 5.2 Redis 实现 Token 黑名单的方案

#### 存储设计

```
Key:    blacklist:{sha256(token)}
Value:  "1"
TTL:    token 的剩余有效时间
```

#### 为什么用 SHA256 哈希存储？

直接存储完整 JWT token 有两个问题：
1. **空间浪费**：JWT token 通常有 200~500 字节，SHA256 哈希只有 64 字节（hex 编码）
2. **安全性**：如果 Redis 数据被泄露，攻击者可以拿到有效的 token。存储 hash 值则无法反推原始 token

```python
token_hash = hashlib.sha256(token.encode()).hexdigest()
```

SHA256 的特性：
- 单向不可逆：无法从 hash 值反推 token
- 碰撞概率极低：2^256 种可能的输出值，碰撞概率可忽略
- 固定长度输出：任意长度输入 → 64 字符的 hex 字符串

#### TTL 与 Token 过期时间的对齐

**关键设计**：黑名单条目的 TTL 设置为 token 的**剩余有效时间**，而不是固定值。

```python
# 登出时
payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
remaining = int((exp - datetime.now(tz=UTC)).total_seconds())
if remaining < 0:
    return  # token 已过期，不需要加黑名单

await r.set(f"blacklist:{token_hash}", "1", ex=remaining)
```

**为什么这样设计？**

- 如果 TTL 设得太短：token 还没过期，黑名单条目就被删了 → token 又可以使用了
- 如果 TTL 设得太长（如固定 7 天）：Redis 中积累大量已过期 token 的黑名单 → 浪费内存
- 对齐剩余时间：token 过期的那一刻，黑名单条目也正好过期 → 完美契合

### 5.3 项目中的实现

#### 登出时加入黑名单（`app/routers/auth.py`）

```python
@router.get("/auth/logout", status_code=204)
async def logout(token: str = Depends(oauth2_scheme)) -> None:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        exp = datetime.fromtimestamp(payload["exp"], tz=UTC)
        remaining = int((exp - datetime.now(tz=UTC)).total_seconds())
        if remaining < 0:
            return  # 已过期的 token 不需要加黑名单
    except jwt.InvalidTokenError:
        return  # 无效的 token 也不需要处理

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    await r.set(f"blacklist:{token_hash}", "1", ex=remaining)
```

**设计细节**：
- 返回 `204 No Content`：登出成功但无返回体
- 即使 token 无效/过期也返回成功（幂等性）
- 不抛出异常：用户体验——点击登出永远成功

#### 请求鉴权时检查黑名单

```python
async def get_current_user(
    token: str = Depends(oauth2_scheme), db: AsyncSession = Depends(get_db)
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )

    # 先检查黑名单（优先于 JWT 解码，因为更快）
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    if await r.get(f"blacklist:{token_hash}"):
        logger.warning("Token在黑名单中，拒绝访问")
        raise credentials_exception

    # 再解码 JWT
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        # ...
    except jwt.InvalidTokenError:
        raise credentials_exception
```

**为什么先查黑名单再解码 JWT？**

两种顺序都可以工作，但先查黑名单有优势：
- Redis `GET` 操作：~0.1ms
- JWT 解码（含 HMAC 验签）：~0.5-1ms
- 如果 token 在黑名单中，可以跳过更耗时的 JWT 解码

但也有反对意见：如果 token 格式根本不合法（不是 JWT），先解码可以更快拒绝，避免一次无意义的 Redis 查询。实际差异很小，两种方式都可以。

### 5.4 改进方向：Short Token + Refresh Token（扩展设计，当前仓库未实现）

项目代码中有一个注释值得注意：

```python
"""登出，将当前token加入黑名单 实际要换成Short token + refresh token"""
```

当前方案的问题：
- Access Token 有效期 7 天（`ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7`）
- 7 天内每次请求都要查 Redis 黑名单
- 如果 Redis 挂了，无法判断 token 是否在黑名单中

**更完整的升级方案：Access Token + Refresh Token**

| Token 类型 | 有效期 | 存储 | 用途 |
|------------|--------|------|------|
| Access Token | 15-30 分钟 | 不存储（无状态） | 携带在每个 API 请求中 |
| Refresh Token | 7-30 天 | 存储在数据库 | 用于刷新 Access Token |

优势：
- Access Token 短命，即使不加黑名单，最多 30 分钟后自动失效
- 登出时只需要删除数据库中的 Refresh Token
- 减少了对 Redis 的依赖

---

## 六、缓存策略

### 6.1 缓存的基本模式

#### (1) Cache-Aside（旁路缓存）— 最常用

**读流程**：
```
应用 → 查缓存 → 命中？
                 ├── 是 → 返回缓存数据
                 └── 否 → 查数据库 → 写入缓存 → 返回数据
```

**写流程**：
```
应用 → 更新数据库 → 删除缓存（而不是更新缓存）
```

**为什么写操作是删除缓存而不是更新缓存？**
- 更新缓存的问题：并发写入时，可能出现数据库和缓存不一致
  ```
  时间线：
  t1: 线程A 更新数据库（值=1）
  t2: 线程B 更新数据库（值=2）
  t3: 线程B 更新缓存（值=2）
  t4: 线程A 更新缓存（值=1）  ← 数据库是2，缓存是1，不一致！
  ```
- 删除缓存：下次读取时自然加载最新值，不会不一致

**本项目使用的就是 Cache-Aside 模式。**

#### (2) Read-Through（读穿透）

与 Cache-Aside 类似，但由缓存组件（而不是应用）负责从数据源加载数据。应用只需要跟缓存交互。

#### (3) Write-Through（写穿透）

写操作同时写缓存和数据源，由缓存组件保证一致性。

#### (4) Write-Behind（异步写回）

写操作先写缓存，异步批量写回数据源。性能最好，但可能丢数据。

### 6.2 缓存三大问题

#### 缓存穿透（Cache Penetration）

**是什么**：查询一个**不存在**的数据，缓存中没有，数据库中也没有。每次请求都打到数据库。

**场景**：恶意用户不断查询 ID=-1 或随机 UUID 的资源。

**解决方案**：
1. **缓存空对象**：即使数据库查不到，也在缓存中存一个空值（`NULL`/`""`），设置较短的 TTL
   ```python
   result = await db.get(Task, task_id)
   if result is None:
       await r.set(f"task:result:{task_id}", "null", ex=60)  # 缓存空值 60 秒
   ```
2. **布隆过滤器（Bloom Filter）**：在缓存前加一层布隆过滤器，快速判断数据是否存在
   - 如果布隆过滤器说"不存在"→ 一定不存在 → 直接返回
   - 如果布隆过滤器说"存在"→ 可能存在（有误判率）→ 继续查缓存/数据库

#### 缓存击穿（Cache Breakdown / Hotspot Invalid）

**是什么**：一个**热点 key** 在缓存过期的瞬间，大量并发请求同时打到数据库。

**场景**：热门商品的缓存过期 → 瞬间 10000 个请求涌向数据库。

**解决方案**：
1. **互斥锁（分布式锁）**：第一个请求获取锁并加载数据库，其他请求等待或返回旧数据
   ```python
   cached = await r.get(key)
   if not cached:
       lock = await r.set(f"lock:{key}", "1", nx=True, ex=5)
       if lock:
           data = await db.query(...)  # 查数据库
           await r.set(key, data, ex=3600)
       else:
           await asyncio.sleep(0.1)  # 等一下再读缓存
           cached = await r.get(key)
   ```
2. **永不过期 + 后台更新**：缓存不设 TTL，后台定时任务刷新缓存
3. **逻辑过期**：缓存中存储逻辑过期时间，过期后后台异步更新，当前请求返回旧数据

#### 缓存雪崩（Cache Avalanche）

**是什么**：大量 key **同时过期**，导致大量请求同时打到数据库。

**与击穿的区别**：击穿是单个热点 key 过期，雪崩是大批量 key 同时过期。

**解决方案**：
1. **过期时间加随机值**：`TTL = base_ttl + random(0, 300)`，打散过期时间
   ```python
   import random
   ttl = 3600 + random.randint(0, 300)  # 基础1小时 + 随机 0-5 分钟
   await r.set(key, value, ex=ttl)
   ```
2. **多级缓存**：本地缓存（内存）+ Redis 缓存，即使 Redis 缓存全部失效，本地缓存还能扛一段时间
3. **熔断降级**：检测到数据库压力过大时，暂时返回降级数据或排队处理

### 6.3 缓存淘汰策略

当 Redis 内存达到 `maxmemory` 限制时，需要淘汰一些 key 来腾出空间。

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `noeviction` | 不淘汰，写操作返回错误 | 不允许丢数据的场景 |
| `allkeys-lru` | 在所有 key 中淘汰最近最少使用的 | **最常用，推荐** |
| `allkeys-lfu` | 在所有 key 中淘汰最不经常使用的 | 有热点数据的场景 |
| `volatile-lru` | 在设置了过期时间的 key 中淘汰 LRU | 混合使用（部分 key 有 TTL） |
| `volatile-lfu` | 在设置了过期时间的 key 中淘汰 LFU | 同上 |
| `allkeys-random` | 随机淘汰 | 数据访问频率均匀 |
| `volatile-random` | 在有过期时间的 key 中随机淘汰 | 同上 |
| `volatile-ttl` | 淘汰 TTL 最短（即将过期）的 key | 希望优先保留长 TTL 的数据 |

**LRU vs LFU**：
- LRU（Least Recently Used）：淘汰最长时间没被访问的。问题：偶尔被访问一次的 key 会留下，真正的热点反而被淘汰
- LFU（Least Frequently Used）：淘汰访问频率最低的。更适合热点数据场景

> **注意**：Redis 的 LRU 不是精确的 LRU 算法（那需要维护一个全局的链表，开销太大）。Redis 用的是**近似 LRU**：随机采样 N 个 key（默认 5 个），淘汰其中最久未使用的。

### 6.4 项目中的缓存策略

#### 任务结果缓存（`app/routers/task.py`）

```python
@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(task_id: int, ...):
    r = get_redis()

    # 1. 先查 Redis 缓存
    cached = await r.get(f"task:result:{task_id}")
    if cached:
        data = json.loads(cached)
        # 权限检查（即使缓存命中也要检查）
        if data.get("user_id") != current_user.id and not current_user.is_superuser:
            raise HTTPException(status_code=404, detail="任务不存在")
        return data

    # 2. 缓存未命中，查数据库
    task = await db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    # 3. 只缓存已完成的任务（进行中的任务状态会变化，不适合缓存）
    if task.status == TaskStatus.COMPLETED.value:
        await r.set(
            f"task:result:{task_id}",
            json.dumps({...}),
            ex=3600,  # 1 小时过期
        )

    return task
```

**设计要点**：

1. **Cache-Aside 模式**：先查缓存 → 未命中查数据库 → 回填缓存
2. **只缓存已完成的任务**：
   - PROGRESSING 状态的任务还在变化，缓存会导致用户看到旧状态
   - COMPLETED 状态的任务数据不再变化，适合缓存
3. **TTL 设置为 1 小时**：任务结果不会变化，但也不需要永久缓存
4. **JSON 序列化**：将 Python 对象序列化为 JSON 字符串存储

**注意**：项目中缓存数据后，如果任务被删除了，缓存不会自动失效。可以在 delete 接口中主动删除缓存：

```python
# 改进：删除任务时同步删除缓存
await r.delete(f"task:result:{task_id}")
```

### 6.5 热点数据处理

**热点数据**：被大量请求访问的少数几个 key。

解决方案：
1. **本地缓存 + Redis 缓存（两级缓存）**：
   - L1：应用进程内存（`functools.lru_cache` 或 `cachetools.TTLCache`），延迟最低
   - L2：Redis，进程间共享
   - 读取顺序：L1 → L2 → 数据库
2. **热点 key 分散**：将一个热点 key 拆分成多个（如 `key_0`, `key_1`, ... `key_N`），请求随机访问其中一个
3. **永不过期 + 异步更新**：热点 key 不设 TTL，后台任务定期刷新

---

## 七、Redis 作为消息队列

### 7.1 Redis List 实现简单消息队列

**原理**：利用 List 的 `LPUSH`（左端入队）和 `BRPOP`（右端阻塞出队）实现 FIFO 队列。

```
生产者 → LPUSH queue "task1"  →  [task3, task2, task1]  → BRPOP queue → 消费者
         LPUSH queue "task2"                                 取出 task1
         LPUSH queue "task3"
```

**BRPOP vs RPOP**：
- `RPOP`：非阻塞，队列为空时返回 nil，需要轮询（浪费 CPU）
- `BRPOP`：阻塞等待，队列为空时线程挂起，有新消息时立即唤醒（高效）

**缺点**：
- 没有 ACK 机制：消费者取出消息后如果崩溃，消息丢失
- 不支持消费者组：多个消费者会竞争消费（一条消息只能被一个消费者处理）
- 没有持久化保证：如果 Redis 挂了，队列中的消息可能丢失

### 7.2 Redis Pub/Sub

**原理**：发布/订阅模式。发布者向频道发布消息，所有订阅该频道的客户端都能收到。

```
发布者 → PUBLISH channel "message" → Redis → 订阅者A（收到 message）
                                           → 订阅者B（收到 message）
                                           → 订阅者C（收到 message）
```

**特点**：
- 消息是即时的，不持久化（Fire and Forget）
- 如果订阅者断开连接，期间的消息会丢失
- 适合实时通知、即时聊天等场景
- **不适合可靠的消息队列**

### 7.3 Redis Stream（Redis 5.0+）

**Redis Stream 是 Redis 原生的、最完整的消息队列方案。**

核心特性：
- 消息持久化（写入 AOF/RDB）
- 消费者组（Consumer Group）：多个消费者分工处理
- ACK 确认机制：消息消费后需要确认，未确认的消息可以重新投递
- 消息 ID 自动生成（时间戳 + 序列号）

**核心命令**：
```
XADD stream_name * field1 value1 field2 value2    # 发布消息
XREAD COUNT 10 BLOCK 5000 STREAMS stream_name $    # 阻塞读取
XGROUP CREATE stream_name group_name $ MKSTREAM     # 创建消费者组
XREADGROUP GROUP group_name consumer_name ...       # 消费者组读取
XACK stream_name group_name message_id              # 确认消息
```

### 7.4 Arq 基于 Redis 的任务队列原理

本项目使用 **Arq** 作为异步任务队列，底层完全基于 Redis。

**Arq 的工作原理**：

```
┌──────────────┐     入队                  ┌──────────────┐
│ FastAPI API  │ ──→ RPUSH arq:queue ──→  │    Redis     │
│ (生产者)     │                           │              │
└──────────────┘                           │  arq:queue   │
                                           │  arq:job:*   │
                                           │  arq:result:*│
┌──────────────┐     消费                  │              │
│ Arq Worker   │ ←── BLPOP arq:queue ←──  │              │
│ (消费者)     │                           └──────────────┘
└──────────────┘
     │ 执行任务
     │ 存储结果
     └──→ SET arq:result:{job_id}
```

**关键 Redis 键**：
- `arq:queue:default`：任务队列（List 类型）
- `arq:job:{job_id}`：任务的元数据（Hash 类型，包含函数名、参数、状态等）
- `arq:result:{job_id}`：任务执行结果

**Arq 相比 Celery 的优势**：
| 特性 | Arq | Celery |
|------|-----|--------|
| 异步支持 | 原生 async/await | 需要额外配置 |
| 依赖 | 仅需 Redis | 需要 Redis/RabbitMQ + 额外组件 |
| 代码量 | 极简 | 较重 |
| 学习曲线 | 低 | 中等 |
| 功能 | 基础但够用 | 功能丰富 |
| 适用规模 | 中小型项目 | 大型项目 |

### 7.5 项目中 Redis 作为 Arq 后端

#### 入队（API 端）

```python
# task.py — 上传图片后入队 YOLO 检测任务
arq = get_arq_redis()
job = await arq.enqueue_job(
    "run_yolo_detection",       # 函数名（必须在 Worker 中注册）
    new_task.id,                # 参数
    _job_id=f"yolo_{new_task.id}",  # 自定义 job ID（防止重复入队）
)
```

**`_job_id` 的作用**：Arq 会检查 `arq:job:{job_id}` 是否已存在，如果存在则不重复入队。这是 Arq 内置的幂等性保证。

#### 消费（Worker 端）

```python
# worker.py
class WorkerSettings:
    functions = [run_yolo_detection, run_knowledge_rebuild]  # 注册任务函数
    redis_settings = parse_redis_settings()  # Redis 连接
    max_jobs = 4          # 最大并发数
    job_timeout = 120     # 单任务超时
    retry_jobs = True     # 开启重试
    max_tries = 3         # 最多重试 3 次
```

**重试策略**：Arq 使用指数退避：
- 第 1 次重试：~10 秒后
- 第 2 次重试：~30 秒后
- 第 3 次重试：~90 秒后

**为什么需要重试？**
- GPU 显存偶尔被占用 → OOM → 释放后重试成功
- 文件系统偶发 I/O 错误 → 重试成功
- 网络抖动（如连接 Ollama）→ 重试成功

#### Docker Compose 中 Worker 的部署

```yaml
worker:
  build:
    context: .
    dockerfile: backend/Dockerfile
  depends_on:
    redis:
      condition: service_healthy
  command: ["uv", "run", "arq", "app.worker.WorkerSettings"]
```

**关键设计**：
- Worker 和 Backend 共享同一个 Docker 镜像，只是启动命令不同
- `depends_on` 确保 Redis 健康后才启动 Worker
- Worker 和 Backend 共享数据卷（static、models 等），Worker 可以直接读写文件

---

## 八、Redis 运维

### 8.1 Redis 的内存管理

Redis 是内存数据库，内存管理至关重要。

**查看内存使用**：
```
redis-cli INFO memory
```

关键指标：
- `used_memory`：Redis 分配器分配的总内存（数据 + 内部开销）
- `used_memory_rss`：操作系统分配给 Redis 进程的实际物理内存
- `mem_fragmentation_ratio`：`used_memory_rss / used_memory`，碎片率
  - 1.0~1.5：正常
  - > 1.5：碎片过多，需要重启或开启 `activedefrag`
  - < 1.0：使用了 swap（极危险，性能骤降）

**内存优化建议**：
1. 选择合适的数据结构（Hash 在小数据量时比 String 省内存）
2. 设置合理的 TTL，避免无用 key 堆积
3. 使用 `maxmemory` 限制最大内存
4. 监控 `mem_fragmentation_ratio`

### 8.2 maxmemory 配置和淘汰策略

```
# redis.conf
maxmemory 256mb
maxmemory-policy allkeys-lru
```

- `maxmemory`：限制 Redis 使用的最大内存。建议设置为物理内存的 50-75%，留给操作系统和 fork（bgsave/rewrite）
- `maxmemory-policy`：内存满时的淘汰策略（详见 6.3 节）

### 8.3 Redis 监控

#### INFO 命令

```bash
redis-cli -a ${REDIS_PASSWORD} INFO
```

关键段落：
- `INFO server`：Redis 版本、运行时间、配置文件路径
- `INFO clients`：已连接客户端数、最大客户端数
- `INFO memory`：内存使用情况
- `INFO stats`：命中率、已处理命令数
- `INFO replication`：主从复制状态
- `INFO keyspace`：各数据库的 key 数量

**缓存命中率计算**：
```
hit_rate = keyspace_hits / (keyspace_hits + keyspace_misses)
```
如果命中率低于 90%，说明缓存策略可能有问题（TTL 太短、缓存的数据不对）。

#### MONITOR 命令

```bash
redis-cli -a ${REDIS_PASSWORD} MONITOR
```

实时显示 Redis 接收到的所有命令。**仅用于调试，生产环境慎用**（性能开销大，输出量巨大）。

#### SLOWLOG 慢查询日志

```bash
redis-cli -a ${REDIS_PASSWORD} SLOWLOG GET 10  # 最近 10 条慢查询
```

配置：
```
slowlog-log-slower-than 10000   # 记录执行超过 10ms 的命令（微秒为单位）
slowlog-max-len 128             # 最多保留 128 条慢查询记录
```

### 8.4 Redis 安全

#### (1) requirepass — 密码认证

```yaml
# docker-compose.yml
command: redis-server --requirepass ${REDIS_PASSWORD:?请在 .env 中设置 REDIS_PASSWORD}
```

- **必须设置密码**。裸奔的 Redis 被扫描到后几分钟就会被入侵（挖矿、勒索）
- `${REDIS_PASSWORD:?...}` 语法：如果环境变量未设置，Docker Compose 会报错阻止启动
- Redis 6.0+ 支持 ACL（Access Control List），可以细粒度控制不同用户的权限

#### (2) bind — 绑定地址

```
bind 127.0.0.1    # 只允许本机访问
```

- 不设置 bind 默认监听所有网卡（0.0.0.0）→ 外网可直接访问 → 极度危险
- Docker 环境中 Redis 只需要在 Docker 网络内通信，不应该暴露到宿主机外网
- 项目中 `ports: "6379:6379"` 将端口映射到宿主机，开发环境可以这样做，**生产环境应该去掉此映射**

#### (3) rename-command — 命令重命名

```
rename-command FLUSHALL ""       # 禁用 FLUSHALL（删除所有数据）
rename-command FLUSHDB ""        # 禁用 FLUSHDB
rename-command CONFIG ""         # 禁用 CONFIG（防止运行时修改配置）
rename-command KEYS ""           # 禁用 KEYS（生产环境禁止全量扫描）
```

**为什么禁用 `KEYS *`？**
- `KEYS *` 会遍历所有 key，时间复杂度 O(n)
- 如果有 100 万个 key，执行 KEYS 会阻塞 Redis 几秒
- 单线程的 Redis 被阻塞 = 所有客户端超时
- 替代方案：`SCAN` 命令（增量迭代，不阻塞）

### 8.5 Docker 中运行 Redis 的注意事项

项目的 `docker-compose.yml` 中 Redis 的完整配置：

```yaml
redis:
  image: redis:7-alpine
  restart: unless-stopped
  command: redis-server --requirepass ${REDIS_PASSWORD:?请在 .env 中设置 REDIS_PASSWORD} --appendonly yes
  volumes:
    - redis_data:/data
  ports:
    - "6379:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
    interval: 10s
    timeout: 5s
    retries: 5
```

**逐项检查（工程级标准）**：

| 配置项 | 是否正确 | 说明 |
|--------|---------|------|
| `restart: unless-stopped` | 正确 | 容器异常退出自动重启，手动停止不重启 |
| `--requirepass` | 正确 | 设置了密码认证 |
| `--appendonly yes` | 正确 | 开启 AOF 持久化 |
| `volumes: redis_data:/data` | 正确 | 数据持久化到命名卷，容器删除数据不丢 |
| `healthcheck` | 正确 | 健康检查，其他服务 `depends_on condition: service_healthy` |
| `ports: "6379:6379"` | 开发环境可以 | 生产环境应该去掉，只在 Docker 网络内通信 |

**缺少的生产级配置（改进建议）**：
- `--maxmemory 256mb`：限制最大内存，防止 OOM 被操作系统杀掉
- `--maxmemory-policy allkeys-lru`：内存满时淘汰策略
- `--loglevel warning`：生产环境只记录警告及以上日志
- 网络隔离：使用自定义 Docker network，不暴露端口

---

## 九、Redis 高可用与集群架构

### 9.1 主从复制：高可用的起点，不是终点

只会说“Redis 很快”，不会说主从复制，说明你还没进入工程层。

Redis 主从复制解决的是两个问题：
- **数据冗余**：主节点故障时至少还有副本
- **读扩展**：读流量可以分担到从节点

但它也天然带来一个事实：**复制是异步的**。这意味着：
- 主刚写成功，从还没来得及同步
- 如果主立刻宕机，这部分数据可能丢失
- 所以 Redis 的高可用默认不是强一致，而是“尽量可用 + 接受少量数据窗口风险”

**面试里必须会说的点：**
- 首次同步通常是全量同步：RDB + backlog buffer
- 正常运行中是增量命令传播
- backlog 不够时会退回全量同步
- 主从复制适合缓存和加速，不适合承载“绝对不能丢”的核心账务真相

### 9.2 Sentinel vs Cluster

这两个概念混了，面试基本就悬了。

| 维度 | Sentinel | Cluster |
|------|----------|---------|
| 目标 | 高可用 | 高可用 + 水平扩展 |
| 数据分布 | 全量复制 | 16384 slot 分片 |
| 容量上限 | 单主机内存上限 | 多主分片总和 |
| 客户端复杂度 | 较低 | 更高，需要感知 slot 重定向 |
| 适用场景 | 数据量不大但要自动故障转移 | 数据量和写入都显著增大 |

**Sentinel** 的核心是监控、投票、故障转移。
它不做分片，只负责在主挂掉时选出新主。

**Cluster** 解决的是“单机内存和单主写入顶不住”的问题。它把 key 按 slot 分散到多个 master，每个 master 再配 replica。

**怎么选？**
- 数据还不大，只想自动 failover → Sentinel
- 单机容量或单主吞吐已成瓶颈 → Cluster
- 项目还在早期，单机 Redis 足够 → 先别上，复杂度不值得

### 9.3 故障转移时真正会发生什么

高可用不是“服务不重启”，而是“故障发生时系统还能接受”。

Redis 故障切换常见现象：
- 客户端短时间报连接错误
- 旧主降级/新主升主期间有写失败窗口
- 读请求可能看到旧数据
- 锁、队列、缓存命中率都会受影响

所以工程上必须回答两个问题：
1. **Redis 短暂不可用时系统怎么降级？**
2. **Redis 恢复后是否会产生脏状态？**

例如本项目里 Redis 同时承担：
- 限流
- 黑名单
- 分布式锁
- 任务结果缓存
- Arq 队列底座

这意味着它不是“可有可无”的纯缓存，而是基础设施。角色越多，越要清楚故障影响面。

## 十、缓存一致性与热点治理

### 10.1 Cache Aside：最常见，也最容易答浅

绝大多数业务系统用的是 **Cache Aside**：
- 读：先查缓存，miss 再查数据库并回填缓存
- 写：先写数据库，再删缓存

为什么不是“先更新缓存再写库”？因为数据库才是真相源（source of truth），缓存只是加速层。

但 Cache Aside 的真正难点不在模式名，而在**一致性窗口**。

典型竞态：
1. 线程 A 更新数据库
2. 线程 B 读旧缓存
3. A 删除缓存
4. B 把旧值重新写回缓存

这就是为什么面试官会继续追问“那你怎么保证一致性”。

### 10.2 延迟双删、逻辑过期、多级缓存

#### 延迟双删

做法：
1. 更新数据库
2. 立即删除缓存
3. 等一小段时间后再删一次

目标：减少并发读把旧值回填的概率。

**问题**：它不是强一致，只是工程折中。延迟时间不好拍脑袋，仍然可能失败。

#### 逻辑过期

不是让 key 真过期，而是在 value 里存一个 `expire_at`：
- 读到未过期 → 直接返回
- 读到逻辑过期 → 先返回旧值，同时后台异步刷新

适合热点数据，优点是**不会因为真实 TTL 到点而打爆数据库**。

#### 多级缓存

常见是：
- 进程内缓存（L1）
- Redis（L2）
- PostgreSQL（L3）

优点是延迟更低；代价是一致性更难、失效广播更复杂。

### 10.3 缓存穿透、击穿、雪崩

这些不是背定义的题，而是生产事故题。

- **穿透**：请求不存在的数据，缓存里没有，数据库里也没有
  - 解法：空值缓存、布隆过滤器
- **击穿**：热点 key 过期瞬间，大量请求同时打数据库
  - 解法：互斥锁、逻辑过期、后台预热
- **雪崩**：大量 key 同时过期或 Redis 整体不可用
  - 解法：TTL 打散、多级缓存、限流降级、隔离热点接口

### 10.4 Hot Key 与 Big Key

#### Hot Key

少数 key 被极高频访问，会造成：
- 单分片热点
- 网络出口压力
- CPU 打满
- Cluster 下 slot 倾斜

解决思路：
- 本地缓存兜一层
- 热点 key 预热
- 对极端热点结果做只读副本或业务层缓存
- 避免把所有请求集中在单个排行榜/单个用户态 key 上

#### Big Key

Big Key 的问题不是“占内存大”这么简单，而是：
- 传输慢
- 删除慢
- 主从复制放大
- 过期淘汰时阻塞主线程

硬规则：
- 超大对象拆分
- 能分页就不要一次性整块取回
- 删除大 key 优先 `UNLINK` 而不是 `DEL`

## 十一、Lua、Pipeline 与原子性边界

### 11.1 Pipeline 解决吞吐，不解决条件竞争

Pipeline 的价值是减少 RTT：
- 一次发送多条命令
- 一次收回多条结果

它适合批量读写，但**不代表原子性**。如果你在 pipeline 里做“先 GET 再判断再 DEL”，中间仍可能被别的客户端插队。

### 11.2 `MULTI/EXEC` 事务为什么不等于数据库事务

Redis 事务保证的是：
- 命令按顺序执行
- 执行期间不会穿插其他客户端命令

但它不提供：
- 真正的回滚
- 复杂条件逻辑
- 像数据库那样的隔离级别语义

所以你不能把 Redis 事务和 MySQL/PostgreSQL 事务当一回事。

### 11.3 Lua 脚本的真正价值

Lua 适合“**读-判断-写**”必须合成原子操作的场景，例如安全释放分布式锁：

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

为什么必须这样做？因为：
- 你先 GET
- 锁过期了
- 别人拿到新锁
- 你再 DEL
- 你删掉了别人的锁

这个事故在生产里非常真实。不会 Lua，就不要轻易说自己“会 Redis 分布式锁”。

## 十二、Redis 的工程角色与边界

### 12.1 Redis 适合做什么

Redis 在工程里常见的 5 个角色：
- **缓存**：降低数据库读压力
- **锁**：短时互斥控制
- **限流器**：计数、滑动窗口、令牌桶
- **短时状态存储**：登录态、验证码、黑名单、幂等键
- **轻量队列/延迟任务**：对可靠性要求不极端的场景

本项目就是典型“一库多用”：缓存、黑名单、锁、限流、任务结果缓存、Arq 底座都放在 Redis 上。

### 12.2 Redis 不适合做什么

- 不适合做唯一真相源的核心交易账本
- 不适合承载超复杂查询
- 不适合长期堆大量冷热不均的大对象
- 不适合在没有降级方案的情况下承担所有关键基础设施角色

### 12.3 Redis 挂了怎么办？

这是架构师视角必问题。

你必须先分清：
- Redis 挂了，**哪些功能必须停**
- 哪些功能可以降级
- 哪些功能可以绕过

例如：
- 缓存失效 → 可以回源数据库，但要配合限流
- 黑名单失效 → 要决定是“默认拒绝”还是“短时放行”
- 分布式锁失效 → 要看是否允许并发执行，是否有幂等兜底
- 队列失效 → 后台任务是否要暂停入队

真正成熟的答案不是“Redis 高可用就行”，而是**即使 Redis 失效，系统也知道怎么失败**。

---

## 十三、面试高频问题

### 问题 1：Redis 为什么这么快？

**参考答案**：

Redis 快的核心原因有四个：

第一，**纯内存操作**。所有数据存储在内存中，内存读写延迟在纳秒级别，比磁盘快 3-5 个数量级。

第二，**I/O 多路复用**。使用 epoll/kqueue 等机制，单线程就能高效处理数万并发连接。当某个连接有数据可读时才处理，不需要为每个连接分配一个线程。

第三，**单线程执行命令**。避免了多线程的锁竞争和上下文切换开销。Redis 的瓶颈在内存和网络 I/O，不在 CPU。

第四，**高效的内部数据结构**。比如 SDS（动态字符串）、ziplist（紧凑列表）、quicklist、skiplist（跳跃表）等，都是针对 Redis 的使用场景深度优化的。

单机 Redis 通常可以达到 10-15 万 QPS。

### 问题 2：Redis 的持久化机制有哪些？各自的优缺点？

**参考答案**：

Redis 有两种持久化机制：RDB 和 AOF。

**RDB**（快照）：在某个时间点将内存数据生成二进制快照写入磁盘。触发方式有 `BGSAVE`（fork 子进程后台执行）和自动触发（配置 save 规则）。优点是文件紧凑、恢复速度快；缺点是可能丢失两次快照之间的数据。

**AOF**（追加日志）：将每条写命令追加到日志文件。默认每秒 fsync 一次（`everysec`），最多丢失 1 秒数据。优点是数据安全性高；缺点是文件较大、恢复较慢。AOF 重写机制可以压缩文件大小。

**生产建议**：两者同时开启。RDB 用于冷备和快速恢复，AOF 保证数据安全。恢复时优先加载 AOF。

在我的项目中使用了 `--appendonly yes` 开启 AOF，因为 Redis 中存储了 Token 黑名单和任务队列数据，不能丢失。

### 问题 3：Redis 的单线程模型是什么意思？Redis 6.0 的多线程改了什么？

**参考答案**：

Redis 的"单线程"指的是**命令的解析和执行在一个线程中串行完成**。但整个 Redis 进程不止一个线程——后台持久化（bgsave）、异步删除（unlink）、集群通信等都有独立线程。

Redis 6.0 引入了多线程 I/O（`io-threads` 配置），但**命令执行仍然是单线程的**。多线程只用于网络数据的读写（read/write 系统调用），读到完整命令后仍然交给主线程串行执行。这避免了并发安全问题，同时提升了网络 I/O 的吞吐量。

### 问题 4：什么是缓存穿透、缓存击穿、缓存雪崩？怎么解决？

**参考答案**：

**缓存穿透**：查询一个不存在的数据，缓存和数据库都没有，每次请求都穿透到数据库。解决方案：缓存空对象（`SET key NULL EX 60`）或使用布隆过滤器。

**缓存击穿**：一个热点 key 过期的瞬间，大量并发请求同时打到数据库。解决方案：互斥锁（分布式锁保护数据库查询）或设置永不过期 + 后台异步更新。

**缓存雪崩**：大量 key 同时过期，请求洪峰打到数据库。解决方案：TTL 加随机值打散过期时间、多级缓存、熔断降级。

### 问题 5：Redis 如何实现分布式锁？

**参考答案**：

核心命令是 `SET key value NX EX seconds`：
- `NX` 保证只有 key 不存在时才能设置成功（互斥性）
- `EX` 设置过期时间（防止死锁）
- 这两个操作是原子的（一条命令完成）

在我的项目中，用分布式锁防止两个场景的并发问题：
1. 防重复上传：`lock:upload:{user_id}:{file_hash}`，key 包含用户 ID 和文件哈希，过期时间 30 秒
2. 防并发对话：`lock:chat:{user_id}`，保证同一用户同时只有一个对话在生成，过期时间 120 秒（LLM 生成较慢）

释放锁时需要注意防止误删：应该在 value 中存储持有者的唯一标识（如 UUID），释放时用 Lua 脚本先检查 value 再删除，保证原子性。

### 问题 6：Redis 的数据结构有哪些？分别适用什么场景？

**参考答案**：

Redis 有 5 种基础数据结构：

1. **String**：最基础的类型。适用于缓存、计数器（INCR）、分布式锁（SET NX EX）、Token 黑名单
2. **Hash**：键值对集合。适用于存储对象属性、购物车
3. **List**：双向链表。适用于消息队列、最新消息列表
4. **Set**：无序集合。适用于标签、共同好友（SINTER 交集）、去重
5. **Sorted Set**：有序集合（每个元素有 score）。适用于排行榜、延迟队列

在我的项目中主要用 String 类型：缓存用 `SET key json_string EX ttl`，分布式锁用 `SET key 1 NX EX seconds`，Token 黑名单用 `SET blacklist:hash 1 EX remaining`。

### 问题 7：为什么 Redis 连接池需要隔离？你的项目是怎么设计的？

**参考答案**：

在我的项目中，Redis 连接池分成了两个：一个是 Arq 专用的连接池（用于任务入队），一个是通用的业务连接池（用于缓存、限流、分布式锁、Token 黑名单）。

隔离的核心原因是**故障隔离和资源隔离**：
- 如果大量任务入队耗尽了连接，不应该影响到缓存查询和限流功能
- 两个池可以分别设置不同的 `max_connections`
- 一个池出问题不会拖垮另一个

这和数据库领域的"读写分离连接池"是同一个思路。

另外，Arq Worker 是一个独立的进程，有自己的内存空间，它使用 Arq 框架内部管理的连接来监听 Redis 队列，和 API 进程的连接池是物理隔离的。

### 问题 8：你的项目中速率限制是怎么实现的？有什么改进空间？

**参考答案**：

使用 Redis 的 `INCR` + `EXPIRE` 实现了固定窗口算法。

Key 设计为 `ratelimit:{user_id}:{endpoint}`，按用户和接口粒度限流。`INCR` 是原子操作，天然线程安全。第一次 INCR 后设置 `EXPIRE`，窗口结束后计数器自动重置。

固定窗口有一个已知问题：临界点突发。比如限制每分钟 10 次，在第 59 秒打了 10 次，第 61 秒又打了 10 次，实际 2 秒内打了 20 次。

改进方案：
1. 用 **滑动窗口**（Sorted Set 存储每次请求的时间戳），精度更高但内存占用更大
2. 把 `INCR` + `EXPIRE` 合并到 **Lua 脚本** 中执行，消除竞态条件
3. 根据实际需要选择漏桶或令牌桶算法

对于我的项目场景（API 限流，非计费场景），固定窗口的精度已经足够。

### 问题 9：JWT Token 黑名单为什么用 SHA256 存储而不是直接存 Token？

**参考答案**：

两个原因：

第一，**节省空间**。JWT Token 通常有 200-500 字节，SHA256 哈希固定为 64 字节（hex 编码），空间节省 70% 以上。如果同时有大量用户登出，节省的内存很可观。

第二，**安全性**。如果 Redis 数据被泄露（比如未授权访问），直接存储的 Token 可以被攻击者拿去使用。存储 SHA256 哈希值则无法反推原始 Token（SHA256 是单向函数，计算上不可逆）。

在我的项目中，黑名单条目的 TTL 精确设置为 Token 的剩余有效时间。Token 过期的时候，黑名单条目也自动过期删除，不会有内存泄漏。

### 问题 10：Redis 的缓存淘汰策略有哪些？你会怎么选？

**参考答案**：

Redis 有 8 种淘汰策略，最常用的 3 种：

1. **`noeviction`**：不淘汰，内存满了写操作直接报错。适用于不能丢数据的场景。
2. **`allkeys-lru`**：在所有 key 中淘汰最近最少使用的。**最常用，大多数场景的默认选择。**
3. **`allkeys-lfu`**：在所有 key 中淘汰访问频率最低的。适用于有明显热点数据的场景。

我会选 `allkeys-lru`，因为：
- 缓存场景下，最近被访问的数据大概率还会被访问（时间局部性）
- LRU 的实现简单、效果好
- Redis 用近似 LRU（随机采样 5 个 key 淘汰最旧的），性能开销极小

如果有明显的热点数据（少数 key 被高频访问），可以换成 `allkeys-lfu`。

### 问题 11：Redis 主从复制的原理？

**参考答案**：

Redis 主从复制分为**全量同步**和**增量同步**：

**全量同步**（首次连接或断线太久）：
1. Slave 发送 `PSYNC ? -1` 给 Master
2. Master 执行 `BGSAVE` 生成 RDB 快照
3. Master 将 RDB 文件发送给 Slave
4. Slave 清空旧数据，加载 RDB
5. Master 将生成 RDB 期间的新写命令缓存在 replication buffer 中，RDB 传输完后发送给 Slave

**增量同步**（正常运行中）：
1. Master 将每条写命令发送给所有 Slave
2. Slave 收到后执行命令，保持数据一致

**增量同步的断线续传**（Redis 2.8+）：
1. Master 维护一个环形缓冲区（repl_backlog），记录最近的写命令
2. Slave 断线后重连，发送 `PSYNC replication_id offset`
3. 如果 offset 还在缓冲区内 → 增量同步（发送缺失的命令）
4. 如果 offset 已超出缓冲区 → 全量同步

### 问题 12：Redis Sentinel 和 Cluster 的区别？

**参考答案**：

| 特性 | Sentinel | Cluster |
|------|----------|---------|
| 解决的问题 | 高可用（自动故障转移） | 高可用 + 数据分片（水平扩展） |
| 数据分布 | 所有节点存储完整数据 | 数据分散在 16384 个 slot 上 |
| 写入能力 | 只有 Master 可写 | 每个分片的 Master 都可写 |
| 容量上限 | 单机内存上限 | 所有节点内存之和 |
| 适用场景 | 数据量不大但需要高可用 | 数据量大 + 需要高可用 |

本项目是中小型项目，单机 Redis 足够，不需要 Sentinel 或 Cluster。

### 问题 13：Redis 事务和 Lua 脚本的区别？

**参考答案**：

**Redis 事务**（`MULTI/EXEC`）：
- 将多条命令打包，一次性、按顺序执行
- 执行期间不会被其他命令插入
- **不支持回滚**：如果中间一条命令执行失败，其他命令仍然执行
- 只保证隔离性，不保证原子性（和传统数据库事务不同）

**Lua 脚本**：
- 在 Redis 服务端执行 Lua 代码
- **真正的原子性**：脚本执行期间不会被任何命令打断
- 可以包含条件逻辑（if/else）
- 适合需要"先读后写"的原子操作（如分布式锁的释放）

**为什么推荐 Lua 脚本而不是事务？**
- 事务不能根据中间结果决定下一步操作（不能 GET 值然后根据值决定是否 DEL）
- Lua 脚本可以（`if redis.call("get", KEYS[1]) == ARGV[1] then ...`）

### 问题 14：Redis 的 Big Key 问题是什么？怎么解决？

**参考答案**：

**Big Key** 是指 value 特别大的 key：
- String 类型 > 10KB
- Hash/List/Set/ZSet 的元素数 > 5000 或总 size > 10MB

**Big Key 的危害**：
1. 读取 Big Key 消耗大量网络带宽
2. 删除 Big Key 阻塞主线程（DEL 是同步操作，删除一个 100MB 的 key 可能阻塞几秒）
3. 过期淘汰 Big Key 也会阻塞
4. 主从同步时 Big Key 导致数据倾斜

**解决方案**：
1. 拆分：将大 Hash 拆成多个小 Hash（按 ID 取模分桶）
2. 压缩：存储前压缩（gzip/zstd），读取后解压
3. 用 `UNLINK` 代替 `DEL`：UNLINK 是异步删除，后台线程执行，不阻塞主线程
4. 使用 `redis-cli --bigkeys` 定期扫描发现 Big Key

### 问题 15：如何保证 Redis 和数据库的数据一致性？

**参考答案**：

这是一个经典的分布式一致性问题。常见方案：

**方案一：Cache-Aside（旁路缓存）+ 先更新 DB 再删缓存**

```
写操作：更新数据库 → 删除缓存
读操作：查缓存 → 未命中 → 查数据库 → 回填缓存
```

可能的不一致场景：
1. 删除缓存失败 → 数据库是新值，缓存是旧值
2. 解决：重试机制（异步消息队列重试删除）

**方案二：延迟双删**

```
删除缓存 → 更新数据库 → 延迟 N 毫秒 → 再次删除缓存
```

第二次删除是为了清理在更新数据库期间可能被其他线程回填的旧缓存。

**方案三：基于 binlog 的最终一致性**

使用 Canal 或 Debezium 监听数据库 binlog，有数据变更时异步更新/删除缓存。这是最可靠的方案，但架构复杂度最高。

**在我的项目中**：使用 Cache-Aside 模式。只缓存已完成的任务（状态不再变化），写操作很少涉及缓存数据的更新，所以一致性问题不突出。

### 问题 16：Redis 内存碎片是怎么产生的？怎么解决？

**参考答案**：

**产生原因**：Redis 使用 jemalloc 内存分配器，分配的内存块大小是固定的（8、16、32、64 字节等）。如果存储一个 30 字节的数据，jemalloc 分配 32 字节，有 2 字节浪费。频繁的修改/删除导致大量小碎片。

**判断方式**：`INFO memory` 中的 `mem_fragmentation_ratio`
- 1.0~1.5：正常
- > 1.5：碎片严重
- < 1.0：使用了 swap，极度危险

**解决方案**：
1. **重启 Redis**：重新加载 RDB/AOF，内存重新紧凑分配。最简单但有停机时间
2. **`activedefrag yes`**：Redis 4.0+ 的在线碎片整理，后台自动执行，不停机

### 问题 17：Redis 的过期 key 删除策略是什么？

**参考答案**：

Redis 使用两种策略配合删除过期 key：

1. **惰性删除（Lazy Expiration）**：访问一个 key 时检查是否过期，过期则删除。缺点是如果一个 key 永远不被访问，就永远不会被删除，占用内存。

2. **定期删除（Active Expiration）**：Redis 每秒执行 10 次（由 `hz` 配置控制）定期扫描：
   - 随机抽取 20 个设有过期时间的 key
   - 删除其中已过期的 key
   - 如果过期 key 的比例 > 25%，重复上述过程
   - 为了不阻塞主线程，每次扫描有时间上限

两种策略互补：定期删除负责主动清理，惰性删除兜底。

### 问题 18：Redis Pipeline 是什么？为什么能提升性能？

**参考答案**：

**Pipeline**（管道）允许客户端一次性发送多条命令给 Redis，然后一次性接收所有响应。

**没有 Pipeline 时**：
```
客户端 → 发送命令1 → 等待响应1 → 发送命令2 → 等待响应2 → ...
每条命令都有一个 RTT（Round Trip Time，往返延迟）
```

**有 Pipeline 时**：
```
客户端 → 一次性发送命令1+2+3+...+N → 一次性接收响应1+2+3+...+N
只有一个 RTT
```

**性能提升的关键**：减少了网络往返次数。如果 RTT 是 1ms，100 条命令：
- 无 Pipeline：100ms
- 有 Pipeline：1ms

**注意**：Pipeline 不是事务，命令之间没有原子性保证。

### 问题 19：你的项目中 Redis 承担了哪些角色？如果 Redis 挂了会怎样？

**参考答案**：

在我的项目中，Redis 承担了 5 个角色：

1. **Arq 任务队列后端**：YOLO 检测和知识库重建任务的消息传递
2. **速率限制**：API 接口的访问频率控制
3. **分布式锁**：防止重复上传和并发对话
4. **Token 黑名单**：JWT Token 的撤销机制
5. **缓存**：已完成任务的结果缓存

**如果 Redis 挂了**：
- 所有需要 Redis 的操作会抛出连接异常 → API 返回 500
- Arq Worker 无法消费任务 → 任务积压
- 速率限制失效 → 无限流保护
- 分布式锁失效 → 可能出现重复提交
- Token 黑名单失效 → 已登出用户的 Token 可以继续使用
- 缓存失效 → 所有查询回源数据库，数据库压力增大

**应对策略**：
- Docker `restart: unless-stopped` 保证自动重启
- healthcheck 快速检测故障
- AOF 持久化保证重启后数据恢复
- 业务层面：限流和缓存失败时可以降级（跳过限流、直接查数据库），不应该让整个服务不可用

### 问题 20：解释一下你的项目中 Redis 连接的 `decode_responses=True` 参数。

**参考答案**：

`decode_responses=True` 告诉 redis-py 库自动将从 Redis 返回的 `bytes` 数据解码为 Python `str`。

```python
_redis_pool = redis.ConnectionPool.from_url(
    settings.REDIS_URL,
    max_connections=settings.REDIS_MAX_CONNECTIONS,
    decode_responses=True,
)
```

不设置这个参数时：
```python
result = await r.get("key")  # 返回 b"value"（bytes 类型）
```

设置后：
```python
result = await r.get("key")  # 返回 "value"（str 类型）
```

**为什么需要？**
- 业务代码中处理的都是字符串（JSON、Token 哈希等），不需要手动 `.decode("utf-8")`
- 避免到处写 `if isinstance(result, bytes): result = result.decode()`
- 代码更简洁

**什么时候不设置？**
- 存储二进制数据（图片、序列化的 protobuf 等）时不能设置，否则解码会出错

---

## 附录：项目 Redis 使用全景图

```
┌─────────────────────────────────────────────────────────────────┐
│                        FastAPI Application                      │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │
│  │ auth.py  │  │ task.py  │  │ chat.py  │  │knowledge.py │   │
│  │          │  │          │  │          │  │              │   │
│  │ •黑名单  │  │ •分布式锁│  │ •分布式锁│  │ •任务入队   │   │
│  │  查询/写入│  │ •速率限制│  │ •速率限制│  │  (Arq)      │   │
│  │          │  │ •缓存读写│  │          │  │              │   │
│  │          │  │ •任务入队│  │          │  │              │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │
│       │             │             │                │            │
│  ┌────▼─────────────▼─────────────▼────────────────▼────────┐  │
│  │                    redis.py                               │  │
│  │  ┌─────────────────┐    ┌─────────────────────────────┐  │  │
│  │  │  _arq_pool      │    │  _redis_pool                │  │  │
│  │  │  (ArqRedis)     │    │  (ConnectionPool)            │  │  │
│  │  │  用于任务入队    │    │  max_connections=10          │  │  │
│  │  │                 │    │  decode_responses=True        │  │  │
│  │  └────────┬────────┘    └─────────────┬───────────────┘  │  │
│  └───────────┼───────────────────────────┼──────────────────┘  │
│              │                           │                      │
└──────────────┼───────────────────────────┼──────────────────────┘
               │                           │
               ▼                           ▼
        ┌──────────────────────────────────────┐
        │            Redis :6379               │
        │                                      │
        │  arq:queue:default    (任务队列)      │
        │  arq:job:*            (任务元数据)     │
        │  ratelimit:*          (限流计数器)     │
        │  lock:upload:*        (上传锁)        │
        │  lock:chat:*          (对话锁)        │
        │  blacklist:*          (Token黑名单)   │
        │  task:result:*        (任务缓存)      │
        │                                      │
        │  --requirepass ✓                     │
        │  --appendonly yes ✓                  │
        │  volume: redis_data:/data ✓          │
        └──────────────────────────────────────┘
               ▲
               │
        ┌──────┴──────────┐
        │   Arq Worker    │
        │  (独立进程)      │
        │                 │
        │  监听队列        │
        │  执行任务        │
        │  max_jobs=4     │
        │  max_tries=3    │
        └─────────────────┘
```
