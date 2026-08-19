# 数据库与 ORM 面试知识手册

> 基于 WindSlice 项目实际代码，涵盖 PostgreSQL + SQLAlchemy 2.0 + Alembic + PGVector 全链路知识。
>
> **审校状态（2026-04-03）**
> - PostgreSQL / SQLAlchemy / 事务 / 索引 / MVCC 等主体内容可直接学
> - Alembic 相关章节已按当前仓库修正：**当前仓库只有一份 init 迁移**
> - 如果本文中的迁移链示意和仓库文件不一致，以 `backend/alembic/versions/efc4bf731595_init.py` 为准

---

## 一、关系型数据库基础

### 1.1 SQL vs NoSQL 的区别和选择

| 维度 | SQL（关系型） | NoSQL（非关系型） |
|------|-------------|-----------------|
| 数据模型 | 表 + 行 + 列，严格 Schema | 文档/键值/列族/图，Schema 灵活 |
| 查询语言 | 标准 SQL | 各家私有 API 或类 SQL |
| 事务支持 | 完整 ACID | 通常只有最终一致性（部分支持事务如 MongoDB 4.0+） |
| 扩展方式 | 垂直扩展为主（加 CPU/内存）；水平扩展成本高 | 天然水平扩展（分片） |
| 适用场景 | 强一致性、复杂查询、关联关系多 | 高吞吐、灵活 Schema、海量数据 |
| 典型代表 | PostgreSQL、MySQL、Oracle | MongoDB、Redis、Cassandra、DynamoDB |

**选择原则：**

- **数据之间有明确的关联关系**（用户 -> 任务 -> 聊天记录），选 SQL。
- **需要事务保证**（比如"创建文档版本 + 更新主表 latest_version"必须原子完成），选 SQL。
- **Schema 变化频繁且数据结构高度异构**，考虑 NoSQL。
- **项目选择**：本项目选择 PostgreSQL，因为：业务数据有严格关联（User -> Task -> ChatMessage）、需要 ACID 事务、需要 PGVector 扩展做向量检索、团队对 SQL 熟悉。

### 1.2 PostgreSQL 的特点和优势

PostgreSQL 是目前最先进的开源关系型数据库，相比 MySQL 有以下核心优势：

1. **丰富的数据类型**：原生支持 JSON/JSONB、数组、范围类型、几何类型、全文搜索（tsvector）。
2. **扩展能力极强**：PGVector（向量检索）、PostGIS（地理信息）、pg_trgm（模糊匹配）都是扩展。
3. **标准 SQL 兼容性最好**：窗口函数、CTE、LATERAL JOIN、UPSERT 等高级特性完整支持。
4. **JSONB 类型**：二进制存储 JSON，支持 GIN 索引，查询性能远超 MySQL 的 JSON 类型。
5. **并发控制**：MVCC（多版本并发控制），读写不阻塞。
6. **可靠性**：WAL（Write-Ahead Logging）保证崩溃恢复。

**本项目使用了 PostgreSQL 的以下特性：**

```python
# JSONB 类型 — 存储聊天消息的元数据（如 RAG 引用来源）
# 文件：backend/app/models/chat.py
meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

# PGVector 扩展 — 向量检索（知识库 RAG）
# 文件：backend/alembic/versions/efc4bf731595_init.py
op.execute("CREATE EXTENSION IF NOT EXISTS vector")

# server_default=func.now() — 利用数据库内置函数生成时间戳
created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

### 1.3 ACID 特性详解

ACID 是关系型数据库事务的四个核心保证，**面试必考**：

#### Atomicity（原子性）

- **是什么**：一个事务中的所有操作要么全部成功，要么全部回滚，不会出现"做到一半"的状态。
- **原理**：通过 undo log（回滚日志）实现。事务执行时先记录"反操作"到 undo log，如果事务失败则按 undo log 逆向回滚。
- **项目实例**：创建知识库文档版本时，需要同时做两件事：创建版本记录 + 更新主表的 `latest_version`。如果只完成了一步就崩溃，数据就不一致了。

```python
# 文件：backend/app/crud/knowledge.py
async def create_version(db: AsyncSession, document_id: int, version: int, ...):
    ver = KnowledgeDocumentVersion(...)
    db.add(ver)
    await db.flush()  # 步骤1：插入版本记录

    doc = await db.get(KnowledgeDocument, document_id)
    if doc:
        doc.latest_version = version  # 步骤2：更新主表

    return ver
    # 这两步在同一个 session/事务中，要么都成功，要么都回滚
```

#### Consistency（一致性）

- **是什么**：事务执行前后，数据必须满足所有约束（主键、外键、唯一约束、CHECK 约束等）。
- **原理**：数据库在每次写入时校验约束条件，违反则拒绝并回滚。
- **项目实例**：`knowledge_document_versions` 表有唯一复合索引 `(document_id, content_hash)`，防止同一文档上传重复文件。

```python
# 文件：backend/app/models/knowledge_document.py
__table_args__ = (
    Index("uq_doc_version", "document_id", "version", unique=True),
    Index("uq_doc_hash", "document_id", "content_hash", unique=True),  # 防止重复上传
)
```

#### Isolation（隔离性）

- **是什么**：并发事务之间互不干扰，每个事务看到的数据状态都是一致的。
- **原理**：通过 MVCC + 锁机制实现（详见下一节"事务隔离级别"）。
- **项目实例**：两个用户同时上传文档，各自的事务看到的 `latest_version` 不会互相干扰。

#### Durability（持久性）

- **是什么**：事务一旦提交，数据就永久保存，即使系统崩溃也不会丢失。
- **原理**：通过 WAL（Write-Ahead Logging）实现。数据修改前先写入 WAL 日志到磁盘，即使进程崩溃，重启后也能从 WAL 恢复。
- **面试关键点**：持久性的前提是磁盘没有物理损坏。所以生产环境还需要备份策略（pg_dump、流复制、PITR）。

### 1.4 事务隔离级别

事务隔离级别决定了"并发事务之间能看到彼此多少未提交/已提交的数据"。隔离级别越高，并发性能越低。

#### 四种隔离级别（从低到高）

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | 性能 |
|---------|------|----------|------|------|
| Read Uncommitted | 可能 | 可能 | 可能 | 最高 |
| Read Committed | 不可能 | 可能 | 可能 | 高 |
| Repeatable Read | 不可能 | 不可能 | 可能（PG 中也不会） | 中 |
| Serializable | 不可能 | 不可能 | 不可能 | 最低 |

**三种并发问题解释：**

1. **脏读（Dirty Read）**：事务 A 读到了事务 B **尚未提交**的数据。如果 B 回滚了，A 读到的就是"脏数据"。
2. **不可重复读（Non-Repeatable Read）**：事务 A 先读一行数据，事务 B 修改并提交了这行，事务 A 再读同一行，发现值变了。
3. **幻读（Phantom Read）**：事务 A 查询满足条件的行集合，事务 B 插入了新行并提交，事务 A 再查同样条件，发现多了几行"幽灵行"。

**PostgreSQL 默认隔离级别：Read Committed**

- 每条 SQL 语句看到的是语句开始时已提交的数据快照。
- 同一事务中两条相同的 SELECT，如果期间有其他事务提交了修改，结果可能不同。
- 对绝大多数 Web 应用来说，Read Committed 够用了。

**PostgreSQL 特殊之处：**

- PG 没有真正的 Read Uncommitted，即使设置了也等同于 Read Committed。
- PG 的 Repeatable Read 基于 MVCC 快照，不仅防止不可重复读，也防止幻读（比 SQL 标准更严格）。
- PG 的 Serializable 使用 SSI（Serializable Snapshot Isolation），不用锁而是检测冲突，性能比传统两阶段锁好。

**面试高频追问：你的项目用了什么隔离级别？为什么？**

答：使用 PostgreSQL 默认的 Read Committed。原因：
1. 我们的业务场景不需要 Repeatable Read（没有"在同一事务中多次读取同一数据并要求一致"的场景）。
2. 知识库文档版本使用了唯一约束（`uq_doc_hash`）来防止并发重复上传，不依赖隔离级别。
3. Read Committed 性能最好，长事务不会累积过多旧版本快照。

---

## 二、ORM（对象关系映射）

### 2.1 什么是 ORM？为什么需要？

**ORM（Object-Relational Mapping）** 是将数据库表映射为编程语言中的类/对象的技术。

**没有 ORM 的写法（裸 SQL）：**

```python
# 手写 SQL，手动处理结果
result = await conn.execute("SELECT id, username FROM users WHERE id = $1", user_id)
row = result.fetchone()
username = row['username']  # 字典取值，没有类型提示，容易拼写错误
```

**用 ORM 的写法：**

```python
# 操作对象，有类型提示，IDE 自动补全
user = await db.get(User, user_id)
username = user.username  # 直接属性访问，IDE 有类型提示
```

**为什么需要 ORM：**

1. **类型安全**：模型字段有类型标注，IDE 能检查拼写错误和类型错误。
2. **减少 SQL 注入风险**：ORM 自动参数化查询。
3. **数据库无关性**：切换数据库（MySQL -> PostgreSQL）时改动极小。
4. **关系导航**：通过 `user.tasks` 直接访问关联数据，不用手写 JOIN。
5. **迁移工具集成**：Alembic 能自动对比模型和数据库的差异生成迁移。

**ORM 的代价：**

- 复杂查询时性能可能不如手写 SQL。
- 需要学习 ORM 框架本身的 API。
- N+1 查询问题（后面详细讲）。

### 2.2 SQLAlchemy 的两种使用方式：Core vs ORM

SQLAlchemy 是 Python 最成熟的数据库工具库，提供两层抽象：

#### Core 层（低级 SQL 表达式）

```python
# Core 风格：直接构建 SQL 表达式
from sqlalchemy import select, table, column

stmt = select(column("username")).select_from(table("users")).where(column("id") == 1)
```

- 更接近 SQL，适合复杂查询、批量操作。
- 不涉及 Python 对象映射。

#### ORM 层（对象映射）

```python
# ORM 风格：操作模型类
from sqlalchemy import select

stmt = select(User).where(User.id == 1)
result = await db.execute(stmt)
user = result.scalar_one_or_none()  # 返回 User 对象
```

- 返回的是 Python 对象（User 实例）。
- 支持 relationship 自动加载关联数据。
- 本项目全部使用 ORM 层。

**实际选择：** 绝大多数项目用 ORM 层，只在极端性能场景（批量写入百万行）才降级到 Core 层。

### 2.3 SQLAlchemy 2.0 新特性

本项目使用 SQLAlchemy 2.0+，这是一次重大升级。核心变化：

#### 声明式模型改用 `DeclarativeBase`（替代旧的 `declarative_base()`）

```python
# 旧写法 (1.x)
from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base()

# 新写法 (2.0) — 本项目使用
# 文件：backend/app/core/database.py
from sqlalchemy.orm import DeclarativeBase

class Base(DeclarativeBase):
    pass
```

#### 使用 `Mapped[]` 类型标注（替代旧的 `Column()`）

```python
# 旧写法 (1.x)
class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String(50), nullable=False)

# 新写法 (2.0) — 本项目使用
# 文件：backend/app/models/user.py
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
```

#### `select()` 统一查询接口（替代旧的 `session.query()`）

```python
# 旧写法 (1.x)
users = session.query(User).filter(User.id == 1).all()

