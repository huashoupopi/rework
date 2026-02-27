# Day 3：数据模型与关系 + 检测任务上传

> 目标：完成 Task 模型 + 文件上传服务 + 检测任务上传接口 + 后台推理占位
> 预计文件数：6 个新建 + 3 个修改
> pytest / mypy 暂不引入，后续有时间再补

---

## 工具策略

| 工具 | 状态 | 说明 |
|---|---|---|
| ruff | ✅ 已有 | 继续用 |
| logging | ✅ Day 2 完成 | 新文件统一用 logger |
| pytest | ❌ 暂缓 | 时间紧张，优先核心链路 |
| mypy | ❌ 暂缓 | 同上 |

> 策略：时间有限，先把 Task 上传 → YOLO → Chat → RAG 主链路跑通。
> 测试和类型检查是锦上添花，核心链路能跑、面试能讲清楚才是命脉。

---

## Day 2 遗留修复（写 Day 3 之前先改掉，5 分钟）

| 问题 | 文件 | 改动 |
|---|---|---|
| `BASE_URL` 应改为 `BASE_DIR` | `config.py` | 变量重命名 |
| `tokenUrl` 路径不对 | `routers/auth.py` | `/auth/login` → `/api/auth/login` |
| `get_current_user` 返回类型 | `routers/auth.py` | `User \| None` → `User`（永远不会返回 None） |
| `.env` 行内注释 | `.env` | 注释移到单独行（建议） |

---

## Step 1：`app/models/task.py` — Task 表模型

**要求**：
- 继承 `Base`
- 用 SQLAlchemy 2.0 `Mapped` + `mapped_column` 风格

**字段清单**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | int | 主键, index | 自增 |
| uuid | str(36) | unique, index | 文件命名用，避免冲突 |
| file_name | str(255) | NOT NULL | 原始文件名 |
| status | str(20) | NOT NULL, default="pending" | pending/processing/completed/failed |
| original_path | str(500) \| None | nullable | 原图存储路径 |
| result_path | str(500) \| None | nullable | 结果图存储路径 |
| detect_result | JSON \| None | nullable | YOLO 推理结果（JSON 存储） |
| created_at | datetime | server_default=func.now() | 创建时间 |
| user_id | int | ForeignKey("users.id") | 所属用户外键 |

**relationship**：
```python
# Task 侧
owner: Mapped["User"] = relationship(back_populates="tasks", lazy="selectin")

# User 侧（Step 2 去补）
tasks: Mapped[list["Task"]] = relationship(
    back_populates="owner", lazy="selectin", cascade="all, delete-orphan"
)
```

**循环导入保护**：
```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from app.models.user import User
```

**你需要回答自己的问题**：

1. **`uuid` 字段为什么用 `str(36)` 而不是数据库原生 UUID 类型？**
   - UUID 标准格式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 刚好 36 个字符
   - 字符串类型跨数据库兼容性更好，且方便直接拼接文件路径（`f"uploads/{uuid}/"`）
   - PostgreSQL 有原生 UUID 类型（16 字节存储，更紧凑），但你的项目规模用 str 够了
   - **面试加分点**：如果被问到"大规模怎么优化"，可以说切换到原生 UUID 类型减少存储和索引开销

2. **`status` 为什么用字符串而不是 Python 枚举？**
   - 字符串更简单，迁移时不会出问题
   - PostgreSQL 的 ENUM 类型改动非常麻烦（不支持直接删除枚举值，要先删列再重建）
   - 小项目字符串够用；大项目如果状态很多，可以用枚举增加类型安全
   - **面试话术**："选择字符串是因为状态只有 4 种，且 PostgreSQL 的枚举迁移成本高。如果状态变多会考虑枚举。"

3. **`ForeignKey("users.id")` 为什么写表名而不是类名 `User`？**
   - `ForeignKey` 里写的是**数据库表名.列名**（即 `__tablename__` + 列名）
   - 和 Python 类名无关——类名 `User`，表名 `users`，这是两回事
   - 搞混这个是新手最常见的错误之一

