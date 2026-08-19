# Day 2：认证与鉴权 + 日志配置

> 目标：完成用户注册/登录/鉴权全链路，替换 print 为 logging
> 预计文件数：7 个新建 + 2 个修改

---

## 工具策略（精简版）

| 工具 | Day 2 | 后续 |
|---|---|---|
| ruff | ✅ 已有 | - |
| logging | ✅ 本日加 | 一个小文件 |
| mypy | ❌ 不加 | Day 3-4 写完模型后再引入 |
| pytest | ❌ 不加 | Day 3-4 有东西可测了再配 |

---

## Step 0：补一个日志配置（10 分钟）

**新建 `app/core/logging.py`**

要求：
- 定义 `setup_logging(level: str = "INFO")` 函数
- 格式：`%(asctime)s | %(levelname)-8s | %(name)s | %(message)s`
- 用 `logging.basicConfig` 即可，不需要复杂配置
- 在 `main.py` 的 lifespan 最开头调用

```python
# 骨架提示（先自己写，写不出来再看）：
import logging

def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
```

**改 `app/main.py`**：
- 顶部 `from app.core.logging import setup_logging`
- lifespan 第一行调 `setup_logging()`
- 把所有 `print(...)` 替换为 `logger.info(...)`
- 文件顶部加 `logger = logging.getLogger(__name__)`

**去问 ChatGPT 的问题**：
- `logging.getLogger(__name__)` 为什么用 `__name__`？
- `basicConfig` 只能调用一次，多次调用会怎样？

---

## Step 1：`app/models/user.py` — User 表模型

**要求**：
- 继承 `Base`（从 `app.core.database` 导入）
- 用 SQLAlchemy 2.0 风格：`Mapped` + `mapped_column`

**字段清单**：

| 字段 | 类型 | 约束 |
|---|---|---|
| id | int | 主键, index |
| username | str(50) | unique, index, NOT NULL |
| hashed_password | str(255) | NOT NULL |
| full_name | str(50) \| None | nullable |
| is_superuser | bool | default=False |
| created_at | datetime | server_default=func.now() |

**暂时不写 relationship**，等 Day 3 加 Task 模型时再补。

**你需要回答自己的问题**：
1. `Mapped[str]` vs `Mapped[str | None]` 区别？（前者 NOT NULL，后者 nullable）
2. `server_default=func.now()` vs `default=datetime.now` 区别？（前者数据库端生成，后者 Python 端）
3. 为什么用 `mapped_column` 而不是旧的 `Column()`？（2.0 风格，类型安全）

---

## Step 2：`app/schemas/auth.py` + `app/schemas/user.py`

### `app/schemas/auth.py`

```python
# Token: access_token(str) + token_type(str)
# TokenData: username(str | None)
```

### `app/schemas/user.py`

```python
# UserBase: username(str) + full_name(str | None)
# UserCreate(UserBase): password(str), ConfigDict(extra="forbid")
# UserPublic(UserBase): id(int) + is_superuser(bool) + created_at(datetime)
#   → 加 model_config = ConfigDict(from_attributes=True)
```

**你需要回答自己的问题**：
1. 为什么做输入输出分离？（UserCreate 含密码，UserPublic 不含 → 防泄露）
2. `from_attributes = True` 干什么？（让 Pydantic 直接从 ORM 对象读属性）
3. `extra = "forbid"` 防什么？（防客户端偷塞 `is_superuser: true` 提权）

---

## Step 3：`app/crud/user.py` — 用户 CRUD

**要求**：
```python
async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    # select(User).where(User.username == username)
    # result.scalars().first()

async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
    # 密码哈希: get_password_hash(user_in.password)
    # db.add → db.commit → db.refresh → return
```

**你需要回答自己的问题**：
1. commit 之后为什么还要 refresh？（数据库生成的 id、created_at 需要刷新到 Python 对象）
2. scalars().first() 和 scalars().one_or_none() 区别？（多条时 first 取第一条，one_or_none 抛异常）

---

## Step 4：`app/core/security.py` — 密码哈希 + JWT

**要求**：
```python
from pwdlib import PasswordHash
import jwt

password_hash = PasswordHash.recommended()

def verify_password(plain_password: str, hashed_password: str) -> bool: ...
def get_password_hash(password: str) -> str: ...
def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    # data.copy() → 加 exp → jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
```

**你需要回答自己的问题**：
1. `PasswordHash.recommended()` 底层用什么算法？（argon2）
2. JWT 里 `sub` 和 `exp` 分别是什么？（sub=主体标识, exp=过期时间）
3. 为什么 `data.copy()` 而不是直接改 data？（避免修改调用方的原始 dict）

---

## Step 5：`app/routers/auth.py` — 注册/登录/获取当前用户

**要求**：
- `oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")`
- `POST /auth/register` → 接收 UserCreate，返回 UserPublic
- `POST /auth/token` → 接收 OAuth2PasswordRequestForm，返回 Token
- `get_current_user()` → 依赖注入函数（不是路由），供其他路由 Depends

