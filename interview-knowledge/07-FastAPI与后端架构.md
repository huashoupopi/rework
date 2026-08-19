# 07 - FastAPI 与后端架构

> 面试准备文档：覆盖 FastAPI 核心概念、项目实战细节、架构设计模式。
> 所有代码示例均引用自本项目（windslice-backend）实际源码。
>
> 审校状态（2026-04-03）：
> - 当前仓库真实聊天流式实现是 `StreamingResponse + text/plain + fetch/ReadableStream`，不是标准 SSE
> - 文中出现的 `qwen3.5:4b`、`OLLAMA_BASE_URL` 属于 `config.py` 默认值示例；当前实际部署以 `.env` 为准，不能把默认值当成线上事实
> - 涉及 SSE 的段落保留为协议对比知识，面试时必须明确说“项目当前没有用标准 `text/event-stream`”

---

## 一、FastAPI 基础

### 1.1 什么是 FastAPI？

FastAPI 是一个基于 Python 3.7+ 的现代 Web 框架，核心特点：

- **高性能**：基于 Starlette（ASGI）和 Pydantic，性能接近 Node.js / Go
- **类型驱动**：利用 Python Type Hints 自动完成参数解析、验证、文档生成
- **自动文档**：内置 Swagger UI（`/docs`）和 ReDoc（`/redoc`）
- **原生异步**：原生支持 `async/await`，适合 I/O 密集型场景（数据库查询、外部 API 调用、文件读写）

### 1.2 FastAPI vs Flask vs Django

| 维度 | FastAPI | Flask | Django |
|------|---------|-------|--------|
| **协议** | ASGI（异步） | WSGI（同步） | WSGI（同步，3.0+ 部分支持 ASGI） |
| **类型系统** | 强制 Type Hints + Pydantic 验证 | 无内置验证 | Forms/Serializers |
| **性能** | 接近 Go/Node | 中等 | 中等 |
| **ORM** | 不内置，通常用 SQLAlchemy | 不内置 | 内置 Django ORM |
| **自动文档** | 内置 OpenAPI | 需第三方（flask-restx） | 需第三方（drf-spectacular） |
| **学习曲线** | 低（会 Python 类型就行） | 低 | 高（全栈框架概念多） |
| **适用场景** | API 服务、微服务、AI 后端 | 小型 API、原型 | 全栈 Web 应用、管理后台 |

**面试关键点**：

- Flask 是同步的，每个请求占一个线程；FastAPI 是异步的，一个线程可以处理数千并发连接
- Django 是"batteries included"全栈框架，FastAPI 是"精简 + 组合"的微框架思路
- FastAPI 的类型系统不只是文档装饰，它直接参与运行时验证——传错类型会返回 422 Unprocessable Entity

### 1.3 ASGI vs WSGI

```
WSGI（Web Server Gateway Interface）
  请求 → 同步处理 → 返回响应
  一个请求 = 一个线程/进程
  不支持 WebSocket、长连接、SSE

ASGI（Asynchronous Server Gateway Interface）
  请求 → async 处理 → 返回响应
  一个线程可以处理多个并发请求（协程调度）
  原生支持 WebSocket、SSE、HTTP/2
```

**为什么 ASGI 性能更好？**

关键在于 I/O 等待时间的利用。同步 WSGI 中，当一个请求在等待数据库响应时，该线程被阻塞，什么也干不了。ASGI 中，`await db.execute(query)` 会挂起当前协程，事件循环立刻切换去处理其他请求，等数据库返回后再恢复执行。

类比：
- WSGI = 餐厅只有一个服务员，点完菜就站在厨房门口等，不去服务其他桌
- ASGI = 服务员点完菜去服务下一桌，菜好了再回来送

**面试陷阱**：ASGI 不是"多线程"，是"单线程 + 协程"。如果你在 async 函数里做了 CPU 密集计算（不释放事件循环），所有请求都会被阻塞。这就是为什么 YOLO 推理要放到独立 Worker 进程。

### 1.4 Uvicorn / Gunicorn 的角色

```
客户端 → Uvicorn（ASGI Server）→ FastAPI（应用框架）

生产部署：
客户端 → Gunicorn（进程管理器）→ 多个 Uvicorn Worker（ASGI Server）→ FastAPI
```

- **Uvicorn**：ASGI 服务器，用 `uvloop`（基于 libuv 的高性能事件循环）处理网络 I/O。类比 WSGI 世界的 waitress/uWSGI
- **Gunicorn**：进程管理器（Process Manager），负责：
  - 启动/管理多个 Uvicorn Worker 进程
  - Worker 崩溃后自动重启
  - 优雅重载（graceful reload）
  - 利用多核 CPU（每个 Worker 一个进程，绕过 GIL）

**为什么需要 Gunicorn？**

单个 Uvicorn 进程是单线程的（虽然能处理大量并发），但无法利用多核 CPU。Gunicorn 作为进程管理器，fork 出多个 Uvicorn 子进程，每个子进程独立运行，充分利用多核。

生产启动命令示例：
```bash
gunicorn app.main:app \
  --workers 4 \
  --worker-class uvicorn.workers.UvicornWorker \
  --bind 0.0.0.0:8000
```

本项目开发环境启动方式（`pyproject.toml` 中 `fastapi[standard]` 自带 uvicorn）：
```bash
uv run uvicorn app.main:app --reload
```

### 1.5 类型提示（Type Hints）在 FastAPI 中的作用

Type Hints 在 FastAPI 中不只是"注释"，它们驱动三个核心行为：

**1. 自动参数解析**
```python
# 项目实际代码：backend/app/routers/task.py
@router.get("/tasks", response_model=TaskPaginationSchema)
async def get_tasks(
    skip: int = Query(0, ge=0),       # 自动解析 query string，验证 >= 0
    limit: int = Query(10, ge=1),     # 自动解析，验证 >= 1
    current_user: User = Depends(get_current_user),  # 依赖注入
    db: AsyncSession = Depends(get_db),               # 依赖注入
) -> TaskPaginationSchema:
```

- `skip: int` → FastAPI 知道从 query string 取 `skip` 参数并转为 `int`
- `Query(0, ge=0)` → 默认值 0，且必须 >= 0，不满足返回 422
- `response_model=TaskPaginationSchema` → 自动序列化返回值，过滤掉 Schema 中不存在的字段

**2. 自动请求体验证**
```python
# 项目实际代码：backend/app/routers/auth.py
@router.post("/auth/register", response_model=UserPublic)
async def register(user: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
```

`UserCreate` 是 Pydantic Model，FastAPI 自动：
- 从请求 JSON body 解析数据
- 按 `UserCreate` 的字段定义验证类型和约束
- 验证失败返回 422 + 详细错误信息

**3. 自动文档生成**

所有类型信息自动反映到 OpenAPI schema，Swagger UI 直接可用，无需额外维护 API 文档。

### 1.6 自动文档（Swagger UI / ReDoc）

FastAPI 内置两个文档 UI：
- `/docs` → Swagger UI：可交互测试 API
- `/redoc` → ReDoc：阅读友好的文档

文档来源：
- 路由装饰器的 `summary`、`description` 参数
- 函数 docstring
- Pydantic Model 的字段描述
- `tags` 参数用于分组

项目中的使用：
```python
# backend/app/routers/knowledge.py
@router.post(
    "/knowledge/documents/upload",
    response_model=KnowledgeUploadResponse,
    summary="上传知识库文档",        # Swagger UI 中显示的简短描述
)
async def upload_document(...):
    """
    上传文档到知识库。          # Swagger UI 中展开后的详细描述

    流程：
    1. 校验文件格式
    2. SHA256 → 按文档内去重
    ...
    """

router = APIRouter(tags=["知识库管理(Knowledge)"])  # API 分组标签
```

---

## 二、依赖注入（Dependency Injection）

### 2.1 什么是依赖注入？为什么需要？

**定义**：依赖注入（DI）是一种设计模式——组件不自己创建依赖对象，而是由外部"注入"进来。

**不用 DI 的代码**：
```python
async def get_tasks(skip: int, limit: int):
    db = await create_session()      # 每个路由自己创建数据库连接
    try:
        user = await verify_token()  # 每个路由自己验证 token
        result = await query(db, user.id, skip, limit)
        return result
    finally:
        await db.close()             # 每个路由自己清理连接
```

问题：
- 每个路由都要写数据库连接创建/关闭逻辑 → 大量重复代码
- 每个路由都要写认证逻辑 → 忘了就是安全漏洞
- 测试时无法替换真实数据库 → 测试困难

**用 DI 的代码**（项目实际代码）：
```python
# backend/app/routers/task.py
@router.get("/tasks", response_model=TaskPaginationSchema)
async def get_tasks(
    skip: int = Query(0, ge=0),
    limit: int = Query(10, ge=1),
    current_user: User = Depends(get_current_user),  # 注入认证结果
    db: AsyncSession = Depends(get_db),               # 注入数据库会话
) -> TaskPaginationSchema:
    result = await get_tasks_paginated(db, current_user.id, ...)
    return result
```

好处：
- **关注点分离**：路由只关心业务逻辑，不关心"怎么获取 db"、"怎么验证 token"
- **可复用**：`get_db`、`get_current_user` 被所有需要的路由复用
- **可测试**：测试时可以用 `app.dependency_overrides[get_db] = fake_db` 替换
- **声明式安全**：路由参数里写了 `Depends(get_current_user)` 就自动需要认证，忘不了

### 2.2 FastAPI 的 Depends 机制

`Depends()` 是 FastAPI 的依赖注入核心。执行流程：

```
请求到达
  ↓
FastAPI 解析路由函数签名
  ↓
发现 Depends(get_current_user) → 执行 get_current_user
  ↓
get_current_user 内部有 Depends(oauth2_scheme) → 先执行 oauth2_scheme
  ↓
get_current_user 内部有 Depends(get_db) → 执行 get_db
  ↓
所有依赖解析完毕 → 调用路由函数
  ↓
请求结束 → 清理 generator 依赖（关闭 db 连接等）
```

项目中的依赖链：
```python
# 完整依赖链：oauth2_scheme → get_current_user → 路由函数

# 第一层：从 Authorization header 提取 token
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

# 第二层：验证 token 并返回 User 对象
async def get_current_user(
    token: str = Depends(oauth2_scheme),   # 依赖第一层
    db: AsyncSession = Depends(get_db),     # 同时依赖 get_db
) -> User:
    # 1. 检查 token 是否在黑名单（Redis）
    # 2. JWT decode
    # 3. 查数据库获取用户
    # 4. 返回 User 对象

# 第三层：路由函数使用 get_current_user
@router.get("/tasks")
async def get_tasks(
    current_user: User = Depends(get_current_user),  # 依赖第二层
    db: AsyncSession = Depends(get_db),
):
    ...
```

### 2.3 依赖注入的作用域

