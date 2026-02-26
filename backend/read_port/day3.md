# Day 3：数据模型与关系 + 检测任务上传 + 工具链补齐（pytest + mypy）

> 目标：完成 Task 模型 + 文件上传服务 + 检测任务上传接口 + 后台推理占位 + 引入 pytest 和 mypy
> 预计文件数：8 个新建 + 3 个修改

---

## 工具策略

| 工具 | 状态 | 说明 |
|---|---|---|
| ruff | ✅ 已有 | 继续用 |
| logging | ✅ Day 2 完成 | 新文件统一用 logger |
| pytest | ✅ 本日引入 | 配 conftest + 写认证测试 |
| mypy | ✅ 本日引入 | 加配置，跑一遍看报错 |

---

## Part A：工具链补齐

### Step A1：引入 mypy

在 `pyproject.toml` 末尾添加 mypy 配置：

```toml
[tool.mypy]
python_version = "3.12"
strict = false
warn_return_any = true
warn_unused_configs = true

[[tool.mypy.overrides]]
module = "app.*"
disallow_untyped_defs = true

[[tool.mypy.overrides]]
module = ["uvicorn.*", "pwdlib.*"]
ignore_missing_imports = true
```

安装：
```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend
uv add --group dev mypy
```

跑一遍看看当前代码有多少问题：
```bash
uv run mypy app/
```

**目标**：不要求零 error，但要理解每个报错是什么意思。常见的报错类型：
- `Missing return statement` — 函数声明有返回类型但某些分支没 return
- `Incompatible return value type` — 返回值类型和声明不一致
- `has no attribute` — 类型推断不出某个属性

**去问 ChatGPT 的问题**：
- mypy 的 `strict` 模式包含哪些子选项？为什么不建议一开始就开？（太多报错会劝退，应该逐步收紧）
- `disallow_untyped_defs = true` 检查什么？如果一个函数参数没有类型注解会怎样？
- mypy 遇到第三方库没有 type stub 怎么办？`ignore_missing_imports` 和安装 `types-xxx` 包的区别？
- `warn_return_any` 为什么有用？什么场景下函数会"偷偷"返回 Any？
- mypy 和 pyright 有什么区别？工业界哪个更主流？（都主流，mypy 历史长，pyright 速度快）

---

### Step A2：引入 pytest

在 `pyproject.toml` 中添加：

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

创建测试目录结构：
```bash
touch tests/__init__.py tests/conftest.py tests/test_auth.py
```

**写 `tests/conftest.py`**：

这个文件是 pytest 的公共 fixture 文件。你需要做的事：

```python
# 要写的内容：
# 1. 创建一个 async_client fixture，用 httpx.AsyncClient 包装 app
# 2. override get_db 依赖（当前阶段可以直接用同一个数据库，后面再改成测试库）
# 3. fixture scope 用 "function"

# 核心骨架：
import pytest
from httpx import ASGITransport, AsyncClient
from app.main import app

@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
```

**写 `tests/test_auth.py`**（至少 3 个测试）：

```python
# test_register_success — 注册成功返回 200 + 有 username 字段
# test_register_duplicate — 重复注册返回 400
# test_login_wrong_password — 错误密码返回 401
```

运行：
```bash
uv run pytest tests/ -v
```

**去问 ChatGPT 的问题**：
- pytest 的 fixture 机制是什么？和 unittest 的 setUp/tearDown 有什么区别？（fixture 更灵活，可以组合、参数化、有 scope 控制）
- fixture 的 `scope` 参数有哪几种？`function` / `class` / `module` / `session` 分别什么时候用？
- `pytest-asyncio` 的 `asyncio_mode = "auto"` 做了什么？不设置的话要怎么标记异步测试？（每个测试函数要加 `@pytest.mark.asyncio`）
- `conftest.py` 这个文件名是硬编码的吗？pytest 怎么发现它的？（是的，pytest 自动加载每个目录下的 conftest.py）
- `httpx.AsyncClient` 和 FastAPI 的 `TestClient` 有什么区别？异步项目为什么用 AsyncClient？（TestClient 底层是同步的，会阻塞事件循环；AsyncClient 原生异步）
- `ASGITransport` 是什么？为什么不直接传 `app=app`？（httpx 0.27+ 要求显式指定 transport）
- 测试数据库隔离策略有哪些？（独立测试库、事务回滚、SQLite 内存库，各有优劣）
- `app.dependency_overrides` 怎么用？为什么测试要 override `get_db`？