**关键点**：
- 注册时检查用户名是否已存在（400）
- 登录失败返回 401 + `WWW-Authenticate: Bearer` header
- `get_current_user` 里 catch `jwt.InvalidTokenError`，不要裸 `except`

**你需要回答自己的问题**：
1. 为什么登录用 `OAuth2PasswordRequestForm` 而不是 JSON？（OAuth2 规范要求 form-urlencoded）
2. `get_current_user` 的 Depends 链是什么？（oauth2_scheme 取 token → decode → 查 DB → 返回 User）
3. 为什么返回 401 要带 `WWW-Authenticate` header？（HTTP 规范要求，告知客户端认证方式）

---

## Step 6：`app/routers/users.py` — 用户管理

**要求**：
- `GET /users/me` → 返回当前用户（Depends get_current_user）
- `GET /users` → 管理员列出所有用户（检查 is_superuser，否则 403）
- `DELETE /users/{user_id}` → 管理员删用户（不能删自己，400）

---

## Step 7：挂载路由 + 迁移

### 改 `app/main.py`

```python
from app.routers import auth, users

app.include_router(auth.router, prefix="/api")
app.include_router(users.router, prefix="/api")
```

### 改 `alembic/env.py`

在顶部 import 区域加：
```python
from app.models.user import User  # noqa: F401
```

### 执行迁移

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 生成迁移文件
uv run alembic revision --autogenerate -m "add_users_table"

# 检查生成的文件（看 upgrade 里有没有 create_table）
# 执行迁移
uv run alembic upgrade head
```

---

## Step 8：手动验证（curl 测试）

```bash
# 启动
cd /Users/liuchenxu/Documents/Documents/code/rework/backend
uv run uvicorn app.main:app --reload --port 8000

# 1. 注册
curl -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username": "testuser", "password": "test123"}'

# 2. 登录（注意：form 格式，不是 JSON）
curl -X POST http://localhost:8000/api/auth/token \
  -d "username=testuser&password=test123"

# 3. 获取当前用户（替换 <TOKEN>）
curl http://localhost:8000/api/users/me \
  -H "Authorization: Bearer <TOKEN>"

# 4. 测试错误密码（应返回 401）
curl -X POST http://localhost:8000/api/auth/token \
  -d "username=testuser&password=wrongpass"

# 5. 测试无 token 访问（应返回 401）
curl http://localhost:8000/api/users/me
```

---

## Day 2 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化无差异
uv run ruff format --check app/

# 3. curl 五个测试全部符合预期（见 Step 8）

# 4. 代码里没有 print（全部换成 logger）
grep -rn "print(" app/ --include="*.py"
# 应该无输出
```

---

## 文件写作顺序（推荐）

```
1. app/core/logging.py           ← 新建（小文件，5分钟）
2. app/main.py                   ← 改（加 logging，去 print）
3. app/models/user.py            ← 新建
4. app/schemas/auth.py           ← 新建
5. app/schemas/user.py           ← 新建
6. app/crud/user.py              ← 新建
7. app/core/security.py          ← 新建
8. app/routers/auth.py           ← 新建
9. app/routers/users.py          ← 新建
10. app/main.py                  ← 改（挂路由）
11. alembic/env.py               ← 改（import User）
12. alembic 迁移 + upgrade       ← 命令行
13. curl 验证                    ← 命令行
```

---

# Logging 一页速查（Python / FastAPI）

## 1) 先记住：Logging 解决什么问题
- `print` 只能“看到输出”。
- `logging` 可以“分级别、可过滤、可定位来源、可记录异常堆栈”。
- 生产里必须用 `logging`，不用 `print` 做正式排障。

## 2) 最小可用代码（直接抄）
```python
import logging

def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

logger = logging.getLogger(__name__)
```

## 日常最常用语法（高频）
- logger.debug("调试细节")
- logger.info("正常流程")
- logger.warning("可恢复问题")
- logger.error("请求失败")
```python
try:
    ...
except Exception:
    logger.exception("数据库操作失败")  # 自动带 traceback
    raise
# 推荐：占位符写法（比 f-string 更适合日志）
logger.info("user_id=%s action=%s", user_id, action)
```
4) 级别怎么选（工作标准）
- DEBUG: 本地排错细节
- INFO: 正常业务流程（生产默认）
- WARNING: 可恢复异常
- ERROR: 功能失败
- CRITICAL: 系统级故障
5) 必会参数（只记这几个）
level=: 最低日志级别
format=: 日志格式
datefmt=: 时间格式
exc_info=True: 记录异常堆栈（或用 logger.exception）
handlers=: 输出到控制台/文件（进阶）
6) 常见坑 + 注意事项
坑1：setup_logging() 调用太晚，前面日志格式不统一
解决：应用启动最早阶段初始化日志。
坑2：日志重复打印（初始化多次）
解决：只初始化一次，避免重复 basicConfig。
坑3：泄露敏感信息（密码、Token）
解决：禁止打印 DB_PASSWORD、SECRET_KEY、Authorization。
坑4：异常只打文字不打堆栈
解决：异常路径统一 logger.exception(...)。