# 新写法 (2.0) — 本项目使用
# 文件：backend/app/crud/user.py
stmt = select(User).where(User.username == username)
result = await db.execute(stmt)
user = result.scalars().first()
```

**为什么要升级到 2.0？**
- `Mapped[]` 带来完整的类型标注支持，IDE 和 mypy 能正确推断类型。
- `select()` 统一了 Core 和 ORM 的查询语法，减少心智负担。
- 更好的异步支持。

### 2.4 Mapped 声明式模型（DeclarativeBase）

`Mapped[T]` 是 SQLAlchemy 2.0 引入的类型标注语法，核心作用：**让 Python 类型系统知道每个字段的类型**。

#### 基本语法规则

```python
# Mapped[int] — 非空整数字段
id: Mapped[int] = mapped_column(primary_key=True)

# Mapped[str] — 非空字符串字段（需要指定 String 长度）
username: Mapped[str] = mapped_column(String(50))

# Mapped[str | None] — 可空字符串字段（nullable=True）
full_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

# Mapped[bool] — 非空布尔字段
is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)

# Mapped[datetime] — 非空时间字段
created_at: Mapped[datetime] = mapped_column(server_default=func.now())

# Mapped[dict | None] — 可空 JSON 字段
detect_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
```

**关键理解：`Mapped[str | None]` 等价于 `nullable=True`。** 类型标注中有 `None` 就意味着该字段可以为 NULL。

#### 本项目的所有模型概览

```
User         — 用户表，所有业务实体的"所有者"
Task         — 检测任务表，含状态机（pending -> progressing -> completed/failed）
ChatMessage  — 聊天消息表，支持多轮对话
ChatImage    — 聊天图片表，与消息一对多
KnowledgeDocument         — 知识库文档表（主表）
KnowledgeDocumentVersion  — 文档版本表（子表，同一文档可有多个版本）
KnowledgeChunkConfig      — 分块配置表（控制 RAG 分块策略）
```

### 2.5 Column 类型映射

SQLAlchemy 类型与 PostgreSQL 类型的对应关系：

| SQLAlchemy 类型 | PostgreSQL 类型 | Python 类型 | 项目中的使用 |
|----------------|----------------|------------|------------|
| `Integer` | `INTEGER` | `int` | `id`, `user_id`, `version` |
| `String(n)` | `VARCHAR(n)` | `str` | `username`, `file_name`, `status` |
| `Text` | `TEXT` | `str` | `content`, `error_message`, `note` |
| `Boolean` | `BOOLEAN` | `bool` | `is_superuser`, `is_current`, `is_active` |
| `DateTime` | `TIMESTAMP` | `datetime` | `created_at`, `updated_at`, `deleted_at` |
| `JSON` | `JSON` | `dict` | `detect_result` |
| `JSONB`（PostgreSQL 方言） | `JSONB` | `dict` | `meta`（聊天消息元数据） |

**JSON vs JSONB 的区别：**

- `JSON`：文本存储，保留原始格式（空格、键顺序），写入快，查询慢。
- `JSONB`：二进制存储，不保留格式，写入稍慢但支持 GIN 索引、支持 `@>`/`?` 等操作符，查询快。
- **原则：除非有特殊理由，一律用 JSONB。** 本项目的 `ChatMessage.meta` 就用了 JSONB。

### 2.6 relationship 和外键

#### 外键定义

```python
# 文件：backend/app/models/task.py
user_id: Mapped[int] = mapped_column(
    ForeignKey("users.id", ondelete="CASCADE"),  # 外键指向 users 表的 id
    index=True  # 外键字段一定要建索引！
)
```

**外键字段为什么要建索引？** 因为 JOIN 查询、CASCADE 删除时数据库都需要按外键查找关联行。没有索引 = 全表扫描 = 性能灾难。

#### relationship 定义

relationship 是 ORM 层的概念，定义了 Python 对象之间的导航关系，**不会在数据库中产生任何额外的列或约束**。

```python
# 文件：backend/app/models/user.py — 一对多（User -> Task）
class User(Base):
    # 反向关系：通过 user.tasks 访问该用户的所有任务
    tasks: Mapped[list["Task"]] = relationship(
        back_populates="owner",      # 对应 Task 模型中的 "owner" 属性
        lazy="selectin",             # 加载策略：使用 SELECT IN 自动加载
        cascade="all, delete-orphan"  # 级联策略：删除 User 时同时删除所有 Task
    )

# 文件：backend/app/models/task.py — 多对一（Task -> User）
class Task(Base):
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    owner: Mapped["User"] = relationship(
        back_populates="tasks",  # 对应 User 模型中的 "tasks" 属性
        lazy="selectin"
    )
```

**back_populates 必须成对出现：**

- `User.tasks` 的 `back_populates="owner"` 指向 `Task.owner`
- `Task.owner` 的 `back_populates="tasks"` 指向 `User.tasks`
- 如果只设置一边，另一边不会自动同步。

**cascade="all, delete-orphan" 含义：**

- `all`：包含 save-update、merge、refresh-expire、expunge、delete。
- `delete-orphan`：当子对象从父对象的集合中移除时，自动删除子对象。
- 注意：这是 ORM 层的级联，与数据库层的 `ondelete="CASCADE"` 是两回事（后面详细讲）。

#### TYPE_CHECKING 的妙用

```python
# 文件：backend/app/models/user.py
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.models.chat import ChatMessage
    from app.models.task import Task
```

**为什么要用 `TYPE_CHECKING`？** 因为 `User` 和 `Task` 模型互相引用（User 有 tasks，Task 有 owner），直接 import 会造成循环导入。`TYPE_CHECKING` 块只在类型检查工具（mypy、IDE）运行时执行，运行时不执行，完美解决循环导入。

### 2.7 `default` vs `server_default` 的区别（非常重要！）

**这是面试高频考点，也是实际项目中最容易踩的坑之一。**

#### default：Python 层面的默认值

```python
# 文件：backend/app/models/task.py
status: Mapped[str] = mapped_column(String(20), nullable=False, default=TaskStatus.PENDING.value)

# 文件：backend/app/models/knowledge_chunk_config.py
chunk_size: Mapped[int] = mapped_column(default=800)
is_active: Mapped[bool] = mapped_column(default=True)
is_default: Mapped[bool] = mapped_column(default=False)
```

**工作原理：**

1. 只有通过 SQLAlchemy ORM 创建对象时才会生效。
2. SQLAlchemy 在 Python 端把默认值赋给对象属性。
3. 生成的 INSERT SQL 会包含这个值。
4. **数据库本身不知道有默认值！** 如果你用 `psql` 手动 INSERT 且不指定该字段，会报错或插入 NULL。

**生成的 DDL：**

```sql
-- default=800 不会出现在 DDL 中
CREATE TABLE knowledge_chunk_config (
    chunk_size INTEGER NOT NULL,  -- 没有 DEFAULT 子句！
    ...
);
```

#### server_default：数据库 DDL 层面的默认值

```python
# 文件：backend/app/models/user.py
created_at: Mapped[datetime] = mapped_column(server_default=func.now())

# 这会在 DDL 中生成：
# created_at TIMESTAMP NOT NULL DEFAULT now()
```

**工作原理：**

1. `server_default` 的值写入数据库的 DDL（表定义），作为列的 DEFAULT 约束。
2. **任何途径的 INSERT**（ORM、裸 SQL、psql 手动插入）都会使用这个默认值。
3. 值由数据库服务器端计算，不经过 Python。

**server_default 的几种写法：**

```python
# 1. 使用 func.now() — 生成 DEFAULT now()
created_at: Mapped[datetime] = mapped_column(server_default=func.now())

# 2. 使用 text() — 生成原始 SQL 表达式
# server_default=text("now()")  效果同上
# server_default=text("false")  用于布尔值
# server_default=text("0")      用于整数

# 3. 直接传字符串 — 注意！会被当作字符串字面量
# server_default="false"  生成 DEFAULT 'false'（字符串 'false'，不是布尔值！）
# server_default=text("false")  生成 DEFAULT false（布尔值 false）
```

**重要区分：`server_default=text("false")` vs `server_default="false"`**

```python
# 正确写法 — 布尔值
is_active: Mapped[bool] = mapped_column(server_default=text("false"))
# DDL: is_active BOOLEAN NOT NULL DEFAULT false

# 错误写法 — 字符串字面量！
is_active: Mapped[bool] = mapped_column(server_default="false")
# DDL: is_active BOOLEAN NOT NULL DEFAULT 'false'
# PostgreSQL 可能报错或隐式转换，MySQL 会出问题
```

#### 什么时候用哪个？

| 场景 | 用 `default` | 用 `server_default` | 原因 |
|------|-------------|-------------------|------|
| 时间戳（created_at） | 不要 | **用这个** | 数据库时钟统一，避免应用服务器时区不一致 |
| 状态初始值（status="pending"） | **用这个** | 也可以 | 业务逻辑控制，简单 |
| 布尔标记（is_active） | **用这个** | 也可以 | Python 控制更直观 |
| 需要 Alembic 迁移识别的默认值 | 不要 | **用这个** | Alembic autogenerate 只检测 server_default |
| 默认值是 Python 函数（如 uuid4） | **用这个** | 不适用 | 数据库不认识 Python 函数 |

**本项目的实践：**

```python
# 时间戳 — 全部用 server_default（正确做法）
created_at: Mapped[datetime] = mapped_column(server_default=func.now())
updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())

# 业务默认值 — 用 default（Python 层面控制）
status: Mapped[str] = mapped_column(String(20), default="active")
is_current: Mapped[bool] = mapped_column(default=True)
chunk_size: Mapped[int] = mapped_column(default=800)
```

**面试答题模板：**

> `default` 是 Python 层面的默认值，只有通过 ORM 创建对象时才生效，不会体现在数据库 DDL 中。`server_default` 是数据库层面的默认值，会写入 DDL 的 DEFAULT 约束，任何途径的 INSERT 都会生效。时间戳字段一定要用 `server_default=func.now()`，因为保证了数据库时钟的统一性。使用 `server_default` 时要注意区分 `text("false")`（SQL 表达式）和 `"false"`（字符串字面量）的区别。

### 2.8 ondelete 策略

外键的 `ondelete` 定义了"当父表记录被删除时，子表关联记录怎么办"。

#### 三种主要策略

**CASCADE（级联删除）：**

```python
# 文件：backend/app/models/task.py
user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
```

- 删除 User 时，该用户的所有 Task 自动被删除。
- 适用于"子记录没有父记录就没有意义"的场景。
- 本项目中：User -> Task、Task -> ChatMessage、ChatMessage -> ChatImage、KnowledgeDocument -> KnowledgeDocumentVersion 都用 CASCADE。

**SET NULL（设为 NULL）：**

```python
user_id: Mapped[int | None] = mapped_column(
    ForeignKey("users.id", ondelete="SET NULL"), nullable=True
)
```

- 删除 User 时，关联的 user_id 字段设为 NULL。
- 适用于"子记录可以独立存在，只是丢失了关联关系"的场景。
- 前提：字段必须 `nullable=True`。

**RESTRICT（限制删除）：**

```python
user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
```

- 如果还有子记录引用父记录，则拒绝删除父记录（抛出异常）。
- 适用于"必须先手动处理子记录才能删除父记录"的场景。
- 这是 PostgreSQL 的默认行为（不指定 ondelete 时）。

#### ORM cascade vs 数据库 ondelete

这是两个不同层面的级联机制，面试容易混淆：

| 维度 | ORM cascade（relationship 参数） | 数据库 ondelete（ForeignKey 参数） |
|------|-------------------------------|--------------------------------|
| 执行层面 | Python/SQLAlchemy 层面 | 数据库引擎层面 |
| 生效条件 | 通过 ORM 删除对象时 | 任何途径删除（ORM、裸 SQL、psql） |
| 对 Alembic 的影响 | 无 | 会写入 DDL |
| 性能 | 差（先 SELECT 子记录再逐个 DELETE） | 好（数据库一次性处理） |

**最佳实践：两者都设置。** ORM cascade 保证 Python 层面的一致性，数据库 ondelete 保证底层数据安全。

```python
# 本项目做法 — 双重保险
# 文件：backend/app/models/user.py
tasks: Mapped[list["Task"]] = relationship(
    cascade="all, delete-orphan"  # ORM 层级联
)