---

## Part B：数据模型与检测任务

### Step B1：`app/models/task.py` — Task 表模型

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
| original_path | str(500) \| None | nullable | 原图路径 |
| result_path | str(500) \| None | nullable | 结果图路径 |
| detect_result | JSON \| None | nullable | YOLO 推理结果 |
| created_at | datetime | server_default=func.now() | 创建时间 |
| user_id | int | ForeignKey("users.id") | 所属用户 |

**relationship**：
```python
# Task 侧
owner: Mapped["User"] = relationship(back_populates="tasks", lazy="selectin")

# User 侧（需要去 user.py 补上）
tasks: Mapped[list["Task"]] = relationship(back_populates="owner", lazy="selectin", cascade="all, delete-orphan")
```

**注意 `TYPE_CHECKING` 保护**：
```python
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from app.models.user import User
```

**你需要回答自己的问题**：

1. **`uuid` 字段为什么用 `str(36)` 而不是数据库原生 UUID 类型？**
   - UUID 标准格式 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 是 36 个字符
   - 字符串类型跨数据库兼容性更好，且方便拼接文件路径
   - 原生 UUID 类型在 PostgreSQL 里有专门优化（16字节存储），但对你的项目规模无所谓

2. **`status` 为什么用字符串而不是枚举？**
   - Python `enum.Enum` + SQLAlchemy 的枚举类型也可以，但字符串更简单
   - 枚举在数据库迁移时改动很麻烦（PostgreSQL 不支持直接删除枚举值）
   - 小项目字符串够用，大项目可以用枚举增加类型安全

3. **`ForeignKey("users.id")` 为什么写表名而不是类名？**
   - `ForeignKey` 里写的是**数据库表名.列名**，不是 Python 类名
   - 表名由 `__tablename__` 定义，和类名可以不同

4. **`cascade="all, delete-orphan"` 是什么意思？**
   - `all` = save-update + merge + refresh-expire + expunge + delete
   - `delete` 意味着删除 User 时自动删除关联的 Task
   - `delete-orphan` 意味着 Task 被从 User.tasks 列表中移除时也自动删除
   - 面试必问：**删用户是高风险操作**，因为会级联删除所有任务（含磁盘文件）

5. **`lazy="selectin"` 是什么？和 `joined`、`lazy` 的区别？**
   - `selectin`：用额外 SELECT ... WHERE id IN (...) 查询加载关系，适合一对多
   - `joined`：用 JOIN 一次查出来，适合一对一或多对一
   - `lazy`（默认 `select`）：访问属性时才发查询——异步环境下会报错（隐式 IO）
   - 面试点：**异步 SQLAlchemy 不支持隐式懒加载**，必须显式指定加载策略

6. **`detect_result` 为什么用 JSON 类型？**
   - 推理结果结构不固定（不同模型、不同数量的检测框）
   - 不需要对 JSON 内部字段做 SQL 查询（如果需要就该用 JSONB）
   - JSON 比新建一张 `detection_results` 表简单得多

---

### Step B2：更新 `app/models/user.py` — 补上 relationship

在 User 模型中添加与 Task 的关系：

```python
# 导入保护
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from app.models.task import Task

# 在 User 类中添加
tasks: Mapped[list["Task"]] = relationship(
    back_populates="owner", lazy="selectin", cascade="all, delete-orphan"
)
```

**你需要回答自己的问题**：

1. **为什么两边都要写 `relationship`？**
   - SQLAlchemy 的双向关系需要两端都定义 `relationship` + `back_populates`
   - 只写一端也行（用 `backref`），但显式双向更清晰，也是 2.0 推荐写法