4. **`cascade="all, delete-orphan"` 是什么意思？**
   - `all` = save-update + merge + refresh-expire + expunge + delete
   - 其中 `delete` 表示：删除 User 时，SQLAlchemy **自动**删除关联的所有 Task
   - `delete-orphan` 表示：Task 被从 `user.tasks` 列表中移除时也自动删除（不允许"无主"的 Task 存在）
   - **面试必问**：删用户是高风险操作！会级联删除所有任务记录 + 磁盘文件。生产环境通常用软删除（`is_deleted` 标记）替代物理删除
   - **追问**：ORM 层的 cascade 和数据库层的 `ON DELETE CASCADE` 有什么区别？（ORM 层是 Python 侧处理，数据库层是 SQL 侧处理；两层都配是双重保护）

5. **`lazy="selectin"` 是什么？和 `joined`、默认 `select` 有什么区别？**
   - `selectin`：用额外 `SELECT ... WHERE id IN (...)` 查询加载关系，适合**一对多**（一个 User 有多个 Task）
   - `joined`：用 SQL JOIN 一次查出来，适合**多对一 / 一对一**（一个 Task 对应一个 User）
   - 默认 `select`（懒加载）：访问 `task.owner` 时才发查询
   - **关键**：异步 SQLAlchemy **不支持隐式懒加载**！访问未加载的 relationship 会报 `MissingGreenlet` 错误。所以必须显式指定 `lazy="selectin"` 或在查询时用 `options(selectinload(...))`
   - **面试点**：这就是 N+1 问题——查 100 个 task 然后逐个访问 owner，没有 selectin 就会发 101 条 SQL

6. **`detect_result` 为什么用 JSON 类型而不是单独建表？**
   - 推理结果结构不固定（不同图片检测到的缺陷数量不同，每个缺陷有 class、confidence、bbox）
   - 不需要对 JSON 内部字段做 SQL 查询（比如"查所有 confidence > 0.9 的缺陷"——如果需要就该用 JSONB + GIN 索引）
   - JSON 列比新建一张 `detection_results` 表简单得多，对你的项目规模来说完全够用
   - **面试加分**：JSON vs JSONB 的区别？（JSON 存原文、每次查询重新解析；JSONB 存二进制、支持索引和 `@>` 等操作符查询）

---

## Step 2：更新 `app/models/user.py` — 补上 relationship

在 User 模型中添加与 Task 的关系：

```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from app.models.task import Task

# 在 User 类中添加字段
tasks: Mapped[list["Task"]] = relationship(
    back_populates="owner", lazy="selectin", cascade="all, delete-orphan"
)
```

**你需要回答自己的问题**：

1. **为什么两边都要写 `relationship`？只写一边行不行？**
   - SQLAlchemy 的双向关系需要两端都定义 `relationship` + `back_populates` 互相指向
   - 只写一端也行（用 `backref="tasks"`），但 `back_populates` 是 2.0 推荐写法，更显式清晰
   - `backref` 隐式在对方类上创建属性，代码审查时不容易发现——不利于维护

2. **`TYPE_CHECKING` 块为什么存在？不用会怎样？**
   - 不用的话：`user.py` import `Task`，`task.py` import `User` → **循环导入**，Python 直接报错
   - `TYPE_CHECKING` 块只在类型检查工具（mypy/pyright）运行时执行，运行时跳过
   - relationship 里的类型写成字符串 `"Task"`，SQLAlchemy 在运行时通过内部 registry 延迟解析
   - **追问**：还有什么方式解决循环导入？（`from __future__ import annotations` 也可以，让所有注解变成字符串延迟求值）

---

## Step 3：`app/schemas/task.py` — Task 的输入输出 Schema

**要求**：

```python
# TaskSchema（输出）：
#   id, uuid, file_name, status, original_path, result_path,
#   detect_result(dict | None), created_at, owner(UserPublic | None)
#   model_config = ConfigDict(from_attributes=True)

# TaskPaginationSchema（分页输出）：
#   total: int
#   items: list[TaskSchema]
```

**你需要回答自己的问题**：

1. **为什么 Task 没有 `TaskCreate` schema？**
   - Task 不是通过 JSON body 创建的，而是通过文件上传（`UploadFile`）
   - 上传时的参数是文件本身 + 从 token 解析的 `current_user`，不需要额外的 schema
   - 不是所有 model 都需要 Create schema——根据实际业务来