# 文件：backend/app/models/task.py
user_id: Mapped[int] = mapped_column(
    ForeignKey("users.id", ondelete="CASCADE")  # 数据库层级联
)
```

### 2.9 项目中的模型设计总览

```
┌──────────┐       ┌──────────────┐       ┌──────────────┐
│  users   │──1:N──│    tasks      │──1:N──│ chat_messages│
│          │       │              │       │              │
│ id (PK)  │       │ id (PK)      │       │ id (PK)      │
│ username │       │ uuid (UQ)    │       │ user_id (FK) │
│ hashed_pw│       │ file_name    │       │ task_id (FK) │
│ full_name│       │ status       │       │ role         │
│ is_super │       │ user_id (FK) │       │ content      │
│created_at│       │ created_at   │       │ meta (JSONB) │
└──────────┘       └──────────────┘       │ created_at   │
     │                                     └──────┬───────┘
     │                                            │ 1:N
     │                                     ┌──────┴───────┐
     │                                     │  chat_images  │
     │                                     │              │
     │                                     │ id (PK)      │
     │                                     │ message_id(FK│
     │                                     │ file_path    │
     │                                     │ original_name│
     │                                     │ created_at   │
     │                                     └──────────────┘
     │
     │         ┌───────────────────────┐       ┌──────────────────────────┐
     └──1:N──  │ knowledge_documents   │──1:N──│knowledge_document_versions│
               │                       │       │                          │
               │ id (PK)               │       │ id (PK)                  │
               │ doc_key (UQ)          │       │ document_id (FK)         │
               │ title                 │       │ version                  │
               │ status                │       │ file_name                │
               │ latest_version        │       │ storage_path             │
               │ index_status          │       │ content_hash             │
               │ created_by (FK->users)│       │ file_size                │
               │ created_at            │       │ is_current               │
               │ updated_at            │       │ indexed_chunk_config_id  │
               │ deleted_at            │       │ created_by (FK->users)   │
               └───────────────────────┘       │ created_at               │
                                               └──────────┬───────────────┘
                                                          │ N:1
                                               ┌──────────┴───────────────┐
                                               │ knowledge_chunk_config   │
                                               │                          │
                                               │ id (PK)                  │
                                               │ name (UQ)                │
                                               │ splitter                 │
                                               │ chunk_size               │
                                               │ chunk_overlap            │
                                               │ min_chunk_len            │
                                               │ is_active                │
                                               │ is_default               │
                                               │ created_at               │
                                               │ updated_at               │
                                               └──────────────────────────┘
```

---

## 三、异步数据库

### 3.1 为什么需要异步数据库？

**同步的问题：**

在传统同步 Web 框架（Flask/Django）中，每个请求占用一个线程。当请求等待数据库查询返回时，这个线程被阻塞，什么也不能做。如果有 100 个并发请求，就需要 100 个线程。

**异步的解决方案：**

在异步框架（FastAPI/Starlette）中，所有请求运行在同一个事件循环（event loop）中。当请求等待数据库 I/O 时，事件循环可以去处理其他请求。一个线程就能处理上千个并发连接。

```
同步模型：
线程1: [请求A处理] [等待DB...........] [继续处理A]
线程2: [请求B处理] [等待DB.....] [继续处理B]
线程3: [请求C处理] [等待DB........] [继续处理C]
→ 100 个并发需要 100 个线程，内存消耗大

异步模型：
事件循环: [A处理][B处理][C处理][A的DB返回了,继续A][B的DB返回了,继续B]...
→ 1 个线程处理所有请求，遇到 I/O 就切换
```

**关键前提：数据库驱动本身也要是异步的。** 如果用同步驱动（psycopg2），`await db.execute()` 实际上还是阻塞了事件循环。

### 3.2 asyncpg vs psycopg2

| 维度 | asyncpg | psycopg2 |
|------|---------|----------|
| 模式 | 纯异步（async/await） | 同步（阻塞） |
| 性能 | 更快（C 扩展 + 二进制协议） | 相对慢 |
| 协议 | PostgreSQL 二进制协议 | PostgreSQL 文本协议 |
| 生态 | 较新，社区较小 | 老牌，社区最大 |
| 连接字符串前缀 | `postgresql+asyncpg://` | `postgresql+psycopg2://` |

**本项目选择 asyncpg：**

```python
# 文件：backend/app/core/config.py
self.DATABASE_URL = f"postgresql+asyncpg://{self.DB_USER}:{pwd}@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
```

```toml
# 文件：backend/pyproject.toml
"sqlalchemy[asyncio]>=2.0",
"asyncpg>=0.30",
```

**注意 psycopg 3（不是 psycopg2）也支持异步：** `psycopg[binary]` 是 psycopg 3，同时支持同步和异步。但 asyncpg 在纯异步场景下性能仍然领先。

### 3.3 SQLAlchemy AsyncSession

```python
# 文件：backend/app/core/database.py
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

engine = create_async_engine(settings.DATABASE_URL, echo=settings.DB_ECHO)

AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False  # 关键参数！
)
```

**`expire_on_commit=False` 的含义和必要性：**

- 默认行为（`expire_on_commit=True`）：commit 后，所有已加载的对象属性被标记为"过期"。下次访问属性时，SQLAlchemy 会自动发起一条 SELECT 查询来刷新数据。
- **问题**：在异步上下文中，这个自动查询是隐式的 I/O 操作，可能会导致 `MissingGreenlet` 错误或意外的延迟查询。
- **解决**：设置 `expire_on_commit=False`，commit 后对象属性保持原值，不会过期。
- **代价**：commit 后如果其他事务修改了数据，你手上的对象不会自动更新。需要手动 `await db.refresh(obj)` 来刷新。

```python
# 文件：backend/app/crud/user.py — commit 后手动 refresh
async def create_user(db: AsyncSession, user_in: UserCreate) -> model.User:
    user = model.User(...)
    db.add(user)
    await db.commit()
    await db.refresh(user)  # 手动刷新，获取数据库生成的 id 和 created_at
    return user
```

### 3.4 create_async_engine 配置

```python
# 文件：backend/app/core/database.py
engine = create_async_engine(settings.DATABASE_URL, echo=settings.DB_ECHO)
```

**常用参数：**

| 参数 | 含义 | 本项目值 | 建议 |
|------|------|---------|------|
| `echo` | 是否打印 SQL | `settings.DB_ECHO`（开发时 True，生产 False） | 生产关掉 |
| `pool_size` | 连接池常驻连接数 | 默认 5 | 一般 5-20 |
| `max_overflow` | 允许临时超出的连接数 | 默认 10 | pool_size 的 1-2 倍 |
| `pool_recycle` | 连接最长存活秒数 | 默认 -1（不回收） | 建议 3600（1 小时） |
| `pool_pre_ping` | 每次取连接前先 ping | 默认 False | 建议 True（防连接失效） |
| `pool_timeout` | 从池中获取连接的超时秒数 | 默认 30 | 根据业务调 |

**连接池参数详解：**

```
pool_size=5, max_overflow=10
含义：
- 连接池永远保持 5 个空闲连接
- 忙的时候最多再创建 10 个临时连接（共 15 个）
- 超出后新请求会等待（pool_timeout 秒）
- 临时连接用完后会被关闭，回到 5 个常驻连接

pool_recycle=3600
含义：
- 连接存活超过 3600 秒后，在下次被取出时会被关闭并重新创建
- 防止数据库端 idle connection timeout 导致连接失效
- 特别是 MySQL 有 wait_timeout（默认 28800 秒），PG 通常没有
```

### 3.5 async with 上下文管理器

异步上下文管理器确保资源的正确获取和释放：

```python
# 文件：backend/alembic/env.py — 异步连接管理
async with connectable.connect() as connection:
    await connection.run_sync(do_run_migrations)
# 退出 async with 时自动释放连接

# 文件：backend/app/core/database.py — 异步 Session 管理
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except:
            logger.exception("Database session error")
            await session.rollback()
            raise
        finally:
            await session.close()
```

**为什么必须用 `async with`？**

- 保证连接/Session 一定被释放，即使发生异常。
- 防止连接泄漏（连接用完不归还池子 = 池子被耗尽 = 新请求卡死）。

### 3.6 项目中的异步数据库配置

完整的异步数据库架构：

```
FastAPI 请求
    │
    ▼
get_db() 依赖注入 — 从 AsyncSessionLocal 获取 AsyncSession
    │
    ▼
AsyncSessionLocal — async_sessionmaker，管理 Session 生命周期
    │
    ▼
engine — create_async_engine，管理连接池
    │
    ▼
asyncpg 驱动 — 纯异步，二进制协议
    │
    ▼
PostgreSQL 数据库
```

**关键配置文件：**

- `backend/app/core/config.py` — 数据库连接字符串的构建
- `backend/app/core/database.py` — engine、SessionLocal、get_db 的定义
- `backend/app/main.py` — lifespan 中的启动和关闭

```python
# 文件：backend/app/main.py — 应用关闭时释放连接池
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ... 启动逻辑
    yield
    # 关闭时释放引擎的所有连接
    await engine.dispose()
```

---

## 四、Alembic 数据库迁移

### 4.1 什么是数据库迁移？为什么需要？

**数据库迁移（Database Migration）** 是对数据库 Schema（表结构）进行版本化管理的机制。

**没有迁移工具的痛苦：**

1. 开发者 A 加了一个字段，手动在本地 ALTER TABLE。
2. 开发者 B 拉了代码，模型有新字段但数据库没有 → 应用启动就报错。
3. 部署到生产环境时，手动执行 SQL → 容易遗漏、顺序错误、无法回滚。

**有迁移工具后：**

1. 开发者 A 修改模型后运行 `alembic revision --autogenerate`，生成迁移文件。
2. 开发者 B 拉代码后运行 `alembic upgrade head`，数据库自动同步。
3. 部署到生产环境时 `alembic upgrade head`，自动、可重复、可回滚。

### 4.2 Alembic 核心概念

#### revision（版本/修订）

每个迁移文件有一个唯一的 revision ID（通常是随机哈希），以及一个 `down_revision` 指向前一个版本。  
**当前仓库现状**：只有一份 init 迁移，所以它的 `down_revision = None`。

```python
# 文件：backend/alembic/versions/efc4bf731595_init.py
revision: str = "efc4bf731595"  # 我是谁
down_revision: str | Sequence[str] | None = None  # 当前仓库是初始迁移
```

#### upgrade() 和 downgrade()

每个迁移文件包含两个函数：

```python
def upgrade() -> None:
    """前进：应用这个迁移的变更"""
    op.create_table("users", ...)

def downgrade() -> None:
    """回退：撤销这个迁移的变更"""
    op.drop_table("users")
```

- `alembic upgrade head` → 按顺序执行所有未应用的 `upgrade()`
- `alembic downgrade -1` → 执行最近一个迁移的 `downgrade()`

#### 迁移链

Alembic 通过 `revision` → `down_revision` 形成一条链表。  
但**当前仓库还没有形成多版本迁移链**，真实状态只有一份初始迁移：

```
efc4bf731595 (init — 创建 users/tasks/chat/knowledge 相关表并启用 vector 扩展)
```

如果后续继续演进，才会形成真正的多迁移链。  
所以你面试时可以讲 Alembic 的工作原理，但**不能把一整条历史迁移链讲成当前仓库事实**。

### 4.3 迁移文件结构

以当前仓库的 init 迁移为例：

```python
# 文件：backend/alembic/versions/efc4bf731595_init.py

"""init                                      ← 迁移描述

Revision ID: efc4bf731595                     ← 唯一 ID
Revises:                                      ← 当前仓库无前一个版本
Create Date: 2026-03-25 04:36:56.304277       ← 创建时间
"""

revision: str = "efc4bf731595"
down_revision: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=50), nullable=False),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("original_path", sa.String(length=500), nullable=True),
        sa.Column("result_path", sa.String(length=500), nullable=True),
        sa.Column("detect_result", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # 创建索引
    op.create_index(op.f("ix_tasks_id"), "tasks", ["id"], unique=False)
    op.create_index(op.f("ix_tasks_user_id"), "tasks", ["user_id"], unique=False)
    op.create_index(op.f("ix_tasks_uuid"), "tasks", ["uuid"], unique=True)

def downgrade() -> None:
    # 回退时先删索引再删表
    op.drop_index(op.f("ix_tasks_uuid"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_user_id"), table_name="tasks")
    op.drop_index(op.f("ix_tasks_id"), table_name="tasks")
    op.drop_table("tasks")
```

### 4.4 `alembic revision --autogenerate` 原理

**Autogenerate 的工作流：**

1. Alembic 读取数据库当前的 Schema（通过 INFORMATION_SCHEMA 或 PG 系统表）。
2. Alembic 读取 Python 模型的元数据（`target_metadata = Base.metadata`）。
3. 对比两者的差异，自动生成迁移代码。

**能自动检测的变更：**

- 新增/删除表
- 新增/删除列
- 列类型变更
- 新增/删除索引
- 新增/删除外键约束
- `server_default` 变更

**不能自动检测的变更：**

- 表重命名（会被识别为"删旧表 + 创新表"）
- 列重命名（同上）
- `default`（Python 层面默认值）的变更
- 数据迁移（如把一列的值转移到另一列）
- 自定义 CHECK 约束

**Alembic 的 env.py 配置：**

```python
# 文件：backend/alembic/env.py

# 关键1：导入 Base 以获取模型元数据
from app.core.database import Base
target_metadata = Base.metadata

# 关键2：导入所有模型，确保 Base.metadata 包含所有表定义
from app.models.user import User       # noqa: F401
from app.models.task import Task       # noqa: F401
from app.models.chat import ChatImage, ChatMessage  # noqa: F401
from app.models.knowledge import (     # noqa: F401
    KnowledgeChunkConfig,
    KnowledgeDocument,
    KnowledgeDocumentVersion,
)

# 关键3：动态设置数据库 URL
config.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
```

**如果忘了在 env.py 中 import 某个模型会怎样？**
→ Autogenerate 看不到这个模型 → 不会为它生成迁移 → 数据库中不会有这张表。
→ 甚至更危险：如果表已存在，autogenerate 会生成"删除这张表"的迁移！

### 4.5 异步迁移配置

本项目使用异步数据库驱动（asyncpg），Alembic 也需要异步配置：

```python
# 文件：backend/alembic/env.py

async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,  # 迁移用一次性连接，不需要连接池
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)  # 把同步的迁移逻辑包装到异步上下文
    await connectable.dispose()

def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())  # 用 asyncio.run 启动异步迁移
```

**`connection.run_sync(do_run_migrations)` 的含义：**

Alembic 的内部迁移逻辑是同步的，`run_sync()` 是 SQLAlchemy 提供的桥接方法，让同步代码运行在异步连接上。

### 4.6 多人协作时的迁移冲突处理

**场景：** 开发者 A 和 B 各自创建了迁移，`down_revision` 都指向同一个版本。

```
A 的迁移: revision=aaa, down_revision=base_rev
B 的迁移: revision=bbb, down_revision=base_rev
→ 出现分叉！Alembic 报错："Multiple heads detected"
```

**解决方法：**

```bash
# 1. 查看当前头（heads）
alembic heads

# 2. 合并分叉（创建一个 merge revision）
alembic merge aaa bbb -m "merge_heads"

# 或者（更简单的方法）：
# 3. 手动修改其中一个的 down_revision，让它们形成链
#    把 B 的 down_revision 改为 A 的 revision
```

**通用迁移修复示例（不是当前仓库里的既有迁移文件）：**

```python
# 下面是一个“列名/列类型修复”的通用写法示例
# 当前仓库中并没有这个历史迁移文件

def upgrade() -> None:
    # 1. 修复列名拼写错误：create_by → created_by
    op.alter_column("knowledge_documents", "create_by", new_column_name="created_by")
    op.alter_column("knowledge_chunk_config", "create_by", new_column_name="created_by")

    # 2. 修复列类型错误：file_size 从 VARCHAR 改为 INTEGER
    op.alter_column(
        "knowledge_document_versions",
        "file_size",
        type_=sa.Integer(),
        postgresql_using="file_size::integer",  # PostgreSQL 特有的类型转换语法
    )
```

**`postgresql_using` 的作用：** PostgreSQL 修改列类型时，如果不能隐式转换（如 VARCHAR → INTEGER），需要指定 USING 子句告诉数据库怎么转换。`file_size::integer` 就是 PG 的类型转换语法。

### 4.7 常用 Alembic 命令

```bash
# 生成迁移文件（自动检测模型变更）
alembic revision --autogenerate -m "add_users_table"

# 应用所有未执行的迁移
alembic upgrade head

# 回退最近一个迁移
alembic downgrade -1

# 回退到指定版本
alembic downgrade <revision_id>

# 查看当前数据库版本
alembic current

# 查看迁移历史
alembic history --verbose

# 查看所有头版本（检测分叉）
alembic heads

# 创建空迁移（手动编写迁移逻辑）
alembic revision -m "manual_migration"
```

---

## 五、PGVector 扩展

### 5.1 什么是 PGVector？

PGVector 是 PostgreSQL 的扩展，为数据库添加了**向量数据类型和向量相似度搜索能力**。它让你可以在 PostgreSQL 中直接存储和检索 embedding 向量，不需要额外部署 Milvus、Pinecone 等专用向量数据库。

**为什么选择 PGVector 而不是独立向量数据库？**

1. **运维简单**：不需要额外部署和维护一个向量数据库。
2. **事务一致性**：向量数据和业务数据在同一个数据库，可以用事务保证一致性。
3. **JOIN 查询**：可以在同一条 SQL 中 JOIN 业务表和向量表。
4. **成本低**：中小规模（几十万条向量）PGVector 性能完全够用。

**何时需要专用向量数据库？**

- 向量数量超过千万级
- 需要分布式/多副本
- 查询 QPS 非常高（>1000/s）

### 5.2 Vector 列类型

```sql
-- PGVector 添加的新数据类型
CREATE TABLE embeddings (
    id SERIAL PRIMARY KEY,
    text TEXT NOT NULL,
    embedding VECTOR(1536)  -- 1536 维向量（OpenAI text-embedding-ada-002 的维度）
);
```

**本项目中的 PGVector 使用：**

```python
# 文件：backend/alembic/versions/efc4bf731595_init.py
def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
```

本项目通过 LlamaIndex 的 `PGVectorStore` 间接使用 PGVector。LlamaIndex 会自动创建向量存储表（如 `data_wind_knowledge`），包含 `embedding` 列。

### 5.3 向量索引：IVFFlat vs HNSW

向量搜索如果做暴力全表扫描（逐个计算距离），百万级数据时查询会非常慢。向量索引通过近似最近邻搜索（ANN）加速查询。

#### IVFFlat（Inverted File with Flat Compression）

```sql
CREATE INDEX ON embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

**原理：**

1. 将向量空间划分为 N 个聚类（lists）。
2. 查询时，先找到最近的几个聚类。
3. 只在这几个聚类内部做精确搜索。

**参数：**

- `lists`：聚类数量。一般设为 `sqrt(总行数)`。
- `probes`（查询参数）：搜索多少个聚类。越大越精确但越慢。

**特点：**

- 构建速度快（只需要一次 K-Means 聚类）
- 需要先有数据再建索引（空表建索引无效）
- 精度可能不如 HNSW

#### HNSW（Hierarchical Navigable Small World）

```sql
CREATE INDEX ON embeddings USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

**原理：**

1. 构建一个多层图结构，每层是一个"小世界网络"。
2. 查询时从最高层开始，逐层下降，每层做局部搜索。
3. 类似于跳表（Skip List）的思想。

**参数详解：**

| 参数 | 含义 | 默认值 | 建议 |
|------|------|--------|------|
| `m` | 每个节点的最大连接数 | 16 | 越大精度越高，但索引越大、构建越慢 |
| `ef_construction` | 构建时的搜索宽度 | 64 | 越大构建越精确但越慢，建议 100-200 |
| `ef_search`（查询参数） | 查询时的搜索宽度 | 40 | 越大查询越精确但越慢 |

**特点：**

- 查询精度高（通常优于 IVFFlat）
- 构建速度慢（尤其是大数据集）
- 索引体积大（存储了图结构）
- 可以在空表上建索引
- **目前业界推荐 HNSW**

#### IVFFlat vs HNSW 对比

| 维度 | IVFFlat | HNSW |
|------|---------|------|
| 查询精度 | 中等 | 高 |
| 构建速度 | 快 | 慢 |
| 查询速度 | 快 | 更快 |
| 内存占用 | 小 | 大 |
| 空表建索引 | 不可以 | 可以 |
| 适用场景 | 数据量大、频繁重建 | 追求查询精度 |

### 5.4 距离函数

| 函数 | 操作符 | SQL 操作符类 | 适用场景 |
|------|--------|------------|---------|
| L2 距离（欧氏距离） | `<->` | `vector_l2_ops` | 通用，值越小越相似 |
| 内积（Inner Product） | `<#>` | `vector_ip_ops` | 向量已归一化时，等价于余弦相似度 |
| 余弦距离 | `<=>` | `vector_cosine_ops` | **最常用**，不受向量长度影响 |

**余弦距离 vs 余弦相似度：**

- 余弦相似度 = 1 - 余弦距离
- PGVector 返回的是距离（越小越相似），不是相似度

**本项目使用余弦距离**，因为 embedding 模型输出的向量长度不一定是单位长度，余弦距离自动归一化。

### 5.5 项目中的 PGVector 使用

本项目通过 LlamaIndex 的 `PGVectorStore` 使用 PGVector：

```python
# LlamaIndex 底层会创建类似这样的表
# 下面是“可能出现的向量表结构”的示意，不是当前仓库里的历史 downgrade 文件：

op.create_table('data_wind_knowledge',
    sa.Column('id', sa.BIGINT(), autoincrement=True, nullable=False),
    sa.Column('text', sa.VARCHAR(), nullable=False),           # 原始文本
    sa.Column('metadata_', postgresql.JSON(), nullable=True),   # 元数据（文件名、chunk_id 等）
    sa.Column('node_id', sa.VARCHAR(), nullable=True),          # LlamaIndex 节点 ID
    sa.Column('embedding', sa.NullType(), nullable=True),       # 向量（VECTOR 类型）
    sa.Column('text_search_tsv', postgresql.TSVECTOR(), ...),   # 全文搜索（GIN 索引）
)
# GIN 索引用于全文搜索
op.create_index('wind_knowledge_idx', 'data_wind_knowledge', ['text_search_tsv'], postgresql_using='gin')
# 按 ref_doc_id 查询的索引（用于按文档删除/更新向量）
op.create_index('wind_knowledge_idx_1', 'data_wind_knowledge', [sa.literal_column("(metadata_ ->> 'ref_doc_id'::text)")])
```

当前仓库层面的准确信息是：

- Alembic 目录下当前只有一个初始化迁移：`backend/alembic/versions/efc4bf731595_init.py`
- 向量扩展的创建也只在这次初始化迁移中出现一次：`CREATE EXTENSION IF NOT EXISTS vector`
- 如果后续新增知识库表、向量表或索引，应该以新迁移文件为准，不要把上面的示意代码当成仓库现状去背

这里可以看到 LlamaIndex 的 PGVectorStore 同时使用了：
1. **向量搜索**（embedding 列 + 向量索引）
2. **全文搜索**（text_search_tsv 列 + GIN 索引）

这是一种**混合搜索（Hybrid Search）** 策略，结合向量语义搜索和关键词搜索，提高检索质量。

---

## 六、查询优化

### 6.1 N+1 查询问题

**什么是 N+1 问题？**

```python
# 假设有 100 个用户，每个用户有若干个任务
users = await db.execute(select(User))  # 1 条 SQL：SELECT * FROM users
for user in users.scalars().all():
    print(user.tasks)  # 每个用户触发 1 条 SQL：SELECT * FROM tasks WHERE user_id = ?
# 总共：1 + 100 = 101 条 SQL！
```

这就是 N+1 问题：1 条查询获取主表数据 + N 条查询获取关联数据。

**为什么严重？** 每条 SQL 都有网络往返（RTT）开销。如果 RTT = 1ms，100 条 = 100ms。如果表更多、嵌套更深，很快就变成秒级延迟。

### 6.2 Eager Loading vs Lazy Loading

#### Lazy Loading（懒加载）— 默认行为

```python
# 访问 relationship 属性时才发起查询
user = await db.get(User, 1)
# 到这里只执行了 1 条 SQL

tasks = user.tasks  # 这时才执行 SELECT * FROM tasks WHERE user_id = 1
# 又多了 1 条 SQL
```

**问题：** 在异步上下文中，Lazy Loading 可能导致 `MissingGreenlet` 错误，因为隐式发起的查询没有被 `await`。

#### Eager Loading（预加载）— 解决 N+1

在主查询时就一并加载关联数据，有两种策略：

**selectinload（SELECT IN 加载）：**

```python
# 文件：backend/app/crud/task.py
stmt = base_stmt.options(selectinload(Task.owner)).order_by(Task.created_at.desc())
```

生成的 SQL：
```sql
SELECT * FROM tasks ORDER BY created_at DESC LIMIT 10;  -- 查询1：主表
SELECT * FROM users WHERE id IN (1, 2, 3, 5, 8);        -- 查询2：关联用户（批量 IN）
```

总共 2 条 SQL，不管有多少条记录。

**joinedload（JOIN 加载）：**

```python
stmt = select(Task).options(joinedload(Task.owner))
```

生成的 SQL：
```sql
SELECT tasks.*, users.* FROM tasks LEFT JOIN users ON tasks.user_id = users.id;
-- 1 条 SQL 搞定
```

#### selectinload vs joinedload 对比

| 维度 | selectinload | joinedload |
|------|-------------|------------|
| SQL 数量 | 2 条（主 + IN 子查询） | 1 条（JOIN） |
| 数据重复 | 无 | 有（一对多时父表数据重复） |
| 适用场景 | 一对多 | 多对一、一对一 |
| 分页兼容 | 好 | 差（JOIN 后 LIMIT 不准确） |

**本项目的策略：全部使用 `lazy="selectin"`**

```python
# 文件：backend/app/models/user.py
tasks: Mapped[list["Task"]] = relationship(
    back_populates="owner", lazy="selectin", cascade="all, delete-orphan"
)
chats: Mapped[list["ChatMessage"]] = relationship(
    back_populates="user", lazy="selectin", cascade="all, delete-orphan"
)
```

`lazy="selectin"` 等价于在每次查询时自动加上 `selectinload`，不需要在每个查询语句中手动添加 `.options()`。

**注意：** 在模型定义中设置 `lazy="selectin"` 是方便但要谨慎的做法。如果某些查询不需要关联数据，会造成不必要的 SQL。更精细的做法是在模型中设 `lazy="raise"`（禁止懒加载），在每个查询中显式指定加载策略。

### 6.3 索引的类型和使用

#### B-Tree 索引（默认）

最常用的索引类型，适用于等值查询和范围查询。

```python
# 本项目中大量使用
id: Mapped[int] = mapped_column(primary_key=True, index=True)
username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
```

#### GIN 索引（Generalized Inverted Index）

适用于 JSONB、数组、全文搜索等"包含"类查询。

```python
# 本项目中 LlamaIndex 创建的全文搜索索引
op.create_index('wind_knowledge_idx', 'data_wind_knowledge',
    ['text_search_tsv'], postgresql_using='gin')
```

#### 唯一索引（Unique Index）

```python
# 文件：backend/app/models/knowledge_document.py
__table_args__ = (
    Index("uq_doc_version", "document_id", "version", unique=True),   # 同一文档的版本号不能重复
    Index("uq_doc_hash", "document_id", "content_hash", unique=True), # 同一文档的内容哈希不能重复
)
```

#### 复合索引（Composite Index）

```python
# 文件：backend/app/models/chat.py
__table_args__ = (Index("idx_chat_user_task", "user_id", "task_id"),)
```

**复合索引的列顺序很重要：** `(user_id, task_id)` 索引可以加速：
- `WHERE user_id = ?`（只用了第一列，没问题）
- `WHERE user_id = ? AND task_id = ?`（两列都用，最优）
- **不能**加速 `WHERE task_id = ?`（跳过了第一列，索引无效）

这就是**最左前缀原则**。

### 6.4 EXPLAIN ANALYZE 查询分析

```sql
EXPLAIN ANALYZE SELECT * FROM tasks WHERE user_id = 1;

-- 输出示例：
-- Index Scan using ix_tasks_user_id on tasks  (cost=0.15..8.17 rows=1 width=200) (actual time=0.020..0.021 rows=3 loops=1)
--   Index Cond: (user_id = 1)
-- Planning Time: 0.100 ms
-- Execution Time: 0.040 ms
```

**关键指标：**

- `Index Scan`：使用了索引。如果看到 `Seq Scan` 说明全表扫描，需要优化。
- `cost`：预估成本（相对值）。
- `actual time`：实际执行时间。
- `rows`：返回行数。
- `Planning Time`：查询计划生成时间。
- `Execution Time`：实际执行时间。

### 6.5 项目中的查询优化策略

**策略 1：使用 subquery 保证 count 和 list 查询条件一致**

```python
# 文件：backend/app/crud/task.py
base_stmt = select(Task)
if not is_superuser:
    base_stmt = base_stmt.where(Task.user_id == user_id)

# count 查询复用同一个 base_stmt
total_stmt = select(func.count()).select_from(base_stmt.subquery())
total = (await db.execute(total_stmt)).scalar_one()

# list 查询也复用同一个 base_stmt
stmt = base_stmt.options(selectinload(Task.owner)).order_by(Task.created_at.desc())
```

**策略 2：使用 `db.get()` 按主键查询**

```python
# 文件：backend/app/crud/knowledge.py
doc = await db.get(KnowledgeDocument, document_id)
```

`db.get()` 会先检查 Session 的 identity map（缓存），如果对象已经在内存中就直接返回，不发起 SQL。

**策略 3：使用 `flush()` 代替 `commit()` 获取中间结果**

```python
# 文件：backend/app/crud/knowledge.py
async def create_version(db: AsyncSession, ...):
    ver = KnowledgeDocumentVersion(...)
    db.add(ver)
    await db.flush()  # flush 会执行 INSERT 但不 commit，可以拿到 ver.id
    # 然后用 ver.id 做其他操作
    # 最终由调用方决定 commit 还是 rollback
```

`flush()` vs `commit()` 的区别：
- `flush()`：把 ORM 内存中的变更写入数据库事务，但不提交。后续可以 rollback。
- `commit()`：flush + 提交事务。不可逆。

---

## 七、数据库连接管理

### 7.1 连接池的概念和必要性

**没有连接池的问题：**

```
每个请求:  建连接(~50ms) → 执行SQL(~5ms) → 关连接(~10ms)
100 个并发: 100 * 65ms = 6.5 秒的连接开销
而且同时创建 100 个连接，数据库可能被打爆
```

**有连接池后：**

```
应用启动时: 预创建 5 个连接放入池中
每个请求:  从池中取连接(~0ms) → 执行SQL(~5ms) → 归还连接(~0ms)
100 个并发: 复用 5-15 个连接，数据库压力可控
```

### 7.2 连接池参数调优

```python
engine = create_async_engine(
    DATABASE_URL,
    pool_size=5,         # 常驻连接数
    max_overflow=10,     # 临时连接数
    pool_recycle=3600,   # 连接最长存活秒数
    pool_pre_ping=True,  # 取连接前 ping 一下
    pool_timeout=30,     # 等待空闲连接的超时
)
```

**调优原则：**

| 参数 | 调大的代价 | 调小的代价 | 建议 |
|------|----------|----------|------|
| `pool_size` | 数据库连接数增多，占内存 | 高并发时等待 | 等于平均并发数 |
| `max_overflow` | 突发流量时连接更多 | 突发时排队 | pool_size 的 1-2 倍 |
| `pool_recycle` | 连接频繁重建 | 可能用到失效连接 | 小于 DB 的 idle timeout |
| `pool_timeout` | - | 报错太快不友好 | 30 秒 |

**PostgreSQL 最大连接数（`max_connections`）：** 默认 100。你的所有应用实例的 `pool_size + max_overflow` 之和不能超过这个值。

### 7.3 连接泄漏和排查

**什么是连接泄漏？**
从连接池取出连接后，没有归还。池子里可用连接越来越少，最终耗尽，新请求永远等待。

**常见原因：**

1. 异常时没有 close/rollback。
2. 手动创建 Session 后忘记关闭。
3. 异步代码中 Session 跨越了 await 边界。

**本项目的防泄漏措施：**

```python
# 文件：backend/app/core/database.py
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:  # async with 保证退出时关闭
        try:
            yield session
        except:
            logger.exception("Database session error")
            await session.rollback()  # 异常时回滚
            raise
        finally:
            await session.close()    # 无论如何都关闭
```

**排查手段：**

```sql
-- 查看 PostgreSQL 当前活跃连接
SELECT count(*) FROM pg_stat_activity WHERE state = 'active';

-- 查看所有连接及其状态
SELECT pid, state, query, query_start, client_addr
FROM pg_stat_activity
WHERE datname = 'your_db';

-- 如果发现大量 idle in transaction 连接，说明事务没有 commit/rollback
```

### 7.4 FastAPI 依赖注入中的 Session 管理

FastAPI 通过依赖注入系统（`Depends`）管理 Session 生命周期：

```python
# 文件：backend/app/core/database.py
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except:
            await session.rollback()
            raise
        finally:
            await session.close()

# 文件：backend/app/routers/task.py（使用示例）
@router.get("/tasks")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    # db 在路由函数执行期间有效
    # 路由函数返回后，get_db 的 finally 自动关闭 session
    return await get_tasks_paginated(db, ...)
```

**生命周期：**

```
收到请求
  → FastAPI 调用 get_db()
    → async with AsyncSessionLocal() as session
      → yield session  ← 此时执行路由函数
      → 路由函数返回（正常或异常）
    → finally: await session.close()  ← 自动清理
返回响应
```

### 7.5 `get_db()` 生成器模式

`get_db()` 使用了 Python 的异步生成器模式（`async def` + `yield`），这是 FastAPI 依赖注入的核心模式：

```python
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session       # yield 前的代码 = 初始化（请求开始时执行）
        except:                 # 路由函数执行期间的异常
            await session.rollback()
            raise
        finally:                # yield 后的代码 = 清理（请求结束时执行）
            await session.close()
```

**为什么不用普通函数？**

```python
# 错误做法：
async def get_db():
    session = AsyncSessionLocal()
    return session  # 返回后就失去控制了，谁来 close？
```

生成器的优势在于：`yield` 之后的代码保证执行，无论请求成功还是失败。

### 7.6 项目中的连接管理架构

```
                           ┌─────────────────────┐
                           │   FastAPI 路由层     │
                           │                     │
                           │  Depends(get_db)     │
                           └─────────┬───────────┘
                                     │
                           ┌─────────▼───────────┐
                           │   get_db() 生成器    │
                           │                     │
                           │  创建 Session        │
                           │  yield → 路由执行    │
                           │  异常 → rollback     │
                           │  finally → close     │
                           └─────────┬───────────┘
                                     │
                           ┌─────────▼───────────┐
                           │ AsyncSessionLocal    │
                           │ (async_sessionmaker) │
                           │                     │
                           │ expire_on_commit=    │
                           │   False              │
                           └─────────┬───────────┘
                                     │
                           ┌─────────▼───────────┐
                           │ create_async_engine  │
                           │   (连接池)           │
                           │                     │
                           │ pool_size=5          │
                           │ max_overflow=10      │
                           └─────────┬───────────┘
                                     │
                           ┌─────────▼───────────┐
                           │   asyncpg 驱动      │
                           │                     │
                           │ postgresql+asyncpg   │
                           └─────────┬───────────┘
                                     │
                           ┌─────────▼───────────┐
                           │   PostgreSQL 数据库   │
                           └─────────────────────┘
```

---

## 八、数据建模

### 8.1 用户表设计

```python
# 文件：backend/app/models/user.py
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    is_superuser: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

**设计要点：**

1. **密码哈希存储**：`hashed_password` 而非 `password`，永远不存明文密码。String(255) 因为 Argon2 哈希值较长。
2. **username 唯一索引**：`unique=True, index=True`。唯一约束自带索引，但显式加 `index=True` 让意图更明确。
3. **is_superuser 用 default 而非 server_default**：默认不是超级管理员，且这个值只通过 ORM 创建。
4. **created_at 用 server_default**：数据库时钟统一，不受应用服务器时区影响。

### 8.2 任务表设计（状态机）

```python
# 文件：backend/app/models/task.py
class TaskStatus(Enum):
    PENDING = "pending"
    PROGRESSING = "progressing"
    COMPLETED = "completed"
    FAILED = "failed"

class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    uuid: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default=TaskStatus.PENDING.value)
    original_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    result_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    detect_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