**请求级依赖（Request Scope）** — 默认行为：

每个请求创建一个新实例，请求结束后销毁。项目中的 `get_db` 就是请求级的：

```python
# backend/app/core/database.py
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session        # 请求期间使用这个 session
        except:
            await session.rollback()
            raise
        finally:
            await session.close()  # 请求结束，关闭 session
```

**同请求内的依赖缓存**：

如果同一个请求中多个依赖都 `Depends(get_db)`，FastAPI 只会调用一次 `get_db`，所有依赖共享同一个 session。这保证了一个请求内的所有数据库操作在同一个事务中。

```python
# 同一个请求中，current_user 和路由函数中的 db 是同一个 session 实例
@router.post("/tasks/upload")
async def upload_tasks(
    current_user: User = Depends(get_current_user),  # get_current_user 内部也 Depends(get_db)
    db: AsyncSession = Depends(get_db),               # 这里的 db 和上面是同一个实例
):
```

**应用级依赖（Application Scope）**：

通过 `app = FastAPI(dependencies=[Depends(verify_api_key)])` 可以给所有路由添加全局依赖。

### 2.4 Generator 依赖（yield）

普通依赖 `return` 一个值；Generator 依赖 `yield` 一个值 + `yield` 后面的代码做清理。

```python
# 普通依赖：只提供值，不管清理
def get_config():
    return settings  # 返回后结束，没有清理逻辑

# Generator 依赖：提供值 + 保证清理
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session          # ← 这里暂停，把 session 交给路由函数使用
            # 路由函数执行完毕后，从这里恢复
        except:
            await session.rollback()  # 出错了回滚
            raise
        finally:
            await session.close()     # 无论如何都关闭 session
```

**yield 依赖的执行时序**：
```
1. 请求到达
2. get_db 执行到 yield → 暂停，session 交给路由函数
3. 路由函数使用 session 执行业务逻辑
4. 路由函数返回（或抛异常）
5. get_db 从 yield 后恢复 → 执行 finally 清理
6. 响应返回给客户端
```

**为什么用 yield 而不是在路由函数末尾手动 close？**

- 即使路由函数抛出异常，`finally` 块也保证执行 → 不会泄露数据库连接
- 清理逻辑写在一处，不用每个路由函数都写 try-finally

### 2.5 项目中的依赖注入模式

**get_db（数据库会话注入）**：
```python
# backend/app/core/database.py
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

**get_current_user（认证注入）**：
```python
# backend/app/routers/auth.py
async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )
    # 1. 检查黑名单
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    r = get_redis()
    if await r.get(f"blacklist:{token_hash}"):
        raise credentials_exception
    # 2. JWT 解码
    payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    user_id = payload.get("sub")
    # 3. 查数据库
    user = await db.get(User, int(user_id))
    if user is None:
        raise credentials_exception
    return user
```

**权限检查辅助函数**：
```python
# backend/app/routers/knowledge.py
def _require_superuser(user: User) -> None:
    if not user.is_superuser:
        raise HTTPException(status_code=403, detail="需要管理员权限")
```

这不是 `Depends` 式的依赖注入，但体现了同样的思想——把权限检查逻辑抽出来复用。

---

## 三、Pydantic 数据验证

### 3.1 什么是 Pydantic？与 dataclass 的区别

**Pydantic** 是 Python 的数据验证库，核心特点：
- 基于类型注解定义数据模型
- 运行时自动验证数据类型和约束
- 自动序列化/反序列化（JSON ↔ Python 对象）

**Pydantic vs dataclass**：

| 维度 | Pydantic BaseModel | dataclass |
|------|-------------------|-----------|
| **验证** | 运行时自动验证类型和约束 | 不验证，类型注解只是文档 |
| **类型转换** | 自动转换（`"123"` → `123`） | 不转换 |
| **序列化** | 内置 `.model_dump()` / `.model_dump_json()` | 需手动写 |
| **嵌套验证** | 支持 | 不支持 |
| **性能** | v2 用 Rust 核心，非常快 | 略快（但没有验证开销） |
| **适用场景** | API 输入/输出验证 | 内部数据容器 |

**面试关键点**：dataclass 的类型注解在运行时不做任何事，`@dataclass class User: age: int` 传入 `age="abc"` 不会报错。Pydantic 会报错。这就是为什么 API 边界必须用 Pydantic。

### 3.2 BaseModel 和 Field

```python
from pydantic import BaseModel, Field

class TaskSchema(BaseModel):
    id: int
    uuid: str
    file_name: str
    status: str
    created_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)
    # from_attributes=True 允许从 ORM 对象创建 Schema
    # 例如：TaskSchema.model_validate(sqlalchemy_task_obj)
```

`Field` 用于添加约束和元数据：
```python
class TaskPaginationSchema(BaseModel):
    items: list[TaskSchema]
    total: int = Field(..., description="总记录数")
    skip: int = Field(0, ge=0, description="跳过的记录数")
    limit: int = Field(10, ge=1, le=100, description="每页记录数")
```

### 3.3 Pydantic Settings：环境变量管理

这是项目中最重要的 Pydantic 用法之一。`pydantic-settings` 把环境变量/`.env` 文件映射为强类型的 Python 对象。

```python
# backend/app/core/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE_PATH = Path(__file__).resolve().parent.parent.parent / ".env"

class Settings(BaseSettings):
    # 数据库配置 — 从环境变量自动读取
    DB_HOST: str = ""
    DB_PORT: int = 5433           # str → int 自动转换！
    DB_USER: str = ""
    DB_PASSWORD: str = ""
    DB_NAME: str = ""
    DATABASE_URL: str = ""

    # JWT 配置
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 天

    # LLM 配置
    LLM_MODEL_NAME: str = "qwen3.5:4b"
    OLLAMA_BASE_URL: str = "http://localhost:11434"

    # RAG 配置
    RAG_SESSION_MEMORY_ENABLED: bool = True     # str "true"/"false" → bool 自动转换！
    RAG_SESSION_WINDOW_TURNS: int = 4

    # 知识库配置
    ALLOWED_DOC_SUFFIXES: str = ".pdf,.md,.markdown"  # 逗号分隔的字符串

    # Redis 配置
    REDIS_URL: str = ""
    REDIS_MAX_CONNECTIONS: int = 10

    # Pydantic Settings 配置
    model_config = SettingsConfigDict(
        env_file=_ENV_FILE_PATH if _ENV_FILE_PATH.exists() else None,
        env_file_encoding="utf-8",
        extra="ignore",          # 忽略 .env 中多余的变量，不报错
    )