2. **`TYPE_CHECKING` 为什么只在导入时用？**
   - 避免循环导入：user.py 导入 task.py，task.py 又导入 user.py → 报错
   - `TYPE_CHECKING` 块里的 import 只在类型检查工具（mypy）运行时执行，运行时不执行
   - 所以 relationship 里的类型字符串 `"Task"` 是字符串形式，SQLAlchemy 在运行时通过注册表解析

---

### Step B3：`app/schemas/task.py` — Task 的输入输出 Schema

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
   - Task 是通过文件上传创建的，不是通过 JSON body
   - 上传时的参数是 `UploadFile`（文件）+ `current_user`（token），不需要独立 schema

2. **`owner: UserPublic | None` 为什么嵌套了 UserPublic？**
   - Task 列表接口需要展示每个任务的创建者信息
   - 直接嵌套 `UserPublic` 避免前端再发一次请求查用户
   - 这就是 `selectinload` 的意义——一次查出来，转成嵌套 JSON

3. **分页为什么单独做一个 `TaskPaginationSchema`？**
   - 前端需要 `total` 来显示分页器（"共 X 条"）
   - 不能只返回 `list[TaskSchema]`，因为 `len(items)` ≠ 总数（你只返回了当前页）

---

### Step B4：`app/services/file_service.py` — 文件保存/删除服务

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
        # 1. 生成 uuid
        # 2. 创建 uploads/{uuid}/ 目录
        # 3. 写入文件
        # 4. 返回三元组

    @staticmethod
    def get_result_path(task_uuid: str, original_filename: str) -> str:
        """构造结果图路径"""
        # results/{uuid}/{filename}

    @staticmethod
    async def delete_files(uuid_str: str, filename: str) -> None:
        """删除原图和结果图目录"""
        # shutil.rmtree(uploads/{uuid})
        # shutil.rmtree(results/{uuid})
```

**你需要回答自己的问题**：

1. **为什么用 UUID 做文件夹名而不是用户名或任务 ID？**
   - 用户名可能有特殊字符（空格、中文），不适合做路径
   - 任务 ID 在写入文件时还没生成（auto increment 在 commit 后才有值）
   - UUID 全局唯一、无冲突、可预测长度

2. **`save_upload_file` 为什么是 `async`？**
   - `UploadFile.read()` 是 async 方法（FastAPI 的 UploadFile 包装了 async IO）
   - 但 `Path.write_bytes()` 本身是同步的——大文件时应该用 `aiofiles` 或 `asyncio.to_thread`
   - 当前阶段直接同步写没问题（图片通常几 MB），但心里要清楚这个瓶颈

3. **为什么要 `shutil.rmtree` 而不是只删文件？**
   - 每个任务的文件放在独立的 `{uuid}/` 目录下
   - 删目录比逐个删文件更干净，不会留下空目录

4. **路径拼接用 `Path` 还是字符串？**
   - 用 `pathlib.Path`，跨平台兼容、操作更直观
   - 避免 `os.path.join` 的字符串拼接问题

---

### Step B5：`app/crud/task.py` — Task CRUD

**要求**：

```python
async def get_task_by_id(db: AsyncSession, task_id: int) -> Task | None:
    # db.get(Task, task_id)

async def get_tasks_paginated(
    db: AsyncSession,
    user_id: int,
    is_superuser: bool,
    skip: int = 0,
    limit: int = 10,
) -> tuple[list[Task], int]:
    # 1. 基础 query = select(Task)
    # 2. 非管理员加 where(Task.user_id == user_id)
    # 3. count = select(func.count()).select_from(subquery)
    # 4. items = query.offset(skip).limit(limit).order_by(Task.created_at.desc())
    # 5. 返回 (items, total)