```

**设计要点：**

1. **UUID 作为外部标识**：`uuid` 字段用于 API 层暴露给前端，而 `id` 是内部自增主键。这样避免暴露数据库自增 ID（安全考虑 + 防止被猜测）。
2. **状态机设计**：用 Python Enum 定义合法状态值，`default=TaskStatus.PENDING.value`。
3. **状态转换流程**：

```
PENDING  →  PROGRESSING  →  COMPLETED
                         →  FAILED
```

4. **`result_path` 可空**：任务创建时还没有结果，完成后才有。
5. **`detect_result` 用 JSON 类型**：YOLO 检测结果是动态结构（不同图片检测到的目标数量不同），适合 JSON。

### 8.3 知识库相关表设计

知识库采用了**主表 + 版本表 + 配置表**的三表设计：

```python
# 文件：backend/app/models/knowledge_document.py

# 主表：文档
class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    doc_key: Mapped[str] = mapped_column(String(120), unique=True, index=True)  # 文档唯一标识
    title: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active/deleted
    latest_version: Mapped[int] = mapped_column(default=0)  # 最新版本号（冗余字段，加速查询）

    # 索引状态
    indexed_at: Mapped[datetime | None] = mapped_column(nullable=True)
    index_status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 审计字段
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[datetime | None] = mapped_column(nullable=True)  # 软删除时间