2. **`owner: UserPublic | None` 为什么嵌套了 UserPublic？**
   - Task 列表接口需要展示每个任务的创建者信息（用户名等）
   - 直接嵌套 `UserPublic` 避免前端再发 N 次请求查用户——一次查出来转成嵌套 JSON
   - 这就是 `selectinload` 的意义——ORM 层把关系数据预加载，Schema 层直接序列化

3. **分页为什么单独做一个 `TaskPaginationSchema`？**
   - 前端分页器需要 `total` 来显示"共 X 条"
   - 不能只返回 `list[TaskSchema]`，因为当前页的 `len(items)` ≠ 数据库总数
   - 这是后端分页的标准模式：`{ total: 100, items: [...当前页数据...] }`

---

## Step 4：`app/services/file_service.py` — 文件保存/删除服务

**要求**：

```python
import uuid
from pathlib import Path
import shutil

UPLOAD_DIR = Path("static/uploads")
RESULT_DIR = Path("static/results")

class FileService:
    @staticmethod
    async def save_upload_file(file: UploadFile) -> tuple[str, str, str]:
        """保存上传文件，返回 (task_uuid, filename, save_path)"""
        # 1. 生成 uuid: task_uuid = str(uuid.uuid4())
        # 2. 创建目录: UPLOAD_DIR / task_uuid
        # 3. 读取文件内容: content = await file.read()
        # 4. 写入磁盘: save_path.write_bytes(content)
        # 5. return (task_uuid, file.filename, str(save_path))

    @staticmethod
    def get_result_path(task_uuid: str, original_filename: str) -> str:
        """构造结果图路径: results/{uuid}/{filename}"""

    @staticmethod
    async def delete_files(uuid_str: str, filename: str) -> None:
        """删除原图和结果图目录"""
        # shutil.rmtree(UPLOAD_DIR / uuid_str, ignore_errors=True)
        # shutil.rmtree(RESULT_DIR / uuid_str, ignore_errors=True)
```

**你需要回答自己的问题**：

1. **为什么用 UUID 做文件夹名而不是用户名或任务 ID？**
   - 用户名可能有特殊字符（空格、中文、`../`），做路径不安全（目录遍历风险）
   - 任务 ID 在写入文件时还不存在（auto increment 在 `db.commit()` 后才生成）
   - UUID 全局唯一、无冲突、长度固定 36 字符、不含特殊字符
   - **安全点**：如果直接用用户传的 `filename` 做路径，用户可以上传 `../../etc/passwd` 来目录遍历

2. **`save_upload_file` 为什么是 `async`？**
   - `UploadFile.read()` 是 FastAPI 封装的 async 方法（内部用 `anyio`）
   - 但 `Path.write_bytes()` 是同步阻塞调用——大文件时会阻塞事件循环
   - 当前阶段图片几 MB 问题不大；如果处理视频等大文件，应该用 `aiofiles` 或 `await asyncio.to_thread(path.write_bytes, content)`
   - **面试话术**："异步 IO 的粒度取决于瓶颈。图片几 MB 同步写入耗时微秒级，不值得引入 aiofiles 的额外复杂度。"

3. **为什么要 `shutil.rmtree` 而不是只删文件？**
   - 每个任务的文件放在独立的 `{uuid}/` 子目录下
   - `rmtree` 递归删除整个目录——比逐个删文件干净，不会留下空目录
   - `ignore_errors=True` 防止目录不存在时报错（幂等性）

4. **路径安全：`file.filename` 可信吗？**
   - **不可信！** 客户端可以伪造文件名（`../../admin/key.pem`）
   - 但你用 UUID 做目录名，文件名只在 UUID 子目录内使用，已经隔离了目录遍历风险
   - 额外防护：可以用 `Path(filename).name` 去掉路径前缀，只保留文件名部分

---

## Step 5：`app/crud/task.py` — Task CRUD

**要求**：