```

**你需要回答自己的问题**：

1. **分页查询为什么不用 `len(result.all())`？**
   - `result.all()` 会把所有数据加载到内存
   - 如果有 10 万条任务，内存直接爆掉
   - 用 `func.count()` 子查询让数据库计算总数，只返回一个数字

2. **为什么 `order_by(Task.created_at.desc())`？**
   - 最新的任务排在前面，符合用户直觉
   - 如果不指定排序，数据库返回顺序不确定（虽然通常是按插入顺序）

3. **管理员和普通用户的查询区别在哪？**
   - 普通用户只能看自己的任务（`where user_id = ?`）
   - 管理员能看所有人的任务（不加 where 条件）
   - 这是接口级权限控制，不是模型级的

4. **`db.get(Task, task_id)` 和 `select(Task).where(Task.id == task_id)` 的区别？**
   - `db.get` 先查 Session 缓存（Identity Map），缓存命中不发 SQL
   - `select().where()` 总是发 SQL
   - 按主键查单条用 `db.get` 更高效

---

### Step B6：`app/routers/tasks.py` — 检测任务路由

**要求**：

```python
# POST /tasks/upload — 批量上传文件 + 建任务 + 启动后台推理
# GET  /tasks — 分页列表（管理员看所有，普通用户看自己的）
# GET  /tasks/{task_id} — 任务详情
# DELETE /tasks/{task_id} — 删除任务（含清理磁盘文件）
```

**上传接口的核心逻辑**：

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
        # 3. 创建 Task 对象（status="processing"）
        # 4. db.add + db.commit + db.refresh
        # 5. background_tasks.add_task(background_detect_task, task.id, ...)
        # 6. append to created_tasks
    return created_tasks
```

**后台推理函数**（Day 3 先写占位，Day 4+ 再接 YOLO）：

```python
async def background_detect_task(task_id: int, file_path: str, result_path: str) -> None:
    """后台检测任务 — 必须使用独立 Session"""
    async with AsyncSessionLocal() as db:
        try:
            task = await db.get(Task, task_id)
            if not task:
                return
            # TODO: 接入 YOLO 推理
            # detect_result = YOLOService.predict(file_path, result_path)
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

1. **`background_detect_task` 为什么用 `AsyncSessionLocal()` 而不是路由的 `db` 参数？**
   - HTTP 请求的 `db` Session 在响应返回后就关闭了
   - `BackgroundTasks` 在响应返回**之后**才开始执行
   - 如果用请求 Session → `SessionClosedError`
   - **面试超高频问题**，必须能讲清楚

2. **为什么错误处理要用另一个独立 Session？**
   - 检测失败时，前一个 Session 可能已经处于异常状态（事务被回滚或连接断开）
   - 用新 Session 确保 status="failed" 的写入一定成功
   - 这是防御性编程：即使主逻辑崩了，至少状态能正确更新

3. **`BackgroundTasks` vs Celery 的区别？什么时候该用哪个？**
   - `BackgroundTasks` = 同进程、无持久队列、重启丢失、适合轻量任务
   - `Celery` = 独立 Worker 进程、有消息队列（Redis/RabbitMQ）、任务持久化、可重试
   - 你的项目用 BackgroundTasks 是因为：单机部署、任务量不大、失败可以重传
   - 面试话术："当前阶段够用，如果扩展到多实例部署会切换到 Celery/Arq"

4. **上传接口为什么不等推理完成就返回？**
   - YOLO 推理一张图可能要 2-30 秒
   - 如果同步等待，HTTP 连接会 hang 住，前端超时
   - 正确做法：立即返回 "processing" 状态，前端轮询查进度

5. **删除任务时为什么要同时删磁盘文件？**
   - 数据库只存了文件路径，不存文件本身
   - 如果只删数据库记录，磁盘上的图片变成"孤儿文件"，占用空间
   - 先删文件再删数据库记录（如果反过来，数据库删成功但文件删失败，就找不回路径了）

---

### Step B7：挂载路由 + Alembic 迁移

**改 `app/main.py`**：
```python
from app.routers import auth, user, tasks  # 新增 tasks

app.include_router(tasks.router, prefix="/api")
```

**改 `alembic/env.py`**：
在顶部 import 区域加：
```python
from app.models.task import Task  # noqa: F401
```

**执行迁移**：
```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 生成迁移文件
uv run alembic revision --autogenerate -m "add_tasks_table"