# 版本表：同一文档可以有多个版本
class KnowledgeDocumentVersion(Base):
    __tablename__ = "knowledge_document_versions"
    __table_args__ = (
        Index("uq_doc_version", "document_id", "version", unique=True),
        Index("uq_doc_hash", "document_id", "content_hash", unique=True),
    )
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("knowledge_documents.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column()
    content_hash: Mapped[str] = mapped_column(String(64), index=True)  # 文件内容 SHA256
    file_size: Mapped[int] = mapped_column(default=0)
    is_current: Mapped[bool] = mapped_column(default=True)
    indexed_chunk_config_id: Mapped[int | None] = mapped_column(
        ForeignKey("knowledge_chunk_config.id"), nullable=True
    )
```

**设计要点：**

1. **版本化设计**：同一篇文档可以上传多个版本，通过 `is_current` 标记当前版本。
2. **content_hash 去重**：通过 SHA256 哈希检测文件内容是否真的变了，避免重复上传完全相同的文件。
3. **`(document_id, content_hash)` 唯一约束**：数据库层面保证去重。
4. **软删除**：`status = "deleted"` + `deleted_at` 时间戳，而非物理删除。
5. **`latest_version` 冗余字段**：虽然可以从版本表 MAX(version) 查到，但冗余在主表上避免了每次都 JOIN 版本表。
6. **`onupdate=func.now()`**：`updated_at` 字段在 ORM 层面更新时自动设置为当前时间。

### 8.4 聊天消息表设计

```python
# 文件：backend/app/models/chat.py
class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True, nullable=True
    )
    role: Mapped[str] = mapped_column(String(20))  # "user" 或 "assistant"
    content: Mapped[str] = mapped_column(Text)       # 消息内容
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)  # 元数据
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (Index("idx_chat_user_task", "user_id", "task_id"),)