```python
async def get_task_by_id(db: AsyncSession, task_id: int) -> Task | None:
    # return await db.get(Task, task_id)

async def get_tasks_paginated(
    db: AsyncSession,
    user_id: int,
    is_superuser: bool,
    skip: int = 0,
    limit: int = 10,
) -> tuple[list[Task], int]:
    # 1. base_query = select(Task)
    # 2. 非管理员: base_query = base_query.where(Task.user_id == user_id)
    # 3. total: select(func.count()).select_from(base_query.subquery())
    # 4. items: base_query.order_by(Task.created_at.desc()).offset(skip).limit(limit)
    # 5. return (items_list, total_count)
```

**你需要回答自己的问题**：

1. **分页查询为什么不用 `len(result.all())`？**
   - `result.all()` 会把**所有**数据加载到 Python 内存
   - 10 万条任务 × 每条 1KB = 100MB 内存占用，数据量再大直接 OOM
   - `func.count()` 子查询让数据库计算总数，只返回一个整数
   - **面试必答**：这是最基本的分页优化，被问到答不上来直接扣分

2. **为什么 `order_by(Task.created_at.desc())`？**
   - 最新任务排前面，符合用户直觉（"我刚上传的在哪"）
   - 不指定排序时，SQL 标准**不保证**返回顺序（虽然 PostgreSQL 通常按物理顺序返回，但不能依赖）
   - **追问**：如果分页量很大（百万级），`OFFSET` 有什么性能问题？（OFFSET 大时数据库要扫描并丢弃前 N 行，改用 Cursor 分页 `WHERE id < last_id` 更高效）

3. **管理员和普通用户的查询区别在哪？**
   - 普通用户：`WHERE user_id = ?`，只看自己的
   - 管理员：不加 WHERE，看所有人的
   - 这是**接口级权限控制**——同一个查询函数，通过参数决定数据范围
   - **面试话术**："数据权限在 CRUD 层实现，路由层只负责传入当前用户信息。"

4. **`db.get(Task, task_id)` 和 `select(Task).where(Task.id == task_id)` 的区别？**
   - `db.get` 先查 Session 的 **Identity Map**（内存缓存），命中就不发 SQL
   - `select().where()` 总是发 SQL 到数据库
   - 按主键查单条用 `db.get` 更高效——Session 内同一对象只有一个 Python 实例
   - **追问**：Identity Map 是什么？（SQLAlchemy Session 内部维护的 `{(表, 主键): 对象}` 映射，确保同一事务内对象唯一性）

---

## Step 6：`app/routers/tasks.py` — 检测任务路由

**要求**：

```python
# POST /tasks/upload — 批量上传文件 + 建任务 + 启动后台推理
# GET  /tasks — 分页列表（管理员看所有，普通用户看自己的）
# GET  /tasks/{task_id} — 任务详情
# DELETE /tasks/{task_id} — 删除任务（含清理磁盘文件）
```

**上传接口核心逻辑**：

```python
@router.post("/tasks/upload", response_model=list[TaskSchema])
async def upload_tasks(
    files: list[UploadFile],
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[Task]:
    created_tasks = []
    for file in files:
        # 1. FileService.save_upload_file(file)
        # 2. 构造 result_path
        # 3. 创建 Task(status="processing", user_id=current_user.id, ...)
        # 4. db.add + db.commit + db.refresh
        # 5. background_tasks.add_task(background_detect_task, task.id, ...)
        # 6. created_tasks.append(task)
    return created_tasks
```

**后台推理函数（Day 3 先写占位，Day 4+ 接 YOLO）**：

```python
async def background_detect_task(task_id: int, file_path: str, result_path: str) -> None:
    """后台检测任务 — 必须使用独立 Session"""
    async with AsyncSessionLocal() as db:
        try:
            task = await db.get(Task, task_id)
            if not task:
                return
            # TODO: Day 4+ 接入 YOLO 推理
            task.status = "completed"
            task.detect_result = {"total": 0, "objects": []}  # 占位
            await db.commit()
        except Exception:
            logger.exception("后台检测任务失败 task_id=%s", task_id)
            async with AsyncSessionLocal() as err_db:
                task = await err_db.get(Task, task_id)
                if task:
                    task.status = "failed"
                    await err_db.commit()
```

**你需要回答自己的问题**：