```

**从 .env 文件加载配置**：

`SettingsConfigDict` 中的 `env_file` 指定 `.env` 文件路径。Pydantic Settings 的加载优先级：

```
环境变量 > .env 文件 > 代码中的默认值
```

这意味着：
1. 开发环境用 `.env` 文件
2. 生产环境用真实环境变量（Docker `--env` 或 K8s ConfigMap/Secret）
3. 生产环境的环境变量会覆盖 `.env` 中的值

**类型自动转换**：

`.env` 文件中所有值都是字符串，但 Pydantic Settings 自动转换：

```
DB_PORT=5433       → int(5433)
DB_ECHO=false      → bool(False)
RAG_MAX_CONCURRENCY=2  → int(2)
```

**`extra="ignore"` 的作用**：

`.env` 文件中可能有 Settings 类未定义的变量（比如 `NODE_ENV=development`）。默认 Pydantic 会报错，`extra="ignore"` 让它忽略这些多余变量。

**model_validator 派生计算字段**：

```python
@model_validator(mode="after")
def _build_derived_paths(self) -> "Settings":
    # 如果 DATABASE_URL 为空，从各个 DB_* 字段组装
    if not self.DATABASE_URL:
        pwd = quote_plus(self.DB_PASSWORD)
        self.DATABASE_URL = (
            f"postgresql+asyncpg://{self.DB_USER}:{pwd}"
            f"@{self.DB_HOST}:{self.DB_PORT}/{self.DB_NAME}"
        )
    # 自动创建必要的目录
    Path(self.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
    # 派生 HF_HOME 等路径
    if not self.HF_HOME:
        self.HF_HOME = str(model_path / "hf_cache")
    return self
```

`mode="after"` 表示在所有字段验证完成后执行。这样可以基于已验证的字段值计算派生字段。

**Settings 单例模式**：

```python
# 模块级别实例化，整个应用共享一个 Settings 实例
settings = Settings()
```

Python 模块只会被导入一次，所以 `settings` 是事实上的单例。所有模块通过 `from app.core.config import settings` 获取同一个实例。

### 3.4 请求体验证和序列化

**请求体验证（反序列化）**：

```python
# 客户端发送 JSON：{"username": "alice", "password": "123456"}
# FastAPI 自动用 UserCreate 验证

@router.post("/auth/register", response_model=UserPublic)
async def register(user: UserCreate, db: AsyncSession = Depends(get_db)) -> User:
    ...
```

如果客户端发送 `{"username": 123}`（username 应该是 str），FastAPI 返回：
```json
{
  "detail": [
    {
      "type": "string_type",
      "loc": ["body", "username"],
      "msg": "Input should be a valid string",
      "input": 123
    }
  ]
}
```

**响应序列化**：

```python
# response_model 控制返回给客户端的字段
@router.get("/tasks", response_model=TaskPaginationSchema)
async def get_tasks(...) -> TaskPaginationSchema:
    ...
```

`response_model` 的作用：
1. 过滤字段：ORM 对象可能有 `hashed_password`，但 `UserPublic` schema 没有这个字段，所以不会返回给客户端
2. 类型转换：`datetime` → ISO 格式字符串
3. 文档生成：Swagger UI 中显示响应结构

**model_validate：ORM → Pydantic**：
```python
# 项目中大量使用这个模式
items = [ChatMessageSchema.model_validate(msg) for msg in history]
doc_schema = KnowledgeDocumentSchema.model_validate(doc)
```

`model_validate` 需要 `model_config = ConfigDict(from_attributes=True)` 才能从 ORM 对象创建 Pydantic 实例（因为 ORM 对象用属性访问，不是字典）。

### 3.5 项目中的 Pydantic 使用总结

| 用途 | 示例 |
|------|------|
| 环境变量管理 | `Settings(BaseSettings)` — 类型安全的配置 |
| 请求体验证 | `UserCreate`、`ChunkConfigCreateSchema` — 输入验证 |
| 响应序列化 | `TaskSchema`、`ChatHistoryResponse` — 输出过滤 |
| Token 载荷 | `Token`、`TokenData` — JWT 结构定义 |
| ORM → API 转换 | `model_validate(orm_obj)` — 统一序列化 |

---

## 四、路由设计（RESTful API）

### 4.1 RESTful API 设计原则

REST（Representational State Transfer）核心原则：

1. **资源导向**：URL 代表资源，不代表操作
   - 正确：`GET /api/tasks`（获取任务列表）
   - 错误：`GET /api/getTaskList`（动词放在了 URL 里）

2. **HTTP 方法表达语义**：用 HTTP 方法区分操作，不用 URL
3. **统一接口**：所有资源遵循相同的 URL 和方法约定
4. **无状态**：每个请求包含所有必要信息（通过 JWT token 传递身份）

### 4.2 HTTP 方法语义

| 方法 | 语义 | 幂等性 | 项目示例 |
|------|------|--------|---------|
| **GET** | 获取资源 | 是 | `GET /api/tasks` — 获取任务列表 |
| **POST** | 创建资源 | 否 | `POST /api/tasks/upload` — 上传创建任务 |
| **PUT** | 全量替换 | 是 | `PUT /api/knowledge/chunk-configs/{id}` — 更新分块配置 |
| **PATCH** | 部分更新 | 是 | （项目中暂未使用） |
| **DELETE** | 删除资源 | 是 | `DELETE /api/tasks/{task_id}` — 删除任务 |

**幂等性**的意义：
- 幂等 = 同一请求执行一次和执行多次效果相同
- GET 天然幂等（读取不改变状态）
- DELETE 幂等（删除已删除的资源，结果还是"不存在"）
- POST 不幂等（每次提交创建一个新资源）
- 幂等性让客户端可以安全重试（网络超时后不知道服务端是否收到，重发请求不会产生副作用）

**面试关键点**：PUT 是全量替换（客户端发送完整对象），PATCH 是部分更新（只发送要修改的字段）。项目中 `update_chunk_config` 用了 PUT 但实际只更新传入的字段（`exclude_unset=True`），严格来说更接近 PATCH 语义。

### 4.3 路径参数、查询参数、请求体

**路径参数（Path Parameters）** — 标识特定资源：
```python
# backend/app/routers/task.py
@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(
    task_id: int,  # 自动从 URL 路径提取并转为 int
    ...
):
```

**查询参数（Query Parameters）** — 过滤、分页、排序：
```python
# backend/app/routers/chat.py
@router.get("/chat/history", response_model=ChatHistoryResponse)
async def get_history(
    task_id: int | None = Query(None),                    # 可选过滤
    limit: int = Query(50, ge=1, le=200),                 # 分页大小，约束 1~200
    order: str = Query(default="asc", pattern="^(asc|desc)$"),  # 正则验证
    before: int | None = Query(None),                     # 游标分页
    after: int | None = Query(None),                      # 游标分页
    ...
):
```

**请求体（Request Body）** — 创建/更新资源的数据：
```python
# backend/app/routers/knowledge.py
@router.post("/knowledge/chunk-configs", response_model=ChunkConfigSchema)
async def create_chunk_config(
    payload: ChunkConfigCreateSchema,  # 自动从 JSON body 解析
    ...
):
```

**Form 数据** — 特殊场景：
```python
# backend/app/routers/chat.py — 聊天接口同时发送文本和图片
@router.post("/chat/stream")
async def chat_stream(
    question: str = Form(...),              # Form 表单字段
    task_id: int | None = Form(None),       # 可选 Form 字段
    images: list[UploadFile] = File(default=[]),  # 文件上传
    ...
):
```

为什么聊天接口用 Form 而不是 JSON？因为要同时上传文件（`multipart/form-data`），JSON body 不支持文件上传。

**OAuth2 登录用 Form 的原因**：
```python
# backend/app/routers/auth.py
@router.post("/auth/login", response_model=Token)
async def login_for_access_token(
    form_data: OAuth2PasswordRequestForm = Depends(),  # OAuth2 规范要求 form-urlencoded
    ...
):
```

OAuth2 规范（RFC 6749）要求 token 请求使用 `application/x-www-form-urlencoded` 格式，不是 JSON。这是标准规定，不是框架限制。

### 4.4 响应模型和状态码

```python
# 标准 CRUD 状态码
@router.post("/tasks/upload", response_model=list[TaskSchema])
# 200 OK（默认）— 成功

@router.delete("/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
# 204 No Content — 删除成功，无响应体

@router.post("/auth/register", response_model=UserPublic)
# 200 OK — 注册成功（也可以用 201 Created）

@router.get("/auth/logout", status_code=204)
# 204 — 登出成功
```

常用 HTTP 状态码：
| 状态码 | 含义 | 项目使用场景 |
|--------|------|-------------|
| 200 | 成功 | 大多数 GET/POST 请求 |
| 204 | 成功但无内容 | DELETE 删除成功 |
| 400 | 请求参数错误 | "问题不能为空"、"文件为空" |
| 401 | 未认证 | Token 无效或过期 |
| 403 | 无权限 | 非管理员访问管理接口 |
| 404 | 资源不存在 | 任务/文档不存在 |
| 409 | 冲突 | 重复上传、并发锁冲突 |
| 422 | 验证失败 | Pydantic 验证失败（FastAPI 自动返回） |
| 429 | 请求过多 | 限流触发 |
| 500 | 服务器错误 | 文件保存失败等内部错误 |

### 4.5 APIRouter 的模块化路由

FastAPI 用 `APIRouter` 把路由分到不同模块，然后在 `main.py` 中统一注册：

```python
# 各模块定义自己的 router
# backend/app/routers/auth.py
router = APIRouter(tags=["认证(Auth)"])

# backend/app/routers/task.py
router = APIRouter(tags=["任务管理(Tasks)"])

# backend/app/routers/chat.py
router = APIRouter(tags=["chat"])

# backend/app/routers/knowledge.py
router = APIRouter(tags=["知识库管理(Knowledge)"])
```

```python
# backend/app/main.py — 统一注册
app.include_router(auth.router, prefix="/api")
app.include_router(user.router, prefix="/api")
app.include_router(task.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(knowledge.router, prefix="/api")
```

**`prefix="/api"`** 的作用：所有路由 URL 自动加上 `/api` 前缀。路由模块中写 `/tasks`，实际 URL 是 `/api/tasks`。

好处：
- 每个业务模块独立维护自己的路由
- `tags` 让 Swagger UI 自动分组
- `prefix` 避免 URL 冲突

### 4.6 路由注册顺序

```python
# backend/app/routers/task.py — 注释说明了一个重要细节
# 批量下载 要移动到/task/{task_id}之前 Fastapi按照注册顺序匹配
@router.get("/tasks/batch/download")
async def batch_download_tasks(...):
    ...

@router.get("/tasks/{task_id}", response_model=TaskSchema)
async def get_task_detail(...):
    ...
```

FastAPI 按注册顺序匹配路由。如果 `{task_id}` 在前面，`/tasks/batch` 中的 `batch` 会被当成 `task_id`。所以固定路径（`/batch/download`）必须注册在动态路径（`/{task_id}`）之前。

---

## 五、中间件（Middleware）

### 5.1 什么是中间件？执行顺序

中间件是在请求到达路由函数之前、响应返回客户端之前执行的"拦截器"。

```
请求 → 中间件A（前） → 中间件B（前） → 路由函数 → 中间件B（后） → 中间件A（后） → 响应
```

执行顺序是**洋葱模型**（Onion Model）：
- 请求阶段：中间件按注册顺序执行（先注册先执行）
- 响应阶段：中间件按注册逆序执行（后注册先执行）

### 5.2 CORS 中间件

```python
# backend/app/main.py
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],         # 允许所有来源（开发环境）
    allow_credentials=True,      # 允许携带 Cookie/Authorization
    allow_methods=["*"],         # 允许所有 HTTP 方法
    allow_headers=["*"],         # 允许所有自定义 Header
)
```

**CORS（Cross-Origin Resource Sharing）是什么？**

浏览器的同源策略（Same-Origin Policy）阻止前端页面（如 `http://localhost:3000`）向不同源的后端（如 `http://localhost:8000`）发请求。CORS 中间件在响应中添加 `Access-Control-Allow-Origin` 等 Header，告诉浏览器"允许跨域"。

**为什么项目用 `allow_origins=["*"]`？**

开发环境为了方便。生产环境应该改为具体的前端域名：
```python
allow_origins=["https://myapp.example.com"]
```

**面试关键点**：`allow_credentials=True` 和 `allow_origins=["*"]` 同时使用在生产环境是安全隐患。如果需要 credentials（Cookie/Authorization），`allow_origins` 必须指定具体域名，不能用 `*`。

**CORS 预检请求**：

浏览器在发送"非简单请求"（如 PUT、DELETE、带自定义 Header）之前，会先发一个 OPTIONS 预检请求，确认服务端允许跨域。CORS 中间件自动处理 OPTIONS 请求。

### 5.3 自定义中间件

FastAPI 支持两种方式定义中间件：

**方式一：函数式中间件**：
```python
@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    start_time = time.time()
    response = await call_next(request)
    process_time = time.time() - start_time
    response.headers["X-Process-Time"] = str(process_time)
    return response
```

**方式二：类式中间件**（实现 `BaseHTTPMiddleware`）：
```python
from starlette.middleware.base import BaseHTTPMiddleware

class LoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        logger.info(f"{request.method} {request.url}")
        response = await call_next(request)
        return response

app.add_middleware(LoggingMiddleware)
```

### 5.4 Lifespan 事件（startup / shutdown）

Lifespan 是 FastAPI 的应用生命周期管理机制，用于在应用启动和关闭时执行初始化/清理操作。

```python
# backend/app/main.py
from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ===== 启动阶段 =====
    setup_logging()                    # 初始化日志
    logger.info("Starting up...")
    await init_models()                # 初始化数据库表（如果需要）
    await RagService.initialize()      # 加载 RAG 模型和索引
    await init_redis()                 # 初始化 Redis 连接池

    yield  # ← 应用运行期间在这里暂停

    # ===== 关闭阶段 =====
    await close_redis()                # 关闭 Redis 连接池
    logger.info("Shutting down...")
    await engine.dispose()             # 关闭数据库引擎

app = FastAPI(lifespan=lifespan)
```

**为什么用 lifespan 而不是 `@app.on_event("startup")`？**

`on_event` 是旧 API，已被标记为 deprecated。`lifespan` 用 `asynccontextmanager` 模式：
- `yield` 之前 = startup
- `yield` 之后 = shutdown
- 更加 Pythonic，保证清理逻辑一定执行

**项目中 lifespan 做了什么？**

| 阶段 | 操作 | 原因 |
|------|------|------|
| 启动 | `setup_logging()` | 配置日志格式和级别 |
| 启动 | `await init_models()` | 初始化 SQLAlchemy 模型映射 |
| 启动 | `await RagService.initialize()` | 加载 embedding 模型、reranker 模型、pgvector 索引 |
| 启动 | `await init_redis()` | 创建 Redis 连接池和 Arq 连接池 |
| 关闭 | `await close_redis()` | 释放 Redis 连接 |
| 关闭 | `await engine.dispose()` | 关闭所有数据库连接 |

**面试关键点**：为什么 RAG 模型要在 startup 加载，不在第一次请求时加载？
- 模型加载耗时数秒到数十秒，第一个请求会超时
- startup 时加载，所有请求立即可用
- 如果加载失败，应用启动就失败，不会出现"运行中才发现模型没加载"的情况

### 5.5 项目中的中间件配置

本项目中间件相对精简：

```python
# backend/app/main.py
# 1. CORS 中间件（唯一显式注册的中间件）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

项目中的"类中间件"功能（虽然不是中间件，但起到类似作用）：
- **限流**：通过 `rate_limit()` 函数在路由开头调用，基于 Redis 固定窗口计数
- **分布式锁**：通过 Redis `SET NX` 在路由开头获取锁，防止并发冲突
- **认证**：通过 `Depends(get_current_user)` 依赖注入实现

---

## 六、流式响应（StreamingResponse）

### 6.1 StreamingResponse 原理

普通响应：服务端把全部数据准备好 → 一次性发给客户端。

流式响应：服务端边生成边发送 → 客户端边接收边显示。

```
普通响应：
  服务端 [===计算中===] → 一次性发送完整响应 → 客户端显示

流式响应：
  服务端 [生成token1] → 发送 → 客户端显示
         [生成token2] → 发送 → 客户端追加显示
         [生成token3] → 发送 → 客户端追加显示
         ...
```

为什么 AI 聊天必须用流式响应？
- LLM 生成完整回答可能需要 10-30 秒
- 用户不想看着空白页面等 30 秒
- 流式输出让用户看到"正在打字"的效果，体验大幅提升

### 6.2 SSE（Server-Sent Events）格式

SSE 是 HTTP 协议上的单向流式推送标准。本项目虽然没有严格使用 SSE 格式（用的是纯 `text/plain` 流），但理解 SSE 很重要：

```
SSE 格式：
data: token1\n\n
data: token2\n\n
data: [DONE]\n\n

本项目使用的是更简单的纯文本流：
media_type="text/plain"
直接 yield 文本 token，不加 "data:" 前缀
```

**项目中的响应头配置**：
```python
# backend/app/routers/chat.py
return StreamingResponse(
    event_generator(),
    media_type="text/plain",
    headers={
        "Cache-Control": "no-cache",       # 禁止缓存（流式内容不能缓存）
        "X-Accel-Buffering": "no",         # 禁止 Nginx 缓冲（否则 Nginx 会攒够一定量才发）
        "Connection": "keep-alive",        # 保持连接
    },
)
```

**`X-Accel-Buffering: no` 为什么重要？**

Nginx 默认会缓冲上游响应，攒够一定大小再发给客户端。对普通请求这能提升吞吐量，但对流式响应是灾难性的——用户要等很久才能看到第一个 token。

### 6.3 async generator 实现流式输出

```python
# backend/app/routers/chat.py — 核心流式生成器
async def event_generator():
    full_response = ""
    parser = ThinkStreamParser()      # 解析 <think>...</think> 标签

    async with AsyncSessionLocal() as bg_session:
        try:
            # 从 RAG 服务获取流式 token
            async for raw_token in RagService.generate_chat_stream(
                question=question,
                image_context=image_context,
                chat_window=session_messages,
                vision_image_paths=vision_image_paths,
                result_meta=result_meta,
            ):
                # 检测客户端是否断开
                if await request.is_disconnected():
                    logger.info("客户端已断开连接，停止生成")
                    break

                # 解析 token（处理 think 标签）
                parsed = parser.feed(raw_token)
                if parsed:
                    full_response += parsed
                    yield parsed                 # ← 实时发送给客户端

                await asyncio.sleep(0)           # 让出事件循环，不阻塞其他请求

            # 生成完毕，保存到数据库
            await chat_crud.create_message(
                bg_session,
                user_id=current_user.id,
                role="assistant",
                content=content_only,
                task_id=task_id,
                meta=meta or None,
            )
        except asyncio.CancelledError:
            logger.info("生成任务被取消")
            raise
        except Exception:
            logger.exception("流式生成失败")
            yield "\n[系统错误，请重试]"
        finally:
            await r.delete(lock_key)     # 无论如何释放分布式锁
```

**关键设计点**：

1. **客户端断开检测**：`await request.is_disconnected()` 在每个 token 后检查。如果用户关闭页面，立刻停止生成，不浪费 GPU 资源。

2. **`await asyncio.sleep(0)` 的作用**：让出事件循环控制权。如果不 yield，高速生成 token 时会独占事件循环，其他请求无法处理。`sleep(0)` 不真的等待，只是给事件循环一个调度其他协程的机会。

3. **独立的 db session**：流式生成器内部创建了独立的 `bg_session`（Background Session），而不是用路由函数注入的 `db`。原因：路由函数返回 `StreamingResponse` 后，`Depends(get_db)` 注入的 session 可能已经被清理。流式生成器在之后还需要操作数据库（保存消息），所以必须创建自己的 session。

4. **分布式锁**：Redis `SET NX` 防止同一用户同时发送多条消息。`finally` 块保证锁一定释放。

5. **流式去重**：某些本地或兼容 API 的推理服务会重复生成相同内容，项目实现了流式重复检测——用前 N 个字符作为特征串，检测后半段是否重复出现。

### 6.4 流式响应中的错误处理

```python
except Exception:
    logger.exception("流式生成失败")
    yield "\n[系统错误，请重试]"     # 在流中发送错误消息
```

流式响应的错误处理比普通响应复杂：
- HTTP 状态码在第一个 byte 发送时就确定了（200）
- 之后出错不能改状态码，只能在流内容中嵌入错误信息
- 前端需要检测流内容中的错误标记

---

## 七、文件上传与静态文件

### 7.1 UploadFile 类型

FastAPI 的 `UploadFile` 封装了 Starlette 的文件上传功能：

```python
from fastapi import File, UploadFile

# 单文件上传
@router.post("/knowledge/documents/upload")
async def upload_document(
    file: UploadFile = File(...),   # ... 表示必填
    ...
):

# 多文件上传
@router.post("/tasks/upload")
async def upload_tasks(
    files: list[UploadFile] = File(),  # 列表类型，支持多文件
    ...
):
```

`UploadFile` 的关键属性和方法：
- `file.filename` — 原始文件名
- `file.content_type` — MIME 类型（如 `image/jpeg`）
- `file.size` — 文件大小
- `await file.read()` — 读取全部内容（注意：只能读一次，读完指针到末尾）
- `await file.seek(0)` — 重置文件指针（读完后需要再读一次时用）

**为什么用 `UploadFile` 而不是 `bytes`？**

`UploadFile` 底层用 `SpooledTemporaryFile`：小文件存在内存，大文件自动写入临时文件。如果用 `file: bytes = File()`，整个文件都加载到内存，大文件会 OOM。

### 7.2 文件大小限制和类型校验

```python
# backend/app/routers/chat.py
_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_MAX_IMAGE_SIZE_MB = 10

for img_file in images:
    # 类型校验
    if img_file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400, detail=f"不支持的图片类型: {img_file.content_type}"
        )

    content = await img_file.read()

    # 大小校验（读取后校验）
    if len(content) > _MAX_IMAGE_SIZE_MB * 1024 * 1024:
        raise HTTPException(
            status_code=400, detail=f"图片大小超过 {_MAX_IMAGE_SIZE_MB} MB"
        )