# 检查生成的文件！确认 upgrade 里有：
# - create_table('tasks', ...)
# - 外键 user_id -> users.id
# - unique index on uuid

# 执行迁移
uv run alembic upgrade head
```

**你需要回答自己的问题**：

1. **为什么每次加新 model 都要在 `env.py` 里 import？**
   - Alembic 的 `autogenerate` 通过对比 `Base.metadata`（Python 代码定义的表）和数据库实际的表结构来生成迁移
   - 如果 model 没被 import，Python 不会执行 class 定义，`Base.metadata` 里就没有这张表
   - 结果就是 autogenerate 什么都检测不到

2. **外键的 `ondelete` 策略有哪些？该用哪个？**
   - `CASCADE`：删父行时自动删子行（和 ORM 的 cascade 不同层——这是数据库层面的）
   - `SET NULL`：删父行时子行外键设为 NULL
   - `RESTRICT`：有子行时不允许删父行
   - 你的项目：ORM 层用 `cascade="all, delete-orphan"` 处理删除，数据库层建议也加 `ondelete="CASCADE"` 做双重保护

---

## Part C：验证

### Step C1：静态检查

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# ruff
uv run ruff check app/ tests/
uv run ruff format --check app/ tests/

# mypy（可能有一些 warning，先不要求零 error）
uv run mypy app/
```

### Step C2：pytest

```bash
uv run pytest tests/ -v
```

### Step C3：手动 curl 验证

```bash
# 启动
uv run uvicorn app.main:app --reload --port 8000

# 1. 登录拿 token
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -d "username=admin&password=admin" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
echo $TOKEN

# 2. 上传文件（用任意一张图片测试，没有的话用 echo 造一个假文件）
curl -X POST http://localhost:8000/api/tasks/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@/path/to/test_image.jpg"

# 3. 查看任务列表
curl http://localhost:8000/api/tasks?skip=0\&limit=10 \
  -H "Authorization: Bearer $TOKEN"

# 4. 查看单个任务详情（替换 task_id）
curl http://localhost:8000/api/tasks/1 \
  -H "Authorization: Bearer $TOKEN"

# 5. 删除任务
curl -X DELETE http://localhost:8000/api/tasks/1 \
  -H "Authorization: Bearer $TOKEN"
```

---

## Day 3 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/ tests/

# 2. 格式化无差异
uv run ruff format --check app/ tests/

# 3. mypy 能跑通（warning 可以有，error 数量记录下来）
uv run mypy app/

# 4. pytest 测试通过
uv run pytest tests/ -v

# 5. curl 上传 → 查列表 → 查详情 → 删除 全部正常
```

---

## 文件写作顺序

```
1. pyproject.toml                  ← 改（加 mypy + pytest 配置）
2. tests/__init__.py               ← 新建（空文件）
3. tests/conftest.py               ← 新建
4. tests/test_auth.py              ← 新建
5. app/models/task.py              ← 新建
6. app/models/user.py              ← 改（补 relationship）
7. app/schemas/task.py             ← 新建
8. app/services/file_service.py    ← 新建
9. app/crud/task.py                ← 新建
10. app/routers/tasks.py           ← 新建
11. app/main.py                    ← 改（挂 tasks 路由）
12. alembic/env.py                 ← 改（import Task）
13. alembic 迁移 + upgrade         ← 命令行
14. 验证（ruff + mypy + pytest + curl）
```

---

## 面试话术（90 秒）

> 检测任务模块用 FastAPI BackgroundTasks 实现异步推理。
> 上传接口接收文件后立即返回 "processing" 状态，后台任务独立 Session 执行 YOLO 推理并更新状态。
> 为什么用独立 Session？因为请求 Session 在 HTTP 响应返回后就关闭了，后台任务还在执行，用请求 Session 会报 SessionClosedError。
> Task 和 User 是多对一关系，用 cascade="all, delete-orphan" 实现级联删除——删用户时自动清理所有任务。
> 分页查询用 func.count() 子查询获取总数，避免全量加载到内存。
> 关系加载用 selectinload 解决 N+1 问题——没有它，N 个 task 访问 owner 会触发 N 次 SQL。