1. **`background_detect_task` 为什么用 `AsyncSessionLocal()` 而不是路由里的 `db` 参数？（面试超高频）**
   - HTTP 请求的 Session 生命周期 = 请求开始到响应返回
   - `BackgroundTasks` 在响应返回**之后**才开始执行
   - 此时请求 Session 已经关闭 → 使用它会报 `SessionClosedError`
   - 所以必须 `async with AsyncSessionLocal() as db` 创建独立 Session
   - **画个时间线**：
     ```
     请求到达 → get_db() 创建 Session → 路由逻辑 → 返回响应 → Session 关闭
                                                                    ↓
                                              BackgroundTasks 开始执行（Session 已死）
     ```
   - **面试回答模板**："请求 Session 的生命周期和后台任务的执行时机不重叠，所以必须独立创建。"

2. **为什么错误处理要用另一个独立 Session？**
   - 异常发生时，当前 Session 可能处于"脏"状态（事务半提交、连接异常）
   - 用新 Session 确保 `status = "failed"` 的写入一定成功
   - 这是**防御性编程**：主逻辑崩了，至少状态能正确更新，用户不会看到永远 "processing" 的任务
   - **追问**：如果 err_db 也失败了怎么办？（记录日志 + 人工排查。或者后续引入定时任务扫描长时间 processing 的僵尸任务）

3. **`BackgroundTasks` vs Celery vs Arq 的区别？什么时候该用哪个？**
   - `BackgroundTasks`：同进程、无持久队列、进程重启任务丢失、无重试机制
   - `Celery`：独立 Worker 进程、Redis/RabbitMQ 消息队列、任务持久化、可重试、支持定时任务
   - `Arq`：类似 Celery 但原生 async、基于 Redis、比 Celery 轻量
   - 你的项目用 BackgroundTasks 的原因：单机部署、任务量不大、失败可以重新上传
   - **面试话术**："当前阶段 BackgroundTasks 够用。如果扩展到多实例部署，会切换到 Arq（和 FastAPI 同为 async 生态）或 Celery。选型取决于任务量和可靠性要求。"

4. **上传接口为什么不等推理完成就返回？**
   - YOLO 推理一张图 2-30 秒，批量上传 10 张可能要几分钟
   - 同步等待 → HTTP 连接 hang 住 → 前端超时 → 用户体验极差
   - 正确做法：立即返回 `status="processing"`，前端**轮询** `GET /tasks/{id}` 查状态
   - **追问**：轮询 vs WebSocket 怎么选？（轮询简单可靠、实现成本低；WebSocket 实时但复杂，需要处理断线重连。你的场景轮询间隔 1-2 秒完全够用）

5. **删除任务时为什么要同时删磁盘文件？顺序有讲究吗？**
   - 数据库只存了文件路径（`original_path`、`result_path`），不存文件本身
   - 只删数据库记录 → 磁盘文件变成"孤儿文件"，持续占用空间
   - **顺序**：先删文件，再删数据库记录
   - 为什么这个顺序？如果反过来（先删库后删文件），数据库删成功但文件删失败 → 你已经丢失了文件路径，永远找不到孤儿文件了
   - 先删文件失败 → 数据库记录还在 → 可以重试

---

## Step 7：挂载路由 + Alembic 迁移

### 改 `app/main.py`

```python
from app.routers import auth, user, tasks  # 新增 tasks

app.include_router(tasks.router, prefix="/api")
```

### 改 `alembic/env.py`

在顶部 import 区域加：
```python
from app.models.task import Task  # noqa: F401
```

### 执行迁移

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 生成迁移文件
uv run alembic revision --autogenerate -m "add_tasks_table"

# ！！！检查生成的文件，确认 upgrade 里有：
# - create_table('tasks', ...)
# - 外键 user_id -> users.id
# - unique index on uuid
# 不要盲目执行，先看一遍迁移内容