```

**安全考虑 — EXIF 剥离**：
```python
# backend/app/routers/chat.py
def _strip_and_reencode(image_bytes: bytes, suffix: str) -> bytes:
    """剥离 EXIF 元数据 + 重编码图片。"""
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")  # 去除 alpha 通道中可能的隐藏数据
    buf = io.BytesIO()
    fmt = "PNG" if suffix.lower() == ".png" else "JPEG"
    img.save(buf, format=fmt, quality=90)
    return buf.getvalue()
```

为什么要剥离 EXIF？
- EXIF 可以嵌入任意文本（GPS 坐标、设备信息，甚至恶意脚本）
- Pillow 重新保存会丢弃所有非像素数据
- 重编码还能消除隐写术载荷

**文件存储策略 — 用户隔离**：
```python
# 按用户分目录，避免文件名冲突和越权访问
user_chat_dir = Path(settings.UPLOAD_DIR) / "chat" / str(current_user.id)
user_chat_dir.mkdir(parents=True, exist_ok=True)

# 文件名：时间戳 + UUID，完全避免冲突
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}{suffix}"
```

**图片配额管理**：
```python
# 每个用户最多保留 100 张聊天图片
_USER_IMAGE_QUOTA = 100

async def _enforce_user_image_quota(db, user_id):
    # 查询该用户的所有聊天图片，按创建时间倒序
    # 超过 100 张的，从旧到新删除
    if len(all_images) > _USER_IMAGE_QUOTA:
        to_delete = all_images[_USER_IMAGE_QUOTA:]
        for img in to_delete:
            file_path.unlink(missing_ok=True)   # 删文件
            await db.delete(img)                 # 删数据库记录
        await db.commit()
```

### 7.3 静态文件服务（StaticFiles mount）

```python
# backend/app/main.py
from fastapi.staticfiles import StaticFiles

# 确定静态文件目录
APP_DIR = Path(__file__).resolve().parent
if (APP_DIR.parent / "static").exists():
    STATIC_DIR = APP_DIR.parent / "static"
else:
    STATIC_DIR = Path("app/static").resolve()

# 挂载静态文件服务
if not STATIC_DIR.exists():
    os.makedirs(STATIC_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
```

**`mount` 的作用**：把一个 Starlette 子应用挂载到指定路径。访问 `/static/uploads/xxx.jpg` 时，直接返回文件内容，不经过路由逻辑。

**注意**：`mount` 必须在 `include_router` 之后，否则 `/static/...` 路径会被路由先匹配。但实际上 FastAPI 按注册顺序匹配，mount 的路径是前缀匹配，通常不会和 API 路由冲突（因为 API 路由有 `/api` 前缀）。

### 7.4 知识库文件上传流程

知识库上传比聊天图片上传复杂，涉及版本管理：

```python
# backend/app/routers/knowledge.py — 核心流程
async def upload_document(file, current_user, db):
    # [1] 校验文件格式（只允许 .pdf, .md, .markdown）
    if not knowledge_service.is_allowed_suffix(file.filename):
        raise HTTPException(...)

    # [2] 读取内容 + SHA256 哈希（用于去重）
    content = await knowledge_service.read_upload_file(file)
    content_hash = knowledge_service.compute_content_hash(content)

    # [3] 按文档内去重（同一文档内容相同的版本不重复创建）
    dup_version = await knowledge_crud.check_duplicate_hash(db, doc.id, content_hash)
    if dup_version:
        return "内容重复"

    # [4] 版本管理
    await knowledge_crud.mark_old_versions_not_current(db, doc.id)
    new_version_num = doc.latest_version + 1

    # [5] 文件系统双写
    storage_path = knowledge_service.save_version_file(...)    # 版本归档
    active_path = knowledge_service.write_active_document(...)  # active 目录

    # [6] 创建版本记录
    version = await knowledge_crud.create_version(db, ...)

    # [7] 统一 commit
    await db.commit()
```

---

## 八、错误处理

### 8.1 HTTPException

FastAPI 的标准异常处理方式：

```python
from fastapi import HTTPException, status

# 项目中的使用模式
raise HTTPException(status_code=404, detail="任务不存在")

raise HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="无法验证凭据",
    headers={"WWW-Authenticate": "Bearer"},  # OAuth2 规范要求
)