class ChatImage(Base):
    __tablename__ = "chat_images"
    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="CASCADE"), index=True
    )
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    original_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

**设计要点：**

1. **`task_id` 可空**：聊天消息可以关联到某个任务（讨论检测结果），也可以独立存在（通用对话）。
2. **复合索引 `(user_id, task_id)`**：加速"查询某用户某任务下的聊天记录"这一高频查询。
3. **`meta` 用 JSONB**：存储 RAG 引用的知识来源、模型参数等动态元数据。用 JSONB 而非 JSON，因为需要高效查询。
4. **图片分表**：图片信息独立一张表（`chat_images`），而非存在消息表的 JSON 字段中。这样可以单独管理图片文件、统计图片数量。
5. **`ondelete="CASCADE"` 级联链**：删除用户 → 删除该用户所有消息 → 删除这些消息的所有图片。

### 8.5 分块配置表设计

```python
# 文件：backend/app/models/knowledge_chunk_config.py
class KnowledgeChunkConfig(Base):
    __tablename__ = "knowledge_chunk_config"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)        # 配置名称
    splitter: Mapped[str] = mapped_column(String(30), default="sentence")  # 分块策略
    chunk_size: Mapped[int] = mapped_column(default=800)               # 分块大小
    chunk_overlap: Mapped[int] = mapped_column(default=150)            # 分块重叠
    min_chunk_len: Mapped[int] = mapped_column(default=20)             # 最小分块长度
    metadata_policy: Mapped[str] = mapped_column(String(30), default="basic")  # 元数据策略
    is_active: Mapped[bool] = mapped_column(default=True)              # 是否启用
    is_default: Mapped[bool] = mapped_column(default=False)            # 是否为默认配置
    created_by: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())
```

**设计要点：**

1. **可配置的分块策略**：RAG 系统的分块参数（chunk_size、overlap 等）不硬编码在代码中，而是存在数据库中。
2. **全局默认配置**：通过 `is_default=True` 标记一个默认配置。切换默认时需要先清除旧的默认。
3. **软删除**：`is_active=False` 而非物理删除，因为历史版本可能还引用着这个配置。

```python
# 文件：backend/app/crud/knowledge.py — 切换默认配置的原子操作
async def create_chunk_config(db: AsyncSession, ..., is_default: bool = False, ...):
    if is_default:
        await _clear_default_config(db)  # 先清除旧默认
    config = KnowledgeChunkConfig(is_default=is_default, ...)
    db.add(config)
    await db.flush()
    return config

async def _clear_default_config(db: AsyncSession) -> None:
    stmt = (
        update(KnowledgeChunkConfig)
        .where(KnowledgeChunkConfig.is_default == True)
        .values(is_default=False)
    )
    await db.execute(stmt)
```

### 8.6 枚举设计

```python
# 文件：backend/app/models/knowledge_enums.py
class KnowledgeDocStatus(StrEnum):
    ACTIVE = "active"
    DELETED = "deleted"

class ChunkSplitterType(StrEnum):
    SENTENCE = "sentence"
    MARKDOWN = "markdown"

class ChunkMetadataPolicy(StrEnum):
    BASIC = "basic"
    DEBUG = "debug"
```

**使用 `StrEnum` 而非 `Enum` 的原因：** `StrEnum` 的成员值本身就是字符串，可以直接与数据库中的 VARCHAR 比较，不需要 `.value` 转换。

```python
# StrEnum — 可以直接比较
doc.status = KnowledgeDocStatus.ACTIVE  # 等价于 doc.status = "active"

# 普通 Enum — 需要 .value
doc.status = TaskStatus.PENDING.value   # 必须用 .value
```

### 8.7 完整的表关联关系总结

```
users (1)
  ├── (1:N) tasks
  │     └── (1:N) chat_messages
  │           └── (1:N) chat_images
  ├── (1:N) chat_messages（独立于 task 的消息）
  ├── (1:N) knowledge_documents（created_by）
  └── (1:N) knowledge_document_versions（created_by）

knowledge_documents (1)
  └── (1:N) knowledge_document_versions
                └── (N:1) knowledge_chunk_config
```

---

## 九、数据库原理与高并发进阶

### 9.1 WAL（Write-Ahead Logging）与 Checkpoint

如果你连 WAL 都说不清，就别说你真的理解数据库持久化。面试官一追问“为什么数据库提交成功了，数据页还没落盘也敢返回 200？”，你答不上来，基本说明你停留在 ORM 使用层。

**WAL 的核心原则**：**先写日志，再写数据页**。

PostgreSQL 的提交流程不是“每次 commit 都把整张表刷回磁盘”，而是：

1. 事务修改的是内存中的共享缓冲区（shared buffers）
2. 同时生成对应的 WAL 记录
3. `COMMIT` 时只要 WAL 已经 flush 到磁盘，就可以认为事务持久化成功
4. 真正的数据页可以稍后由 background writer / checkpoint 再刷盘

这套机制的价值有三个：

- **顺序写**：WAL 主要是顺序追加，磁盘友好
- **崩溃恢复**：数据库重启时重放 WAL，就能把已提交但尚未刷盘的数据页恢复出来
- **吞吐更高**：不必每次提交都随机刷大量脏页

**Checkpoint 是什么？**

Checkpoint 会把一段时间内的脏页批量刷回磁盘，并在 WAL 中打一个检查点。恢复时只需要从最近的 checkpoint 开始重放，而不是从数据库创建之初开始。

**面试关键点：**
- `commit` 成功不等于数据页已经落盘，但一定意味着 **WAL 已经满足持久化要求**
- WAL 解决的是 **崩溃恢复与高吞吐**，不是“备份”
- Checkpoint 太频繁会增加 I/O 抖动；太少会导致恢复时间变长

### 9.2 MVCC、快照读与 VACUUM

PostgreSQL 并发能力强，不是因为它“锁用得少”，而是因为它用了 **MVCC（Multi-Version Concurrency Control，多版本并发控制）**。