# 执行迁移
uv run alembic upgrade head
```

**你需要回答自己的问题**：

1. **为什么每次加新 model 都要在 `env.py` 里 import？**
   - Alembic `autogenerate` 的工作原理：对比 `Base.metadata`（代码定义）和数据库实际结构
   - model 文件没被 import → Python 不执行 class 定义 → `Base.metadata` 里没有这张表
   - 结果：autogenerate 检测不到任何变化，生成空迁移
   - **经验**：后面每加一个 model 都要在 env.py 里加一行 import，忘了就是白写

2. **外键的 `ondelete` 策略有哪些？该用哪个？**
   - `CASCADE`：删父行时自动删子行（数据库层面）
   - `SET NULL`：删父行时子行外键设为 NULL（需要外键列 nullable）
   - `RESTRICT` / `NO ACTION`：有子行时不允许删父行（默认行为）
   - 你的项目：ORM 层已经用了 `cascade="all, delete-orphan"`，数据库层建议也加 `ondelete="CASCADE"` 做双重保护
   - **追问**：ORM cascade 和 DB ON DELETE CASCADE 有什么区别？（ORM 是 Python 侧逐行 DELETE，会触发 ORM 事件和钩子；DB 是 SQL 侧批量删除，不触发 ORM 事件但性能更好）

3. **迁移文件生成后为什么要先检查再执行？**
   - `autogenerate` 不是完美的——可能漏检（如数据库函数索引）、误检（如检测到第三方表）
   - 看一眼 `upgrade()` 确认只有你期望的变更，再 `alembic upgrade head`
   - **生产环境**：迁移文件必须 code review 后才能执行

---

## Step 8：手动验证

```bash
# 启动
cd /Users/liuchenxu/Documents/Documents/code/rework/backend
uv run uvicorn app.main:app --reload --port 8000

# 1. 登录拿 token（如果之前创建了 admin 用户）
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -d "username=admin&password=admin" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo $TOKEN

# 2. 上传文件（用任意一张图片，或者用 echo 造一个假文件）
echo "fake image content" > /tmp/test.jpg
curl -X POST http://localhost:8000/api/tasks/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@/tmp/test.jpg"

# 3. 查看任务列表
curl -s "http://localhost:8000/api/tasks?skip=0&limit=10" \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 4. 查看单个任务详情（替换 task_id）
curl -s http://localhost:8000/api/tasks/1 \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool

# 5. 删除任务
curl -X DELETE http://localhost:8000/api/tasks/1 \
  -H "Authorization: Bearer $TOKEN" -w "\nHTTP %{http_code}\n"
```

---

## Day 3 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化无差异
uv run ruff format --check app/

# 3. curl 五个步骤全部符合预期
#    - 登录成功拿到 token
#    - 上传返回 task 列表（status = "processing" 或 "completed"）
#    - 列表返回分页数据
#    - 详情返回单个 task
#    - 删除返回 204

# 4. 代码里没有 print（全部用 logger）
grep -rn "print(" app/ --include="*.py"
```

---

## 文件写作顺序

```
0. 修复 Day 2 遗留问题             ← 5 分钟
1. app/models/task.py              ← 新建
2. app/models/user.py              ← 改（补 relationship）
3. app/schemas/task.py             ← 新建
4. app/services/file_service.py    ← 新建
5. app/crud/task.py                ← 新建
6. app/routers/tasks.py            ← 新建
7. app/main.py                     ← 改（挂 tasks 路由）
8. alembic/env.py                  ← 改（import Task）
9. alembic 迁移 + upgrade          ← 命令行
10. curl 验证                      ← 命令行
```

---

## 面试话术（90 秒）

> 检测任务模块用 FastAPI BackgroundTasks 实现异步推理。
> 上传接口接收文件后立即返回 "processing" 状态，后台任务用**独立 Session** 执行 YOLO 推理并更新状态。
> 为什么用独立 Session？因为请求 Session 在 HTTP 响应返回后就关闭了，而 BackgroundTasks 在响应之后才执行。
> Task 和 User 是多对一关系，用 `cascade="all, delete-orphan"` 实现级联删除。
> 分页查询用 `func.count()` 子查询获取总数，避免全量数据加载到内存。
> 关系加载用 `selectinload` 解决 N+1 问题——没有它，每个 task 访问 owner 都会触发一次额外 SQL。
> 文件存储用 UUID 做目录名，避免文件名冲突和路径遍历安全问题。