raise HTTPException(
    status_code=status.HTTP_403_FORBIDDEN,
    detail="没有权限访问此任务",
)

raise HTTPException(
    status_code=409,
    detail="上一条消息还在生成中，请稍后",
)

raise HTTPException(
    status_code=429,
    detail="请求过于频繁，请60秒后再试",
)
```

**HTTPException 的工作原理**：

1. 路由函数或依赖中 `raise HTTPException(...)`
2. FastAPI 的内置异常处理器捕获它
3. 返回 JSON 响应：`{"detail": "错误消息"}`
4. HTTP 状态码设为指定值

**为什么 401 要带 `WWW-Authenticate` Header？**

HTTP 规范（RFC 7235）要求：返回 401 时必须附带 `WWW-Authenticate` Header，告知客户端该用什么认证方式。`Bearer` 表示使用 Bearer Token 认证。

### 8.2 自定义异常处理器

```python
# FastAPI 支持注册自定义异常处理器
from fastapi import Request
from fastapi.responses import JSONResponse

@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc)},
    )
```

### 8.3 全局错误处理

FastAPI 内置了以下全局异常处理：

- `RequestValidationError` → 422（Pydantic 验证失败）
- `HTTPException` → 对应状态码
- `Exception`（未捕获） → 500 Internal Server Error

### 8.4 项目中的错误处理模式

**1. 分布式锁冲突（409 Conflict）**：
```python
# backend/app/routers/chat.py
lock_key = f"lock:chat:{current_user.id}"
acquired = await r.set(lock_key, "1", ex=120, nx=True)
if not acquired:
    raise HTTPException(status_code=409, detail="上一条消息还在生成中，请稍后")
```

**2. 限流（429 Too Many Requests）**：
```python
# backend/app/core/rate_limit.py
if current > limit:
    raise HTTPException(status_code=429, detail=f"请求过于频繁，请{window}秒后再试")
```

**3. 权限校验（403 Forbidden）**：
```python
# backend/app/routers/task.py
if task.user_id != current_user.id and not current_user.is_superuser:
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="没有权限访问此任务")
```

**4. 流式响应中的错误**：
```python
# backend/app/routers/chat.py — 流式响应不能用 HTTPException
except Exception:
    logger.exception("流式生成失败")
    yield "\n[系统错误，请重试]"     # 只能在流内容中嵌入错误
```

**5. 文件操作错误回滚**：
```python
# backend/app/routers/knowledge.py
try:
    storage_path = knowledge_service.save_version_file(...)
    active_path = knowledge_service.write_active_document(...)
except Exception:
    logger.exception("文件保存失败，回滚数据库 doc_key=%s", doc_key)
    await db.rollback()
    raise HTTPException(status_code=500, detail="文件保存失败") from None
```

`from None` 的作用：清除异常链，不把内部实现细节泄露给客户端。

---

## 九、项目结构设计

### 9.1 分层架构：Router → Service → CRUD → Model

```
├── routers/         # 路由层：处理 HTTP 请求/响应，参数验证
│   ├── auth.py      #   认证路由
│   ├── chat.py      #   聊天路由
│   ├── task.py      #   任务路由
│   ├── knowledge.py #   知识库路由
│   └── user.py      #   用户路由
│
├── services/        # 服务层：业务逻辑
│   ├── rag_service.py       # RAG 服务
│   ├── knowledge_service.py # 知识库服务
│   ├── file_service.py      # 文件操作服务
│   └── yolo_service.py      # YOLO 推理服务
│
├── crud/            # 数据访问层：纯数据库操作
│   ├── chat.py      #   聊天 CRUD
│   ├── task.py      #   任务 CRUD
│   ├── user.py      #   用户 CRUD
│   └── knowledge.py #   知识库 CRUD
│
├── models/          # 数据模型层：SQLAlchemy ORM 定义
│   ├── user.py
│   ├── task.py
│   ├── chat.py
│   ├── knowledge_document.py
│   └── knowledge_chunk_config.py
│
├── schemas/         # 数据传输对象：Pydantic Schema
│   ├── auth.py
│   ├── user.py
│   ├── task.py
│   ├── chat.py
│   ├── knowledge.py
│   └── knowledge_chunk_config.py
│
├── core/            # 核心配置
│   ├── config.py    #   Settings 配置
│   ├── database.py  #   数据库引擎和 session
│   ├── redis.py     #   Redis 连接管理
│   ├── security.py  #   密码哈希和 JWT
│   ├── rate_limit.py#   限流
│   └── logging.py   #   日志配置
│
├── security/        # 安全模块
│   └── __init__.py  #   Prompt Injection 检测
│
├── tasks/           # 后台任务
│   ├── yolo_task.py
│   └── knowledge_task.py
│
├── utils/           # 工具函数
│   └── stream_parser.py
│
├── main.py          # 应用入口
└── worker.py        # Arq Worker 配置
```

### 9.2 各层职责

| 层 | 职责 | 可以调用 | 不应该做 |
|----|------|----------|----------|
| **Router** | HTTP 协议处理、参数验证、权限检查 | Service、CRUD | 不应包含业务逻辑 |
| **Service** | 业务逻辑、外部服务集成 | CRUD、外部 API | 不应处理 HTTP 细节 |
| **CRUD** | 纯数据库操作 | Model（ORM） | 不应包含业务判断 |
| **Model** | 数据库表结构定义 | 无 | 不应包含逻辑 |
| **Schema** | 数据传输对象（DTO） | 无 | 不应包含逻辑 |

**分层的好处**：
- **可测试**：可以单独测试 CRUD 层，不需要启动 HTTP 服务
- **可替换**：替换数据库只需改 CRUD 层，Router 和 Service 不变
- **关注点分离**：每一层只关心自己的事情

### 9.3 关注点分离

项目中关注点分离的具体体现：

**Router 层**（backend/app/routers/chat.py）：
```python
@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    question: str = Form(...),        # ← HTTP 参数处理
    images: list[UploadFile] = ...,   # ← HTTP 文件处理
    current_user = Depends(get_current_user),  # ← 认证
    db = Depends(get_db),             # ← 数据库会话
):
    await rate_limit(...)              # ← 限流（横切关注点）
    # ... 调用 Service 和 CRUD
```

**Service 层**（RagService）：
```python
# 不关心 HTTP，只关心"怎么生成回答"
async for token in RagService.generate_chat_stream(
    question=question,
    image_context=image_context,
    chat_window=session_messages,
):
    yield token
```

**CRUD 层**：
```python
# 不关心"为什么要查"，只关心"怎么查"
await chat_crud.create_message(db, user_id=..., role="assistant", content=...)
await chat_crud.get_chat_history(db, user_id=..., limit=50)
```

### 9.4 配置管理模式（Settings 单例）

```python
# backend/app/core/config.py
class Settings(BaseSettings):
    ...

settings = Settings()  # 模块级单例
```

所有模块统一从 `app.core.config` 导入：
```python
from app.core.config import settings

# 使用
settings.DB_HOST
settings.LLM_MODEL_NAME
settings.RAG_SESSION_WINDOW_TURNS
```

**为什么不用全局变量或 os.environ.get()？**

- `os.environ.get("DB_PORT")` 返回字符串，需要手动 `int()` 转换
- 没有类型安全，拼错变量名不会报错
- 没有默认值管理
- 没有验证

Pydantic Settings 解决了以上所有问题，而且在应用启动时就完成验证——如果配置不合法，启动时就报错，不会运行到一半才发现配置问题。

---

## 十、健康检查

### 10.1 Liveness vs Readiness 探针

**Liveness Probe（存活探针）**：
- 回答"进程还活着吗？"
- 失败 → 容器编排器（K8s）重启容器
- 实现：只要进程能响应 HTTP 请求就行

**Readiness Probe（就绪探针）**：
- 回答"能处理请求吗？"
- 失败 → 容器编排器从负载均衡中移除该实例（但不重启）
- 实现：检查所有依赖服务是否正常（数据库、Redis、模型是否加载完成）

### 10.2 /health 和 /ready 端点的区别

```python
# 项目中的实现 — backend/app/main.py
@app.get("/health")
async def health_check():
    return {"status": "ok"}
```

这是一个最基本的 Liveness 探针：只要 FastAPI 能响应，就返回 200。

**完整的生产级健康检查应该是这样的**（项目中暂未实现 /ready）：

```python
# Liveness — 进程活着就行
@app.get("/health")
async def health_check():
    return {"status": "ok"}

# Readiness — 所有依赖都正常才算就绪
@app.get("/ready")
async def readiness_check():
    checks = {}

    # 检查数据库
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "failed"

    # 检查 Redis
    try:
        r = get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "failed"

    # 检查 RAG 模型是否加载
    checks["rag_model"] = "ok" if RagService.is_initialized() else "not_loaded"

    all_ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={"status": "ready" if all_ok else "not_ready", "checks": checks},
    )
```

### 10.3 Docker 和 K8s 中的健康检查配置

**Docker Compose**：
```yaml
services:
  backend:
    image: myapp-backend
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s  # 启动期间不检查（模型加载需要时间）
```

**Kubernetes**：
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 8000
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8000
  initialDelaySeconds: 10
  periodSeconds: 5
```

**面试关键点**：为什么需要 `initialDelaySeconds` / `start_period`？

本项目 lifespan 中要加载 RAG 模型（embedding、reranker），可能需要 30 秒以上。如果启动后立刻检查健康，模型还没加载完，探针失败，容器被重启，陷入无限重启循环。`start_period` 给应用一个"启动缓冲期"。

---

## 十一、Python 包管理

### 11.1 pip vs Poetry vs uv

| 工具 | 定位 | 速度 | 锁文件 | 虚拟环境管理 |
|------|------|------|--------|-------------|
| **pip** | 基础安装工具 | 慢 | 无（需 pip-compile） | 不管理（手动 venv） |
| **Poetry** | 完整依赖管理 | 中等 | `poetry.lock` | 内置 |
| **uv** | 下一代工具 | 极快（10-100x） | `uv.lock` | 内置 |

### 11.2 uv 的优势

uv 是 Astral（Ruff 团队）用 Rust 写的 Python 包管理工具：