**MVCC 的本质**：一行数据在更新时，不是直接覆盖旧值，而是生成新版本。不同事务根据自己的快照，看到不同版本。

典型效果：
- **读不阻塞写**
- **写不阻塞读**（大多数情况下）
- 普通 `SELECT` 不需要给行加共享锁

PostgreSQL 每一行 tuple 都带有事务可见性信息（如 `xmin` / `xmax`），事务开始时获得一个快照：
- 哪些事务已经提交
- 哪些事务仍在进行中
- 当前查询对哪些版本可见

所以面试里如果有人问“MVCC 怎么避免读写互斥”，你不能只答一句“因为有版本链”。你要知道 PostgreSQL 是通过 **tuple 版本 + 事务快照 + 可见性判断** 实现的。

**为什么还需要 VACUUM？**

因为旧版本不会立刻物理删除。更新/删除后会留下 dead tuples：
- 不清理 → 表膨胀（table bloat）
- 索引也会膨胀
- 顺序扫描和索引扫描都会变慢

`autovacuum` 会自动回收这些垃圾版本，并维护统计信息。长期事务会阻止老版本被回收，这是生产事故高发点。

**危险信号：**
- 长事务不结束
- VACUUM 跟不上写入速度
- 表和索引体积持续膨胀
- 查询计划开始偏离，性能突然恶化

**工程经验：**
- OLTP 系统必须关注 autovacuum，不要把它当“数据库自己会处理”的黑盒
- 长时间 `idle in transaction` 是很危险的状态
- 高频更新表要特别关注 bloat 和 vacuum 延迟

### 9.3 锁、死锁与并发控制

数据库不是没有锁，而是**不能只会说锁，不会说锁的边界**。

#### 行锁 vs 表锁

- **行锁**：锁住某一行，常见于 `UPDATE` / `DELETE` / `SELECT ... FOR UPDATE`
- **表锁**：锁住整张表，DDL 或某些强约束操作时出现，影响更大

大多数业务系统真正常见的是 **行级锁竞争**，不是表锁。

#### 乐观锁 vs 悲观锁

**悲观锁**：假设冲突很常见，先锁住再改。
```sql
SELECT * FROM tasks WHERE id = 1 FOR UPDATE;
```
适合：库存扣减、账户余额、明确需要串行化的关键资源。

**乐观锁**：假设冲突不常见，更新时检查版本号。
```sql
UPDATE tasks
SET status = 'completed', version = version + 1
WHERE id = 1 AND version = 7;
```
如果影响行数为 0，说明别人先改过了。

适合：读多写少、冲突概率低的场景。

#### 什么是死锁？

死锁不是“数据库坏了”，而是两个事务互相等待对方释放资源，形成环。

典型例子：
- 事务 A 先锁 task，再锁 user
- 事务 B 先锁 user，再锁 task
- 两边都等对方释放 → 死锁

PostgreSQL 会主动检测死锁并回滚其中一个事务，报 `deadlock detected`。

**避免死锁的硬规则：**
1. 多个事务按**相同顺序**获取资源
2. 缩短事务时间，不要把网络调用放进事务里
3. 对热点资源减少不必要的 `FOR UPDATE`
4. 批量更新时控制批次，避免一次锁太多行

### 9.4 慢查询分析与 `EXPLAIN ANALYZE`

真正的数据库能力，不是会建表，而是**查慢了你知道怎么拆**。

`EXPLAIN` 看的是优化器计划，`EXPLAIN ANALYZE` 还会真的执行，并返回实际耗时与实际行数。

你至少要会看这些：
- `Seq Scan`：全表扫描
- `Index Scan`：走普通索引
- `Bitmap Heap Scan`：适合匹配行较多的情况
- `Nested Loop` / `Hash Join` / `Merge Join`：连接策略
- `rows`（估算） vs `actual rows`（实际）
- `cost`、`actual time`、`loops`

**排查顺序建议：**
1. 先确认是不是全表扫描
2. 再看过滤条件是否命中索引最左前缀
3. 再看返回列是否过多、是否存在回表
4. 再看连接顺序和 join 策略
5. 最后看统计信息是否过期、是否需要 `ANALYZE`

**典型误区：**
- “建了索引为什么没用？”——因为返回行太多、选择性太差，优化器认为全表扫描更便宜
- “SQL 很简单为什么慢？”——因为慢的不一定是 SQL 语法，可能是数据分布、统计信息、锁等待、连接池阻塞
- “把所有字段都建索引”——这是初学者常见错误，索引不是越多越好，写入成本、维护成本、膨胀成本都要算

### 9.5 高频写入、热点行与 UPSERT

项目里如果有任务状态更新、知识库重建状态回写、聊天消息写入，这类场景一旦并发上来，就会遇到高频写入问题。

#### 热点行问题

一个 row 被大量并发更新时，会形成串行化瓶颈。

常见热点：
- 单行计数器
- 全局统计表
- 某个“当前状态”字段被所有 worker 反复更新

**优化思路：**
- 把高频瞬时状态放 Redis，最终结果落 PostgreSQL
- 由“每次都更新同一行”改成“追加事件日志，再异步聚合”
- 对写入热点按用户、任务、分片键拆散

#### UPSERT

PostgreSQL 的 UPSERT：
```sql
INSERT INTO knowledge_documents (doc_key, file_name)
VALUES ('abc', 'x.pdf')
ON CONFLICT (doc_key)
DO UPDATE SET file_name = EXCLUDED.file_name;
```

适合：
- 幂等写入
- 去重写入
- 同步外部状态

**好处**：避免“先查后插”的竞态条件。

#### 批量写入

高并发时不要迷信“单条 SQL 最安全”。批量插入、批量更新通常吞吐更高，但要控制事务大小。事务太大：
- 占用连接更久
- 持有锁更久
- WAL 膨胀更明显
- 回滚成本更高

### 9.6 连接池耗尽与数据库雪崩

应用侧最常见的问题不是 PostgreSQL 挂了，而是**连接池被打满**。

你会看到的现象：
- 请求 RT 突然拉高
- API 卡住但数据库 CPU 不高
- 日志里大量 timeout / pool exhausted

根因通常是：
- 慢 SQL 导致连接长期占用
- 事务不及时提交或回滚
- 把外部 I/O（HTTP 调用、文件操作）放进事务里
- worker 数量 × pool size 总和超过数据库承载能力

**硬规则：**
- 连接是稀缺资源，不是免费对象
- pool size 要结合实例数一起算，不能每个服务都“先配大一点”
- 请求链路越长，事务边界越要收紧

### 9.7 分区、读写分离、分库分表：什么时候该上，什么时候别上

这三件事都是经典面试题，但也是最容易被新手滥答的地方。

#### 分区表（Partitioning）

适合：
- 时间序列数据
- 超大表按时间/范围归档
- 历史数据冷热分离

不适合：
- 数据量还小
- 查询条件不带分区键
- 只是想“提前设计成大厂架构”

#### 读写分离

适合：
- 读远大于写
- 查询压力显著高于事务写入
- 能接受复制延迟

代价：
- 主从延迟导致“刚写完查不到”
- 读路由复杂度上升
- 故障切换更复杂

#### 分库分表

只有在**单库容量、单表热点、单机吞吐**成为真实瓶颈时才值得上。

代价极大：
- 全局事务复杂
- 跨分片查询复杂
- 运维和迁移难度陡增
- 开发心智负担明显提高

**默认原则**：
- 小中型项目优先用 PostgreSQL 单库做强
- 先解决索引、SQL、缓存、异步化、热点拆分
- 真到了单机边界，再谈分片

---

## 十、面试高频问题

### Q1: 什么是 ORM？你的项目中是怎么使用的？

**答：** ORM（对象关系映射）将数据库表映射为 Python 类，将行映射为对象，将列映射为属性。我的项目使用 SQLAlchemy 2.0 的 Mapped 声明式语法。比如 `User` 类映射到 `users` 表，`User.username` 对应 `username` 列。通过 `select(User).where(User.username == "admin")` 构建查询，SQLAlchemy 自动生成参数化 SQL，避免注入风险。相比手写 SQL，ORM 提供了类型安全、IDE 补全、以及自动迁移生成（通过 Alembic）。

---

### Q2: SQLAlchemy 1.x 和 2.0 的主要区别是什么？

**答：** 核心区别有三个：

1. **模型定义**：2.0 用 `DeclarativeBase` + `Mapped[T]` + `mapped_column()` 替代了 1.x 的 `declarative_base()` + `Column()`。好处是有完整的类型标注，mypy 和 IDE 能正确推断字段类型。

2. **查询 API**：2.0 用 `select(User).where(...)` 替代了 1.x 的 `session.query(User).filter(...)`。新语法统一了 Core 和 ORM 的查询接口。

3. **异步支持**：2.0 内置 `AsyncSession`、`create_async_engine`，1.x 需要第三方库。

我的项目从一开始就用 2.0，没有历史包袱。

---

### Q3: `default` 和 `server_default` 的区别是什么？什么时候用哪个？

**答：** `default` 是 Python 层面的默认值，只在通过 ORM 创建对象时生效，不会体现在数据库 DDL 中。`server_default` 是数据库 DDL 层面的默认值（DEFAULT 约束），任何途径的 INSERT（ORM、裸 SQL、psql）都会生效。

选择原则：
- 时间戳字段（`created_at`）一定用 `server_default=func.now()`，保证数据库时钟统一。
- 业务逻辑默认值（`status="pending"`）用 `default` 即可，因为只通过 ORM 创建。
- 需要 Alembic 自动检测变更的字段用 `server_default`，因为 autogenerate 不检测 `default`。

还有一个关键细节：`server_default=text("false")` 生成 SQL 表达式 `DEFAULT false`，而 `server_default="false"` 生成字符串字面量 `DEFAULT 'false'`，两者含义不同。

---

### Q4: 什么是 N+1 查询问题？你的项目是怎么解决的？

**答：** N+1 问题是指查询主表得到 N 条记录后，为加载每条记录的关联数据又发起 N 条查询，共 N+1 条 SQL。比如查 100 个用户的任务列表，如果每个用户的 tasks 是 lazy loading，就会发 101 条 SQL。

我的项目使用两种方式解决：
1. 在模型 relationship 上设置 `lazy="selectin"`，自动使用 SELECT IN 批量加载关联数据，只需要 2 条 SQL。
2. 在具体查询中使用 `.options(selectinload(Task.owner))` 显式指定加载策略。

selectinload 生成的 SQL 类似 `SELECT * FROM users WHERE id IN (1, 2, 3, ...)`，把 N 条查询合并为 1 条。

---

### Q5: 为什么选择 PostgreSQL 而不是 MySQL？

**答：** 三个核心原因：

1. **PGVector 扩展**：项目需要做 RAG 知识库检索，PGVector 让我们在同一个 PostgreSQL 里存储和检索向量，不需要额外部署 Milvus/Pinecone。MySQL 没有等价的扩展。
2. **JSONB 类型**：项目的聊天消息元数据用了 JSONB，支持 GIN 索引和高效查询。MySQL 的 JSON 类型能力弱很多。
3. **更严格的 SQL 标准**：PostgreSQL 的默认行为更安全（比如 `GROUP BY` 必须包含所有非聚合列），减少了隐性 Bug。

---

### Q6: 什么是数据库迁移？为什么不能直接改数据库？

**答：** 数据库迁移是对 Schema 变更的版本化管理。不能直接改数据库的原因：

1. **不可重复**：手动在开发环境 ALTER TABLE，同事拉代码后数据库没有同步变更。
2. **不可追溯**：无法知道"这个字段是什么时候加的、为什么加的"。
3. **不可回滚**：手动改错了很难恢复。
4. **多环境不一致**：开发、测试、生产三个环境的 Schema 容易不同步。