- **速度**：比 pip 快 10-100 倍（Rust 实现 + 并行下载 + 全局缓存）
- **统一工具链**：替代 pip + pip-tools + virtualenv + pyenv
- **兼容性**：完全兼容 `pyproject.toml` 和 `requirements.txt`
- **确定性构建**：`uv.lock` 锁定所有依赖版本（包括传递依赖）

项目中的使用：
```bash
# 安装依赖
uv sync

# 运行命令（自动在虚拟环境中执行）
uv run uvicorn app.main:app --reload

# 启动 Arq Worker
uv run arq app.worker.WorkerSettings

# 添加依赖
uv add fastapi
uv add --dev ruff
```

### 11.3 pyproject.toml 配置详解

```toml
# backend/pyproject.toml

[project]
name = "windslice-backend"
version = "0.1.0"
requires-python = ">=3.12, <3.13"    # 锁定 Python 版本范围
dependencies = [
    # === Web 框架 ===
    "fastapi[standard]>=0.115",       # [standard] 包含 uvicorn、jinja2 等
    "python-multipart>=0.0.18",       # Form/文件上传支持

    # === ORM & 数据库 ===
    "sqlalchemy[asyncio]>=2.0",       # [asyncio] 包含异步支持
    "asyncpg>=0.30",                  # PostgreSQL 异步驱动
    "alembic>=1.14",                  # 数据库迁移工具
    "pgvector>=0.4.2",               # PostgreSQL 向量扩展

    # === 配置 & 安全 ===
    "pydantic-settings>=2.7",         # 环境变量管理
    "pyjwt>=2.10",                    # JWT 编解码
    "pwdlib[argon2]>=0.2",           # 密码哈希（Argon2 算法）

    # === AI/ML ===
    "ultralytics",                    # YOLO 目标检测
    "llama-index-core>=0.14.15",      # RAG 框架
    "llama-index-embeddings-huggingface>=0.6.1",  # HuggingFace embedding
    "torch>=2.10.0",                  # PyTorch

    # === 任务队列 ===
    "redis>=5.3.1",                   # Redis 客户端
    "arq>=0.27.0",                    # 异步任务队列
]

[dependency-groups]
dev = [
    "ruff>=0.9",                      # 代码格式化 + 静态分析
    "pytest>=8.0",                    # 测试框架
    "pytest-asyncio>=0.25",           # 异步测试支持
    "httpx>=0.28",                    # 测试用 HTTP 客户端
]
```

**`fastapi[standard]` 的含义**：

Python 的 extras 语法。`[standard]` 表示安装 FastAPI 时附带安装一组可选依赖（uvicorn、email-validator、jinja2 等）。等价于 `pip install fastapi uvicorn email-validator ...`。

**`requires-python = ">=3.12, <3.13"` 的意义**：

严格锁定 Python 3.12.x。为什么不用 `>=3.12`？
- Python 3.13 可能有不兼容的变更
- ML 库（torch、transformers）对 Python 版本敏感
- 确保开发/生产环境一致

### 11.4 依赖锁定：uv.lock

`uv.lock` 锁定所有依赖的精确版本（包括传递依赖）：

```
# uv.lock 的作用
pyproject.toml: "fastapi>=0.115"     → 版本范围（灵活）
uv.lock:        "fastapi==0.115.6"   → 精确版本（确定性）
```

- `pyproject.toml` 定义"我需要什么" → 声明依赖的版本范围
- `uv.lock` 定义"我实际安装什么" → 锁定每个包的精确版本 + hash

**为什么需要锁文件？**

没有锁文件：今天安装 `fastapi>=0.115` 得到 0.115.6，下周安装得到 0.116.0。如果 0.116.0 有 bug 或不兼容，生产环境就炸了。锁文件保证每次安装的版本完全一致。

### 11.5 开发依赖 vs 生产依赖

```toml
[dependency-groups]
dev = [
    "ruff>=0.9",          # 只在开发时用（代码检查）
    "pytest>=8.0",        # 只在开发时用（测试）
    "pytest-asyncio>=0.25",
    "httpx>=0.28",        # 只在测试时用（HTTP 客户端）
]
```

- `dependencies` → 生产必须的包
- `[dependency-groups] dev` → 只在开发/测试时需要

安装方式：
```bash
uv sync            # 安装所有依赖（包括 dev）
uv sync --no-dev   # 只安装生产依赖（Docker 构建时用）
```

**自定义镜像源**：
```toml
[[tool.uv.index]]
url = "https://pypi.tuna.tsinghua.edu.cn/simple"  # 清华镜像
default = true
```

**本地可编辑依赖**：
```toml
[tool.uv.sources]
ultralytics = { path = "../ultralytics1", editable = true }
```

`editable = true` 表示以开发模式安装本地包。修改源码后不需要重新安装，类似 `pip install -e`。项目中 ultralytics 是 fork 版本，放在本地目录。

### 11.6 Ruff 配置（代码质量）

```toml
[tool.ruff]
target-version = "py312"      # 按 Python 3.12 语法检查
line-length = 99               # 最大行宽

[tool.ruff.lint]
select = [
    "E",     # pycodestyle 错误
    "W",     # pycodestyle 警告
    "F",     # pyflakes（未使用变量等）
    "I",     # isort（import 排序）
    "B",     # flake8-bugbear（常见 bug 模式）
    "UP",    # pyupgrade（自动升级旧语法）
    "SIM",   # flake8-simplify（简化代码）
    "TCH",   # flake8-type-checking（类型导入优化）
]
ignore = ["E501", "UP035"]     # 忽略行长度和某些升级建议

[tool.ruff.lint.flake8-bugbear]
extend-immutable-calls = ["fastapi.Depends"]
# Depends 作为默认参数是安全的（FastAPI 设计如此），不要报 B008 警告

[tool.ruff.lint.per-file-ignores]
"app/routers/*.py" = ["B008"]   # router 文件中大量使用 Depends，全局忽略 B008
```

---

## 十二、网络、反向代理与服务治理

### 12.1 HTTP/1.1、HTTP/2 与长连接

很多人会用 FastAPI，但一问到 HTTP/1.1 和 HTTP/2 的区别就开始飘。这不行。后端工程师如果只会写路由，不理解协议层，系统一到高并发和流式场景就会掉坑里。

**HTTP/1.1 的关键点：**
- 默认支持 Keep-Alive，连接可复用
- 但同一 TCP 连接上的并发能力有限，容易队头阻塞（Head-of-Line Blocking）
- 浏览器通常会为同域名建立多个连接来缓解

**HTTP/2 的关键点：**
- 二进制分帧
- 多路复用：一个连接并发多个 stream
- Header 压缩（HPACK）
- 更适合高并发请求和大量小资源场景

**但要注意**：HTTP/2 不是“接口一定更快”。如果瓶颈在数据库、Redis、外部 LLM、磁盘 I/O，协议升级不会神奇解决问题。

### 12.2 Nginx / 反向代理的职责

后端不是直接裸奔在公网前。真实系统里通常会有一层反向代理（Nginx、Envoy、网关）。

反向代理至少承担这些职责：
- TLS 终止（HTTPS 证书）
- 路由转发（`/api` → backend，静态资源 → frontend）
- 压缩、缓存、限流、连接复用
- 统一访问日志
- 隐藏内部服务拓扑

本项目里 Nginx 还承担了两个很关键的点：
1. SPA 路由回退
2. `/static/` 与流式接口的正确代理

如果你不理解反向代理，流式输出、静态资源、跨域、健康检查这些问题会反复踩坑。

### 12.3 流式响应为什么容易被代理层搞坏

流式接口不是“后端 yield 就完了”。中间层如果 buffering 开着，前端看到的就不是流，而是整段结果憋到最后一次性吐出来。

所以流式链路要同时保证：
- 应用层逐段产出
- 代理层不要缓冲
- 客户端按 chunk 增量处理
- 断连时后端能及时停止生成

本项目里 `StreamingResponse` + `X-Accel-Buffering: no` + Nginx 配置，就是一个典型案例。

### 12.4 幂等、超时、重试、熔断、降级

这五个词不是八股，它们是一条链。

#### 幂等（Idempotency）

幂等的意思不是“接口不会重复调用”，而是**重复调用的结果与调用一次一致**。

必须幂等的典型场景：
- 支付回调
- 任务提交
- 文件上传去重
- 外部系统重试回调

**实现方式**：
- 幂等键（idempotency key）
- 唯一约束
- UPSERT
- 状态机约束

#### 超时（Timeout）

没有超时的系统，最终一定会在高峰期堆死。

你至少要设：
- 上游请求超时
- 数据库查询超时
- Redis 操作超时
- LLM / 外部 API 超时
- 后台任务执行超时

超时不是“失败”，而是**系统给自己留后路**。

#### 重试（Retry）

重试只适合处理**临时性失败**：瞬时网络抖动、短暂 502、主从切换窗口。

不适合重试的场景：
- 参数错误
- 业务校验失败
- 明确的权限拒绝
- 非幂等写操作但没有幂等保护

**重试必须有边界**：
- 最大次数
- 指数退避
- 总超时预算

#### 熔断（Circuit Breaker）

下游已经持续失败时，不要继续把流量打过去。熔断的目标不是“修好下游”，而是**保护自己不被拖死**。

#### 降级（Degrade）

系统在压力大或下游不可用时，要有“退一步还能活”的能力：
- 返回缓存
- 关闭非核心功能
- 减少返回字段
- 从流式改为短答复
- 暂停高成本模型链路

如果你只会说“我们接口失败就报错”，那不叫工程系统。

### 12.5 背压（Backpressure）

背压是高并发系统里经常被忽略的词。意思是：**下游处理不过来时，上游必须降速，而不是继续无脑灌流量**。

典型场景：
- 上传过快，worker 处理不过来
- SSE / 流式聊天连接过多
- 队列积压
- 数据库连接池耗尽

应对思路：
- 限流
- 队列长度阈值
- 拒绝新请求（429 / 503）
- 降低并发 worker 数
- 分级服务（核心请求优先）

## 十三、可观测性与稳定性

### 13.1 日志、指标、链路追踪，不是一回事

很多初学者把“打印日志”当成观测系统，这非常危险。

#### 日志（Logs）
回答的是：**发生了什么**。
- 适合记录离散事件和异常上下文
- 要结构化，别全是字符串拼接
- 至少要带：时间、level、request_id、user_id/trace_id、模块、错误信息

#### 指标（Metrics）
回答的是：**系统现在健康吗**。
- QPS
- P95/P99 延迟
- 错误率
- 队列长度
- 数据库连接池使用率
- Redis 命中率
- LLM 平均耗时 / token 成本

#### 链路追踪（Tracing）
回答的是：**一次请求慢在哪一段**。
- API 网关
- FastAPI 路由
- Redis
- PostgreSQL
- 外部 LLM
- Worker

这三者不是互斥关系，而是互补关系。只做其中一个，排障能力都不够。

### 13.2 request_id / trace_id 为什么重要

线上出故障时，如果你不能把一次请求在不同组件里的日志串起来，排障就会退化成撞运气。

**request_id**：适合单服务内关联日志。
**trace_id**：适合跨服务、跨进程、跨队列关联调用链。

本项目虽然当前还是单仓库体系，但已经有：
- backend
- worker
- redis
- postgres
- nginx

一旦没有统一请求标识，聊天接口、任务处理、知识库重建的日志很快就会散掉。

### 13.3 SLI / SLO / SLA

这是中高级面试经常拿来区分“会写代码”和“懂服务运营”的点。

- **SLI**（Service Level Indicator）：可观测指标，例如成功率、P95 延迟
- **SLO**（Service Level Objective）：目标，例如“99% 请求在 800ms 内完成”
- **SLA**（Service Level Agreement）：对外承诺，带商业责任

不要把三者混用。

对这个项目，合理的 SLI 可以是：
- 聊天首 token 延迟
- 上传接口成功率
- 任务完成率
- 知识库重建成功率
- `/ready` 健康检查通过率

### 13.4 稳定性建设的优先级

如果时间有限，优先顺序应该是：
1. 正确的超时与异常处理
2. 结构化日志
3. 核心指标与告警
4. trace_id 贯穿链路
5. 再考虑全量 tracing 平台

不要一上来就谈 OpenTelemetry 全家桶，却连 500 错误率都没有告警。

## 十四、部署、发布与资源隔离

### 14.1 健康检查：liveness vs readiness

这两个概念混了，部署就会出事故。

- **liveness**：进程还活着吗？死锁了没？要不要重启？
- **readiness**：它现在能不能接流量？依赖是否就绪？模型是否加载完？

本项目的 `/ready` 更偏 readiness，因为它要确认服务真正可接请求，而不是单纯进程存在。

### 14.2 Uvicorn / Gunicorn / Worker 模型

单个 Uvicorn 进程适合开发或轻量部署；生产里通常需要多个 worker 进程来利用多核。

但注意：
- worker 不是越多越好
- 每个 worker 都会持有自己的连接池、内存、模型句柄
- 如果每个进程都去加载大模型，内存会炸

所以对于本项目这种同时有 API + 异步任务 + AI 推理/检索的系统，更合理的方式是：
- API 进程负责接入和轻逻辑
- Worker 进程负责重任务
- 模型加载边界清晰
- Redis/DB 连接池分角色控制

### 14.3 滚动发布、金丝雀、回滚

真正的发布策略不是 `docker compose up --build -d` 这一步，而是：
- 新版本能否和旧版本并存
- schema 变更是否向后兼容
- 出错后能否快速回滚
- 是否能先给小流量验证

**滚动发布**：逐步替换实例，适合无状态服务。
**金丝雀发布**：先给少量流量，观察指标再放量。
**回滚**：版本出问题时快速切回旧镜像/旧配置。

### 14.4 资源隔离与容器边界

容器不是“为了好看”，而是为了隔离：
- CPU
- 内存
- 文件系统
- 依赖环境
- 启动命令

对这个项目来说，最关键的边界是：
- backend 和 worker 共享镜像，但职责不同
- postgres / redis 独立容器
- frontend 用 Nginx 提供静态资源与反向代理

如果未来要继续演进，必须继续守住这个边界，不要把所有东西重新揉进一个“超级容器”。

### 14.5 Secret、配置与镜像构建边界

工程级部署一定要分清：
- **代码** 在镜像里
- **配置** 通过环境变量 / `.env` / Secret 注入
- **运行时数据** 通过 volume 挂载

把密码、token、模型缓存、上传文件全塞进镜像，是非常危险且难维护的做法。

---

## 十五、面试高频问题

### Q1: FastAPI 和 Flask 最大的区别是什么？

**答**：核心区别在于**异步模型**和**类型系统**。

Flask 基于 WSGI（同步协议），一个请求占一个线程，高并发需要多线程/多进程。FastAPI 基于 ASGI（异步协议），一个线程可以处理数千并发连接（通过 `async/await` 协程），更适合 I/O 密集型场景。

第二个区别是类型系统：FastAPI 利用 Python Type Hints + Pydantic 在运行时自动做参数验证、序列化、文档生成。Flask 没有内置验证，需要手动写或用第三方库（marshmallow、flask-restx）。

在我的项目中，后端需要同时处理数据库查询（asyncpg）、Redis 操作、LLM 流式推理、文件上传——这些全是 I/O 密集操作，FastAPI 的异步模型完美匹配。

---

### Q2: 什么是依赖注入？FastAPI 中怎么用？

**答**：依赖注入是一种设计模式——组件不自己创建依赖，而是由框架注入进来。

FastAPI 通过 `Depends()` 实现。在我的项目中，最典型的两个依赖是 `get_db` 和 `get_current_user`：

```python
@router.get("/tasks")
async def get_tasks(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
```

`get_current_user` 内部还依赖 `oauth2_scheme` 和 `get_db`，形成依赖链。FastAPI 自动解析依赖树，按正确顺序执行。

好处：
1. 关注点分离——路由不关心"怎么获取 db session"
2. 可测试——可以用 `app.dependency_overrides` 替换依赖
3. 安全——写了 `Depends(get_current_user)` 就自动需要认证

---

### Q3: 解释 yield 依赖（Generator 依赖）的工作原理

**答**：普通依赖 return 一个值就结束了。yield 依赖在 yield 后面还有清理代码。

```python
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session          # 提供 session 给路由函数
        except:
            await session.rollback()  # 出错回滚
            raise
        finally:
            await session.close()     # 保证关闭
```

执行流程：
1. 请求到达 → `get_db` 执行到 `yield` → session 交给路由函数
2. 路由函数执行业务逻辑
3. 路由函数返回或抛异常 → `get_db` 从 yield 后恢复
4. finally 保证 session 关闭 → 不会泄露数据库连接

关键点：即使路由函数抛异常，finally 也一定执行。这比在每个路由函数末尾手动 close 安全得多。

---

### Q4: Pydantic Settings 是怎么管理配置的？

**答**：Pydantic Settings 把环境变量和 `.env` 文件映射为强类型的 Python 对象。

在我的项目中：
```python
class Settings(BaseSettings):
    DB_PORT: int = 5433      # .env 中 DB_PORT="5433" 自动转为 int
    DB_ECHO: bool = False    # .env 中 DB_ECHO="true" 自动转为 bool
```

加载优先级：环境变量 > .env 文件 > 代码默认值。

这样开发环境用 `.env` 文件，生产环境用真实环境变量（Docker `--env` 或 K8s Secret），无需改代码。

我还用了 `model_validator(mode="after")` 来计算派生字段——比如从 `DB_HOST`、`DB_PORT` 等字段自动拼接出 `DATABASE_URL`，如果用户直接提供了 `DATABASE_URL` 就不拼接。这种模式让配置既灵活又安全。

---

### Q5: 你的项目怎么做认证和授权的？

**答**：使用 OAuth2 + JWT + Redis 黑名单。

**认证流程**：
1. 用户 POST `/api/auth/login`（form-urlencoded，OAuth2 规范要求）
2. 后端验证用户名密码（Argon2 哈希比对）
3. 生成 JWT token（payload 包含 `sub`=用户ID，`exp`=过期时间）
4. 返回 `{"access_token": "...", "token_type": "bearer"}`

**鉴权流程**（`get_current_user` 依赖链）：
1. `OAuth2PasswordBearer` 从 `Authorization: Bearer xxx` 头提取 token
2. 检查 Redis 黑名单（token hash → 是否已登出）
3. JWT 解码验证签名和过期时间
4. 从 payload 取 `user_id`，查数据库获取用户对象

**登出**：
- 把 token hash 存入 Redis 黑名单，TTL = token 剩余有效时间
- 下次请求带这个 token 时，在黑名单中找到 → 拒绝

**授权**：
- 知识库管理接口要求 `is_superuser=True`
- 任务数据按 `user_id` 隔离，非超级管理员只能访问自己的数据

---

### Q6: StreamingResponse 是怎么工作的？为什么 AI 聊天要用流式响应？

**答**：StreamingResponse 接受一个 async generator，每次 yield 的内容立刻发送给客户端。

为什么需要流式？LLM 生成完整回答要 10-30 秒，用户不想看空白页面。流式输出让用户实时看到"打字效果"。

在我的项目中：
```python
async def event_generator():
    async for token in RagService.generate_chat_stream(...):
        if await request.is_disconnected():
            break  # 用户关闭页面就停止生成
        yield token
        await asyncio.sleep(0)  # 让出事件循环

return StreamingResponse(
    event_generator(),
    media_type="text/plain",
    headers={"X-Accel-Buffering": "no"},  # 禁止 Nginx 缓冲
)
```

几个关键设计：
1. **断开检测**：每个 token 后检查客户端是否断开，避免浪费 GPU
2. **`asyncio.sleep(0)`**：让出事件循环，不阻塞其他请求
3. **独立 db session**：流式生成器需要在路由函数返回后继续操作数据库
4. **分布式锁**：Redis SET NX 防止同一用户同时发多条消息

---

### Q7: 你的项目怎么做限流的？

**答**：基于 Redis 的固定窗口计数算法。

```python
async def rate_limit(user_id, endpoint, limit=10, window=60):
    key = f"ratelimit:{user_id}:{endpoint}"
    current = await r.incr(key)   # 原子递增
    if current == 1:
        await r.expire(key, window)  # 第一次请求设过期时间
    if current > limit:
        raise HTTPException(status_code=429, ...)
```

项目中的限流策略：
- 聊天接口：每用户每 60 秒最多 10 次
- 上传接口：每用户每 60 秒最多 20 次

为什么用 Redis 而不是内存计数？
- 多进程/多实例部署时，内存计数不共享
- Redis 是共享状态，所有实例看到的计数一致

固定窗口的缺点：窗口边界处可能突发（窗口结束前 1 秒 10 次 + 新窗口开始后 1 秒 10 次 = 2 秒内 20 次）。改进方案是滑动窗口，但固定窗口实现简单，对本项目够用。

---

### Q8: 你的项目怎么做分布式锁的？

**答**：Redis `SET key value NX EX timeout`。

```python
# 聊天接口 — 防止同一用户同时生成两条回复
lock_key = f"lock:chat:{current_user.id}"
acquired = await r.set(lock_key, "1", ex=120, nx=True)
if not acquired:
    raise HTTPException(status_code=409, detail="上一条消息还在生成中")
```

- `NX`（Not eXists）：key 不存在才设置成功 → 第一个请求获取锁，后续请求失败
- `EX 120`：120 秒自动过期 → 防止死锁（如果进程崩溃没释放锁）
- `finally: await r.delete(lock_key)` → 正常结束时主动释放锁