Alembic 通过迁移文件（包含 upgrade 和 downgrade 函数）解决了这些问题。每个迁移文件有唯一 ID 和依赖关系，形成一条链，保证所有环境执行同样的变更序列。

---

### Q7: `alembic revision --autogenerate` 的原理是什么？有什么局限性？

**答：** Autogenerate 的原理是对比两个来源的 Schema：
1. Python 模型的 MetaData（`Base.metadata`，通过 import 所有模型获得）。
2. 数据库当前的实际 Schema（通过 INFORMATION_SCHEMA 查询）。

两者差异自动生成迁移代码。

局限性：
- 无法检测表/列重命名（会被识别为删除 + 创建）。
- 无法检测 `default`（Python 层面默认值）的变更。
- 无法生成数据迁移逻辑。
- 如果忘了在 env.py 中 import 某个模型，autogenerate 会认为该表不应存在，可能生成删表操作。

所以 autogenerate 生成的迁移文件**一定要人工审查**。

---

### Q8: 解释一下你的项目中的数据库连接管理方案。

**答：** 分四层：

1. **驱动层**：asyncpg，纯异步 PostgreSQL 驱动。
2. **引擎层**：`create_async_engine`，管理连接池，默认 5 个常驻连接 + 10 个临时连接。
3. **Session 工厂层**：`async_sessionmaker`，创建 `AsyncSession`，设置 `expire_on_commit=False` 防止异步上下文中的隐式查询。
4. **依赖注入层**：`get_db()` 异步生成器，通过 FastAPI 的 `Depends` 注入到路由函数，自动管理 Session 的创建、异常回滚和关闭。

生命周期：请求到来 → 从池中取连接创建 Session → yield 给路由 → 路由处理完 → 异常则 rollback → 无论如何 close → 连接归还池中。

---

### Q9: `expire_on_commit=False` 是什么意思？为什么要设置？

**答：** 默认情况下（`expire_on_commit=True`），`commit()` 之后 Session 中所有对象的属性会被标记为"过期"。下次访问属性时 SQLAlchemy 会自动发起 SELECT 查询来刷新。

在异步环境中这有问题：自动发起的查询是隐式的，没有被 `await`，会导致 `MissingGreenlet` 错误。

设置 `expire_on_commit=False` 后，commit 后对象保持原值不过期。如果需要最新数据，手动 `await db.refresh(obj)` 即可。

---

### Q10: `flush()` 和 `commit()` 的区别是什么？

**答：**
- `flush()`：将 ORM 内存中的变更（INSERT/UPDATE/DELETE）发送到数据库执行，但不提交事务。数据已经写入数据库的事务缓冲区，可以通过 `rollback()` 回滚。
- `commit()`：等于 `flush()` + 提交事务。不可逆。

我的项目中的用法：CRUD 函数内部用 `flush()` 获取自增 ID（比如创建消息后需要 `msg.id` 来关联图片），但不 `commit()`，让调用方决定是 commit 还是 rollback。这样多个 CRUD 操作可以组合在同一个事务中。

```python
# 文件：backend/app/crud/chat.py
msg = ChatMessage(...)
db.add(msg)
await db.flush()  # 获取 msg.id，但事务未提交
for file_path, original_name in image_paths:
    img = ChatImage(message_id=msg.id, ...)  # 用刚拿到的 msg.id
    db.add(img)
await db.commit()  # 消息和图片一起提交
```

---

### Q11: 什么是连接池？为什么需要？参数怎么调？

**答：** 连接池预先创建一组数据库连接并复用。每个请求不需要新建连接（~50ms），而是从池中取（~0ms），用完归还。

核心参数：
- `pool_size`：常驻连接数，设为平均并发数（通常 5-20）。
- `max_overflow`：突发流量时临时扩展的连接数，通常是 pool_size 的 1-2 倍。
- `pool_recycle`：连接最长存活秒数，防止用到已被数据库端关闭的连接，建议 3600。
- `pool_pre_ping`：每次取连接前 ping 一下，防止用到死连接。

关键约束：所有应用实例的 `pool_size + max_overflow` 之和不能超过 PostgreSQL 的 `max_connections`（默认 100）。

---

### Q12: 你的项目中 `ondelete="CASCADE"` 和 ORM `cascade="all, delete-orphan"` 有什么区别？

**答：** 两个完全不同的层面：

- `ondelete="CASCADE"`：数据库外键约束，任何途径删除父行时，数据库引擎自动删除子行。
- `cascade="all, delete-orphan"`：ORM 层面的级联，只有通过 SQLAlchemy Session 删除对象时才生效。

最佳实践是**两者都设置**。`ondelete` 保证数据库层面的完整性（即使有人直接用 SQL 删除），ORM cascade 保证 Python 对象状态的一致性。

`delete-orphan` 额外做的事情：当子对象从父对象的集合中移除时（`user.tasks.remove(task)`），自动删除这个子对象。

---

### Q13: 什么是软删除？为什么不直接 DELETE？

**答：** 软删除是标记记录为"已删除"（改 status 字段），而非从数据库中物理删除。

我的项目中知识库文档用了软删除：

```python
async def mark_document_deleted(db, document_id):
    doc.status = KnowledgeDocStatus.DELETED
    doc.deleted_at = datetime.now(UTC)
```

为什么不直接 DELETE：
1. **可恢复**：误删时可以直接恢复，不需要从备份中找。
2. **审计追踪**：保留删除时间和删除者信息。
3. **数据完整性**：其他表可能还在引用这条记录。
4. **合规要求**：某些行业法规要求数据保留。

代价：所有查询都要加 `WHERE status != 'deleted'` 条件，容易遗漏。可以用 PostgreSQL 的行安全策略（Row-Level Security）或视图来解决。

---

### Q14: 你的项目中如何防止重复上传相同文件？

**答：** 通过两层机制：

1. **业务层**：上传文件后计算 SHA256 哈希值，调用 `check_duplicate_hash()` 查询同一文档下是否已存在相同哈希。
2. **数据库层**：`knowledge_document_versions` 表有唯一复合索引 `(document_id, content_hash)`，即使业务层漏检，数据库也会拒绝插入重复记录。

```python
__table_args__ = (
    Index("uq_doc_hash", "document_id", "content_hash", unique=True),
)
```

这是**防御性编程**：业务层检查 + 数据库约束双重保险。

---

### Q15: JSONB 和 JSON 类型有什么区别？什么时候用哪个？

**答：**
- `JSON`：文本存储，保留原始格式。写入快，但每次查询都要解析 JSON 文本。
- `JSONB`：二进制存储，写入时解析一次，后续查询直接操作二进制数据。支持 GIN 索引、支持 `@>`（包含）、`?`（键存在）等操作符。

原则：**99% 的情况用 JSONB。** 只有当你需要保留 JSON 的原始格式（键顺序、重复键、空白符）时才用 JSON。

我的项目中 `ChatMessage.meta` 用 JSONB，存储 RAG 知识来源等元数据，可以高效查询。

---

### Q16: 什么是 MVCC？PostgreSQL 如何实现？

**答：** MVCC（Multi-Version Concurrency Control，多版本并发控制）是让读写操作不互相阻塞的机制。

PostgreSQL 的实现方式：
- 每行数据有隐藏的 `xmin`（创建该行的事务 ID）和 `xmax`（删除/更新该行的事务 ID）。
- 更新一行时，旧行标记 `xmax`，创建一行新行标记新 `xmin`。
- 每个事务根据自己的快照（哪些事务已提交）决定能看到哪个版本。
- 旧版本由 VACUUM 进程定期清理。

好处：读操作不需要加锁，读和写互不阻塞。
代价：更新密集的表会产生大量"死行"，需要 VACUUM 清理，否则表膨胀。

---

### Q17: 为什么外键字段要建索引？

**答：** 两个原因：

1. **JOIN 性能**：`SELECT * FROM tasks JOIN users ON tasks.user_id = users.id`，没有索引则全表扫描。
2. **CASCADE 删除性能**：`DELETE FROM users WHERE id = 1` 触发 CASCADE 时，数据库需要找到 tasks 表中 `user_id = 1` 的所有行。没有索引 = 全表扫描 = 如果 tasks 表有百万行就是灾难。

PostgreSQL 的外键不会自动创建索引（MySQL InnoDB 会），所以必须手动加。

```python
# 正确做法
user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
```

---

### Q18: `scalars().first()` 和 `scalar_one_or_none()` 有什么区别？

**答：**
- `scalars().first()`：返回结果集的第一行，如果有多行则忽略其余行，如果没有行则返回 `None`。
- `scalar_one_or_none()`：如果恰好有 1 行则返回，如果没有行则返回 `None`，如果有多行则**抛出异常**。

选择原则：如果查询结果应该是唯一的（比如按唯一索引查询），用 `scalar_one_or_none()` 更安全，因为多行结果说明数据有问题，应该立即发现。如果查询结果可能有多行但你只关心第一条，用 `scalars().first()`。

```python
# 文件：backend/app/crud/user.py — 按用户名查（可能有多行匹配用 first）
result.scalars().first()

# 文件：backend/app/crud/knowledge.py — 结果应该唯一
result.scalar_one_or_none()
```

---

### Q19: 解释一下 `select_from(base_stmt.subquery())` 的用法。

**答：** 这是一种让 count 查询复用 list 查询条件的技巧。

```python
# 文件：backend/app/crud/task.py
base_stmt = select(Task)
if not is_superuser:
    base_stmt = base_stmt.where(Task.user_id == user_id)

# count 查询复用 base_stmt
total_stmt = select(func.count()).select_from(base_stmt.subquery())
```

`base_stmt.subquery()` 把查询包装成一个子查询（临时表），`select(func.count()).select_from(...)` 对这个子查询数行数。

好处：list 和 count 的过滤条件保持一致。如果以后加了新的过滤条件，只改 `base_stmt`，count 自动同步。否则要维护两份条件，容易不一致。

---

### Q20: 当前仓库的 Alembic 迁移里为什么会在 init 中执行 `CREATE EXTENSION IF NOT EXISTS vector`？

**答：** 因为当前仓库的 init 迁移需要先确保 PGVector 扩展存在，后续向量列和向量检索能力才能正常工作。

当前仓库里只有一份迁移：`efc4bf731595_init.py`。  
这里使用 `IF NOT EXISTS` 的原因是让迁移具备幂等性：如果扩展已存在就跳过，不会报错。

`IF NOT EXISTS` 保证了幂等性——如果扩展已存在就跳过，不会报错。这是编写迁移文件的最佳实践：所有 DDL 操作尽量幂等。

另外，downgrade 中没有 `DROP EXTENSION`，这是故意的：删除扩展会导致所有使用 VECTOR 类型的列和索引丢失，风险太大。

---

### 面试总结核心要点

1. **必须知道** `default` vs `server_default` 的区别，以及 `text("false")` vs `"false"` 的区别。
2. **必须能解释** N+1 问题以及 selectinload/joinedload 的解决方案。
3. **必须理解** `flush()` vs `commit()` 的区别，以及为什么 CRUD 函数中用 flush。
4. **必须知道** 异步数据库的必要性、`expire_on_commit=False` 的原因。
5. **必须能画出** FastAPI → Depends(get_db) → AsyncSession → Engine → asyncpg → PostgreSQL 的完整链路。
6. **必须理解** ORM cascade 和数据库 ondelete 是两个层面的东西。
7. **必须能解释** 连接池参数的含义和调优原则。
8. **必须理解** Alembic autogenerate 的原理和局限性。