文件上传也用了类似机制，但 key 中加入了文件 hash，防止同一文件重复上传：
```python
lock_key = f"lock:upload:{current_user.id}:{file_hash}"
```

---

### Q9: ASGI 和 WSGI 有什么区别？为什么 FastAPI 选择 ASGI？

**答**：WSGI 是同步协议，一个请求占一个线程；ASGI 是异步协议，一个线程可以处理上千并发连接。

关键区别在于 I/O 等待时间的利用：
- WSGI：线程在等数据库响应时被阻塞，什么也干不了
- ASGI：`await db.execute()` 挂起协程，事件循环切换处理其他请求

FastAPI 选择 ASGI 因为现代 Web 应用大量 I/O 密集操作：数据库查询、Redis 操作、外部 API 调用、文件读写。ASGI 让一个进程就能高效处理这些并发 I/O。

但注意：如果是 CPU 密集型任务（如 YOLO 推理），async 不会帮忙——CPU 计算不能被"挂起"。所以我的项目把 YOLO 推理放到了 Arq Worker 独立进程中。

---

### Q10: Pydantic BaseModel 和 Python dataclass 有什么区别？

**答**：最关键的区别是**运行时验证**。

dataclass 的类型注解只是文档，不做任何验证：
```python
@dataclass
class User:
    age: int

u = User(age="abc")  # 不报错！age 存的是字符串 "abc"
```

Pydantic BaseModel 在运行时验证并转换类型：
```python
class User(BaseModel):
    age: int

u = User(age="123")  # 自动转为 int(123)
u = User(age="abc")  # 报 ValidationError！
```

API 边界必须用 Pydantic，因为客户端数据不可信——你永远不知道前端会发什么类型的数据过来。Pydantic 是 API 输入的第一道防线。

---

### Q11: 解释你项目中的 Lifespan 事件做了什么

**答**：Lifespan 管理应用的启动和关闭。

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动
    setup_logging()             # 配置日志
    await init_models()         # 数据库模型初始化
    await RagService.initialize()  # 加载 embedding + reranker 模型
    await init_redis()          # 创建 Redis 连接池

    yield  # 应用运行中...

    # 关闭
    await close_redis()         # 释放 Redis 连接
    await engine.dispose()      # 关闭数据库连接池
```

为什么不在第一次请求时加载模型？
1. 模型加载可能需要 30 秒以上 → 第一个请求超时
2. startup 阶段加载失败 → 应用直接启动失败，及时发现问题
3. 所有请求立即可用，不需要处理"模型未加载"的竞态条件

为什么用 `asynccontextmanager` 而不是 `@app.on_event`？
- `on_event` 已 deprecated
- `asynccontextmanager` 更 Pythonic，yield 前后天然对应 startup/shutdown

---

### Q12: 你的项目怎么处理文件上传安全性？

**答**：多层防护。

1. **文件类型白名单**：只允许 `image/jpeg`、`image/png`、`image/webp`
2. **文件大小限制**：超过 10MB 拒绝
3. **EXIF 剥离 + 重编码**：用 Pillow 重新保存图片，丢弃所有非像素数据（防止 EXIF 注入和隐写术）
4. **文件名安全**：不用原始文件名，用 `时间戳_UUID` 生成唯一文件名
5. **用户隔离**：每个用户的文件存在独立目录 `uploads/chat/{user_id}/`
6. **配额限制**：每用户最多 100 张图片，超出自动清理最旧的

知识库上传还增加了：
7. **SHA256 去重**：同一内容不重复存储
8. **后缀白名单**：只允许 `.pdf`、`.md`、`.markdown`
9. **管理员权限**：只有 superuser 才能上传

---

### Q13: 什么是 OAuth2PasswordBearer？为什么登录用 Form 而不是 JSON？

**答**：`OAuth2PasswordBearer` 是 FastAPI 内置的 OAuth2 密码流安全方案。

它做两件事：
1. 在 Swagger UI 中显示"登录"按钮（让你能在文档中测试认证 API）
2. 自动从 `Authorization: Bearer <token>` 头提取 token

为什么登录用 Form（`OAuth2PasswordRequestForm`）而不是 JSON？

这是 OAuth2 规范（RFC 6749）的要求。Token 请求必须使用 `application/x-www-form-urlencoded` 格式，字段名固定为 `username` 和 `password`。不是框架限制，是协议规定。

这个设计的好处是：任何 OAuth2 兼容的客户端库都能直接对接，不需要看你的 API 文档就知道登录接口怎么调用。

---

### Q14: 你怎么做后台任务？为什么用 Arq 而不是 Celery？

**答**：项目使用 Arq（基于 Redis 的异步任务队列）。

架构：
```
API 进程（FastAPI）→ Redis 队列 → Worker 进程（Arq）
```

入队：
```python
job = await arq.enqueue_job("run_yolo_detection", task_id)
```

Worker 独立进程运行：
```bash
uv run arq app.worker.WorkerSettings
```

为什么用 Arq 不用 Celery？
1. **原生异步**：Arq 是 async-first，和 FastAPI 天然搭配。Celery 是同步设计，在异步环境中使用需要额外适配
2. **轻量**：Arq 只依赖 Redis，Celery 需要 Redis/RabbitMQ + 大量配置
3. **简单**：注册函数、入队、重试，代码量少
4. **项目规模匹配**：Celery 适合大型分布式系统，本项目不需要那么复杂的任务编排

Worker 配置：
```python
class WorkerSettings:
    functions = [run_yolo_detection, run_knowledge_rebuild]
    max_jobs = 4          # 并发数
    job_timeout = 120     # 单任务超时
    max_tries = 3         # 失败重试（指数退避）
```

---

### Q15: 解释你的项目中 Redis 的所有用途

**答**：Redis 在项目中有 5 个用途：

1. **任务队列**：Arq 用 Redis 作为消息队列，API 进程入队，Worker 进程消费
2. **限流计数**：固定窗口算法，`INCR ratelimit:{user_id}:{endpoint}` + `EXPIRE`
3. **分布式锁**：`SET lock:chat:{user_id} 1 NX EX 120`，防止并发冲突
4. **结果缓存**：已完成的任务结果缓存 1 小时，减少数据库查询
5. **Token 黑名单**：登出时 `SET blacklist:{token_hash} 1 EX {remaining}`

每个用途都对应 Redis 的不同特性：
- 任务队列 → LIST 数据结构（Arq 内部使用）
- 限流 → INCR 原子操作 + EXPIRE 自动过期
- 分布式锁 → SET NX 原子性（不存在才设置）
- 缓存 → GET/SET + EX 过期
- 黑名单 → GET/SET + EX 过期（TTL = token 剩余有效时间）

---

### Q16: 你怎么做 Prompt Injection 防护？

**答**：三重检测 + 评分机制。

**为什么用评分而不是布尔值？**
- 布尔值阈值很难设——太松被绕过，太严误杀正常查询
- 评分更细粒度：单条弱信号不阻断，多条弱信号叠加才阻断

**三重防护**：
1. **用户输入检测**（第一道）：score >= 6 阻断，3-5 净化（记录但放行）
2. **上下文节点检测**（第二道）：检索到的文档 chunk，score >= 3 剔除
3. **输出泄露检测**（第三道）：检查 LLM 回答是否泄露 system prompt

技术细节：
- Unicode NFKC 归一化（防 Unicode 变体绕过）
- 零宽字符剥离（防零宽空格打断关键词）
- 用户输入和上下文用不同规则集（技术文档必然有 `---`、`` ``` `` 等标记）
- 正则预编译（`re.compile`），避免每次调用重复编译

---

### Q17: `from None` 在 `raise HTTPException(...) from None` 中是什么意思？

**答**：清除异常链（exception chain）。

Python 中，在 `except` 块里 raise 新异常时，默认会保留原始异常作为 `__cause__`：
```python
try:
    1/0
except ZeroDivisionError:
    raise ValueError("计算错误")
# 输出：ZeroDivisionError → ValueError（显示两个异常）
```

`from None` 显式断开异常链：
```python
try:
    save_file()
except IOError:
    raise HTTPException(500, "文件保存失败") from None
# 只显示 HTTPException，不暴露内部 IOError 细节
```

安全考虑：内部异常可能包含文件路径、数据库连接字符串等敏感信息，不应该返回给客户端。

---

### Q18: 为什么主程序要在 import FastAPI 之前先清理代理环境变量？

**答**：
```python
# backend/app/main.py
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)
```

因为后端可能要请求本地推理服务（例如默认配置里的 Ollama 地址 `http://localhost:11434`）。如果开发机设了代理（科学上网），所有 HTTP 请求（包括 localhost）都会走代理 → 代理服务器找不到本地服务 → 请求失败。

必须在 import 之前设置，因为某些库在 import 时就读取代理设置（httpx、aiohttp 等），之后再改无效。

这是开发环境的实际踩坑经验：Ollama 请求莫名超时，排查发现是代理拦截了 localhost 请求。

---

### Q19: APIRouter 的路由注册顺序为什么重要？

**答**：FastAPI 按注册顺序匹配路由。

```python
# 错误顺序（batch 会被当成 task_id）
@router.get("/tasks/{task_id}")      # ← /tasks/batch 中 "batch" 匹配 task_id
@router.get("/tasks/batch/download") # ← 永远匹配不到

# 正确顺序
@router.get("/tasks/batch/download") # ← 固定路径先注册
@router.get("/tasks/{task_id}")      # ← 动态路径后注册
```

项目代码中明确注释了这个坑：
```python
# 批量下载 要移动到/task/{task_id}之前 Fastapi按照注册顺序匹配
```

面试回答时可以说明：这和很多 Web 框架的行为一致（Express.js 也是）。原则是**具体路径在前，动态路径在后**。

---

### Q20: 你的项目为什么需要两个独立进程（API 进程和 Worker 进程）？

**答**：因为有两类根本不同的工作负载。

**API 进程（FastAPI + Uvicorn）**：
- I/O 密集型：处理 HTTP 请求、数据库查询、Redis 操作
- 需要低延迟：用户发请求，毫秒级响应
- async/await 完美匹配

**Worker 进程（Arq）**：
- CPU 密集型：YOLO 推理、知识库重建（embedding 计算）
- 耗时长：几秒到几分钟
- 不需要低延迟：用户可以等结果

如果 YOLO 推理放在 API 进程中：
1. CPU 密集计算会阻塞事件循环 → 所有其他请求卡住
2. 一次推理占几百 MB GPU 显存 → 并发推理可能 OOM
3. 推理超时 → HTTP 连接超时断开

分离后：
- API 进程只做 I/O → 始终保持响应能力
- Worker 进程独立运行 → 可以控制并发数（max_jobs=4）
- Worker 崩溃不影响 API → 任务重试即可
- 可以独立扩容 → 推理量大时加 Worker，不需要加 API 实例
