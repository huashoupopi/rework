# Day 5：聊天模型 + CRUD + Think 流解析 + 流式聊天路由

> 目标：完成 ChatMessage 模型 + 聊天 CRUD（含 Cursor 分页）+ Think 流解析器 + 流式聊天路由（先裸调 Ollama，Day 6 再接 RAG）
> 预计文件数：6 个新建 + 4 个修改
> 验证工具：Apifox

---

## 前置准备

Day 5 开始之前确保：
- Ollama 已安装并运行：`ollama serve`
- 已拉取模型：`ollama pull qwen3:14b`（qwen3 系列默认输出 `<think>` 标签）
- 验证 Ollama 可用：`curl http://localhost:11434/api/tags`

---

## Step 1：`app/core/config.py` — 新增 LLM 相关配置

在 Settings 类中追加以下字段：

```python
# === LLM / Ollama 配置 ===
LLM_MODEL_NAME: str = "qwen3:14b"          # 注意：字段名是 LLM_MODEL_NAME（不是 PATH）
OLLAMA_BASE_URL: str = "http://localhost:11434"
OLLAMA_KEEP_ALIVE: str = "1h"
LLM_IS_VISION_MODEL: bool = False  # 视觉模型开关（如 qwen2.5-vl, qwen3.5-vl）

# === 上传目录（聊天图片临时存储）===
UPLOAD_DIR: str = "static/uploads"

# === 会话窗口配置 ===
RAG_SESSION_MEMORY_ENABLED: bool = True
RAG_SESSION_WINDOW_TURNS: int = 4
```

> ⚠️ 请确保在 `_build_derived_paths` 末尾追加目录创建逻辑：
> ```python
> Path(self.UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
> ```

**你需要回答自己的问题**：

1. **`OLLAMA_KEEP_ALIVE` 是做什么的？**
   - Ollama 默认在一段时间无请求后卸载模型（释放显存/内存）
   - `"1h"` 表示最后一次请求后保持加载 1 小时
   - 设为 `"-1"` 则永不卸载（开发阶段推荐，避免频繁冷启动）
   - **面试点**：模型加载到显存需要 5-30 秒，频繁加载/卸载严重影响 TTFT

2. **为什么不把 Ollama URL 硬编码在代码里？**
   - 开发环境 `localhost:11434`，Docker 部署可能是 `ollama:11434`
   - 配置外部化 = 不改代码就能切换环境
   - **12-Factor App 原则**：配置应存储在环境变量中，不应硬编码

3. **`LLM_IS_VISION_MODEL` 为什么要配置化？**
   - 视觉模型（如 qwen2.5-vl、qwen3.5-vl）能直接"看"图片，分析缺陷位置和形态
   - 非视觉模型只能接收文本，图片信息需要转成文字描述（YOLO 检测结果）拼到 prompt
   - 两种模型的调用方式完全不同（视觉模型需要传 base64 图片），用配置开关切换
   - **面试话术**："通过配置驱动模型能力分支，切换模型只改 `.env`，不改代码。"

---

## Step 2：`app/models/chat.py` — ChatMessage + ChatImage 表模型

**设计思路**：
- 纯文本 LLM 路径（bs 原设计）：通过 `task_id` 关联检测任务，把 YOLO 检测结果（文字）拼到 prompt
- 视觉 LLM 路径（rework 新增）：用户在聊天中上传一张或多张图片，转 base64 发给视觉模型
- 图片用独立的 `ChatImage` 表存储（一对多），而不是单个 `image` 列，支持多图

**完整代码**：

```python
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import ForeignKey, Index, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

if TYPE_CHECKING:
    from app.models.task import Task
    from app.models.user import User


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[int | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True, nullable=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    user: Mapped["User"] = relationship(back_populates="chats", lazy="selectin")
    task: Mapped["Task | None"] = relationship(back_populates="chats", lazy="selectin")
    images: Mapped[list["ChatImage"]] = relationship(
        back_populates="message", lazy="selectin", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("idx_chat_user_task", "user_id", "task_id"),)


class ChatImage(Base):
    """
    聊天图片表（一对多：一条 ChatMessage 可关联多张图片）。

    为什么独立建表而不是在 ChatMessage 上加 image 列？
    - 支持多图：视觉模型一次可分析多张缺陷图片（如同一叶片不同角度）
    - 关系清晰：每张图有独立的路径、原始文件名、尺寸等元数据
    - 易扩展：以后加缩略图、OCR 文本等字段只改这张表

    纯文本 LLM 不用这张表——它通过 task_id 关联 YOLO 检测结果（文字），不需要图片。
    """
    __tablename__ = "chat_images"

    id: Mapped[int] = mapped_column(primary_key=True, index=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("chat_messages.id", ondelete="CASCADE"), index=True
    )
    file_path: Mapped[str] = mapped_column(String(500), nullable=False)
    original_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    message: Mapped["ChatMessage"] = relationship(back_populates="images")
```

**两条 LLM 路径对比**：

| | 纯文本 LLM（bs 原设计） | 视觉 LLM（rework 新增） |
|---|---|---|
| 图片来源 | `task_id` → Task.detect_result（YOLO 文字） | 用户上传 → ChatImage 表 |
| 传给模型的内容 | 文字描述拼入 prompt | base64 图片 + prompt |
| ChatImage 表 | 不用 | 存图片路径 |
| 切换方式 | `.env` 设 `LLM_IS_VISION_MODEL=False` | `.env` 设 `LLM_IS_VISION_MODEL=True` |

**同步修改 User 和 Task 模型，补上反向关系**：

```python
# === app/models/user.py 补充 ===
# 在 TYPE_CHECKING 块中添加：
from app.models.chat import ChatMessage

# 在 User 类中添加：
chats: Mapped[list["ChatMessage"]] = relationship(
    back_populates="user", lazy="selectin", cascade="all, delete-orphan"
)


# === app/models/task.py 补充 ===
# 在 TYPE_CHECKING 块中添加：
from app.models.chat import ChatMessage

# 在 Task 类中添加：
chats: Mapped[list["ChatMessage"]] = relationship(
    back_populates="task", lazy="selectin", cascade="all, delete-orphan"
)
```

**你需要回答自己的问题**：

1. **为什么图片用独立的 `ChatImage` 表，而不是在 ChatMessage 上加 `image` 列？**
   - 支持多图：视觉模型一次可分析多张缺陷图片（如叶片不同角度、不同光照条件）
   - 前端 `FormData` 可以多次 `append("images", file)` 上传多张
   - 单列只能存一张，想存多张就得用逗号分隔或 JSON 数组——脏数据
   - **面试话术**："用独立关联表满足一对多关系，每张图有独立元数据，扩展性远好于在消息表上加 JSON 数组列。"

2. **纯文本 LLM 路径不用 ChatImage 表，那这个表不是浪费吗？**
   - 不浪费。纯文本路径下这张表就是空的，zero cost
   - 两条路径共存 = 同一套代码支持两种模型，切换只改 `.env`
   - **追问**：如果同时配了 task_id 和上传图片，视觉模型该用哪个？
     - 设计选择：优先用户直接上传的图片（用户意图更明确）

3. **为什么 `task_id` 是 nullable 的？**
   - 有些聊天不绑定具体检测任务（比如用户问通用知识问题）
   - nullable FK 允许 `task_id = NULL`，表示"不关联任何任务"
   - **追问**：nullable FK 在查询时需要注意什么？
     - JOIN 时要用 LEFT JOIN，否则会丢失 `task_id=NULL` 的记录
     - WHERE 筛选时 `task_id = NULL` 不行，必须用 `task_id IS NULL`（SQLAlchemy: `.is_(None)`）

4. **为什么用 `JSONB` 而不是 `JSON`？**
   - `JSONB` = Binary JSON，存储时解析为二进制格式
   - 优势：支持 GIN 索引、支持 `@>`/`?`/`?|` 等操作符查询、不保留空格和 key 顺序
   - `JSON` 存原始文本，每次查询都要重新解析
   - 你的 `meta` 字段会存 RAG 的 sources、timing、route、think 等结构化数据
   - **面试话术**："选 JSONB 是因为后续可能需要按 meta 内字段做查询（如统计 RAG/fallback 路由分布），JSONB 支持 GIN 索引，查询性能比 JSON 好一个数量级。"
   - **追问**：JSONB 比 JSON 有什么代价？（写入稍慢——需要解析成二进制；存储稍大——有额外索引开销。但查询快得多，绝大多数场景选 JSONB）

5. **复合索引 `(user_id, task_id)` 加速什么查询？**
   - 核心查询："获取用户 X 在任务 Y 下的聊天记录" → `WHERE user_id = ? AND task_id = ?`
   - 复合索引的列顺序有讲究：`(user_id, task_id)` 也能加速只按 `user_id` 查询（最左前缀原则）
   - 但如果只按 `task_id` 查就用不上这个索引
   - **面试高频**：复合索引的最左前缀原则是什么？
     - B-Tree 索引按声明顺序排列，`(A, B)` 相当于先按 A 排序，A 相同的再按 B 排序
     - 查 `WHERE A=?` → 能用（跳到 A 的位置）
     - 查 `WHERE A=? AND B=?` → 能用（先跳到 A，再在 A 范围内跳到 B）
     - 查 `WHERE B=?` → 不能用（B 不是排序的第一列，无法快速定位）
     - 类比电话簿：先按姓排序，再按名排序。你能按姓查，但不能直接按名查

6. **`__table_args__` 末尾的逗号 `(Index(...),)` 为什么必须有？**
   - Python 语法：单元素元组必须有尾逗号，否则 `(Index(...))` 只是括号表达式，不是元组
   - SQLAlchemy 要求 `__table_args__` 是元组或字典
   - 没有逗号 → SQLAlchemy 收到一个 `Index` 对象而不是元组 → 报错

7. **`ondelete="CASCADE"` 为什么同时写在两个外键上？**
   - 删用户 → 自动删该用户的所有聊天记录（`user_id` FK）
   - 删任务 → 自动删该任务的所有聊天记录（`task_id` FK）
   - 这是**数据库层面**的级联删除，和 ORM 层的 `cascade` 互为补充
   - **追问**：如果只有 ORM cascade 没有 DB ondelete，直接用 SQL 删用户会怎样？
     - 聊天记录外键指向已删除的用户 → 外键约束报错（PostgreSQL 默认 RESTRICT）
     - ORM cascade 只在 SQLAlchemy Session 中生效，裸 SQL 绕过了 ORM

8. **`Text` 类型 vs `String(N)` 的区别？**
   - `String(255)` = VARCHAR(255)，有长度限制，超过会报错
   - `Text` = TEXT，无长度限制
   - 聊天消息长度不可预测（LLM 可能生成很长的回答），用 `Text` 更合适
   - **面试点**：PostgreSQL 中 VARCHAR(N) 和 TEXT 性能相同，但 MySQL 中 TEXT 有不同的存储机制

9. **为什么用独立的 `ChatImage` 关联表而不是在 ChatMessage 上加 `image` 列？**
   - 核心原因：支持**多图**——视觉模型分析缺陷时，用户可能同时上传不同角度的照片
   - 单列方案（`image: str`）只能存一张图；想存多张就得用逗号分隔或 JSON 数组——查询不方便、无法加外键约束
   - 独立表每行一张图，有独立 `file_path`、`original_name`、`created_at` 元数据
   - `cascade="all, delete-orphan"` + `ondelete="CASCADE"` 保证删消息时自动清理图片记录
   - **追问**：为什么不用 JSONB 数组存图片路径？
     - JSONB 数组没有外键约束，无法用 SQL 直接 JOIN 查询
     - 独立表可以加索引（如按 `message_id` 查某条消息的所有图片）
     - 扩展性好：以后要加图片标签、缩略图路径，直接加列即可
   - **面试话术**："用独立关联表满足一对多关系，每张图有独立元数据和外键约束，比 JSONB 数组更规范、更易扩展。"

---

## Step 3：`app/schemas/chat.py` — 聊天相关 Schema

**完整代码**：

```python
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ChatRequest(BaseModel):
    """
    聊天请求体 — 仅用于文档说明。

    实际的流式聊天接口 POST /chat/stream 使用 Form + File 参数（不是 JSON body），
    因为需要支持可选的多图上传。
    详见 Step 6 router 的参数签名。

    前端用 FormData 发送：
      fd.append("question", "问题");
      fd.append("task_id", "123");         // 可选
      fd.append("images", file1);          // 可选，可多次 append
      fd.append("images", file2);
    """
    question: str
    task_id: int | None = None
    # images: 通过 list[UploadFile] 传入，不在 Pydantic 模型中


class ChatImageSchema(BaseModel):
    id: int
    file_path: str
    original_name: str | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatMessageSchema(BaseModel):
    id: int
    role: str
    content: str
    images: list[ChatImageSchema] = []
    meta: dict[str, Any] | None = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChatHistoryResponse(BaseModel):
    items: list[ChatMessageSchema]
    total: int
    has_more: bool
    oldest_id: int | None
    newest_id: int | None
```

**你需要回答自己的问题**：

1. **为什么流式聊天接口不用 `ChatRequest` Pydantic 模型？**
   - Pydantic 模型对应 JSON body（`Content-Type: application/json`）
   - 但我们需要支持多图上传（`list[UploadFile]`）
   - FastAPI 的文件上传必须用 `multipart/form-data`，不能和 JSON body 混用
   - 所以改为 `Form(...)` + `File(default=[])` 参数，不走 Pydantic 模型
   - **面试点**："HTTP 协议限制：JSON body 和文件上传不能在同一个请求中混用。FastAPI 用 Form + File 处理 multipart/form-data。"
   - **追问**：能不能用 base64 把图片塞在 JSON 里？
     - 技术上可以，但 base64 膨胀 33%，500KB 图片变 667KB
     - 更重要的是：JSON body 有大小限制（Nginx 默认 1MB），多张图片容易超限
     - multipart/form-data 是文件上传的标准方式，支持 chunked transfer

2. **`ChatHistoryResponse` 为什么不用 `skip/limit` 而用 `oldest_id/newest_id`？**
   - 这是 **Cursor 分页**（游标分页），比 Offset 分页更适合聊天场景
   - Offset 分页的问题：用户在翻页过程中有新消息插入，offset 会错位
   - Cursor 分页用 `WHERE id < oldest_id` 锚定位置，不受新数据影响
   - **面试高频对比**：
     | | Offset | Cursor |
     |---|---|---|
     | 实现 | `OFFSET N LIMIT M` | `WHERE id < last_id LIMIT M` |
     | 跳页 | 支持 | 不支持（只能上下翻） |
     | 新数据插入 | 错位 | 不受影响 |
     | 大数据量 | 慢（扫描跳过的行） | 快（索引直达） |
     | 适用 | 后台管理 | 聊天/Feed 流 |

3. **为什么 `ChatRequest` 这么简单？不需要 `model`、`temperature` 等参数？**
   - 这些是服务端统一配置的，不应该让前端控制
   - 把 LLM 参数暴露给前端 = 安全风险（用户可以设 temperature=2 让模型胡说）

---

## Step 4：`app/crud/chat.py` — 聊天 CRUD

**完整代码**：

```python
from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.chat import ChatImage, ChatMessage


async def create_message(
    db: AsyncSession,
    user_id: int,
    role: str,
    content: str,
    task_id: int | None = None,
    image_paths: list[tuple[str, str | None]] | None = None,
    meta: dict[str, Any] | None = None,
) -> ChatMessage:
    """
    创建聊天消息。

    Args:
        image_paths: 图片列表，每项为 (file_path, original_name)。
                     纯文本 LLM 不传此参数；视觉 LLM 传上传后的文件路径。
    """
    msg = ChatMessage(
        user_id=user_id,
        task_id=task_id,
        role=role,
        content=content,
        meta=meta,
    )
    db.add(msg)
    await db.flush()  # 先 flush 拿到 msg.id，再创建 ChatImage

    if image_paths:
        for file_path, original_name in image_paths:
            img = ChatImage(
                message_id=msg.id,
                file_path=file_path,
                original_name=original_name,
            )
            db.add(img)

    await db.commit()
    await db.refresh(msg)
    return msg


async def get_chat_history(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    limit: int = 50,
    order: str = "asc",
    before: int | None = None,
    after: int | None = None,
) -> Sequence[ChatMessage]:
    """
    获取聊天历史，支持 Cursor 分页。

    分页使用:
    - 初始加载: GET /chat/history?limit=50
    - 加载更旧: GET /chat/history?before={oldest_id}&limit=50
    - 轮询新消息: GET /chat/history?after={newest_id}&limit=50
    """
    order_col = (
        ChatMessage.id.desc()
        if order == "desc"
        else ChatMessage.id.asc()
    )
    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(order_col)
        .limit(limit)
    )

    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)

    if before is not None:
        stmt = stmt.where(ChatMessage.id < before)
    if after is not None:
        stmt = stmt.where(ChatMessage.id > after)

    result = await db.execute(stmt)
    return result.scalars().all()


async def get_recent_chat_window(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    turns: int = 4,
    before_message_id: int | None = None,
) -> list[ChatMessage]:
    """
    获取最近 N 轮会话窗口（按时间正序返回）。
    1 轮 = 1 user + 1 assistant = 2 条消息。
    before_message_id: 排除当前刚写入的 user 消息，避免窗口包含当前问题本身。
    """
    message_limit = max(1, turns) * 2

    stmt = (
        select(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(message_limit)
    )

    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)

    if before_message_id is not None:
        stmt = stmt.where(ChatMessage.id < before_message_id)

    result = await db.execute(stmt)
    messages = list(result.scalars().all())
    messages.reverse()
    return messages


async def count_chat_messages(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
) -> int:
    stmt = select(func.count(ChatMessage.id)).where(
        ChatMessage.user_id == user_id
    )
    if task_id is None:
        stmt = stmt.where(ChatMessage.task_id.is_(None))
    else:
        stmt = stmt.where(ChatMessage.task_id == task_id)
    result = await db.execute(stmt)
    return result.scalar() or 0
```

**你需要回答自己的问题**：

1. **Cursor 分页的 SQL 长什么样？**
   ```sql
   -- Cursor 分页：获取 id < 50 的最新 20 条
   SELECT * FROM chat_messages
   WHERE user_id = 1 AND id < 50
   ORDER BY created_at ASC LIMIT 20;

   -- 对比 Offset：获取第 3 页（跳过前 40 条）
   SELECT * FROM chat_messages
   WHERE user_id = 1
   ORDER BY created_at ASC OFFSET 40 LIMIT 20;
   ```
   - Offset 要扫描并丢弃前 40 行（OFFSET 越大越慢）
   - Cursor 用索引直接跳到 `id=50` 处，和数据量无关

2. **`task_id IS NULL` 为什么不能写 `task_id = NULL`？**
   - SQL 标准：`NULL` 不等于任何值，包括它自己
   - `WHERE task_id = NULL` 永远返回空结果
   - 必须用 `IS NULL`，SQLAlchemy 写法：`ChatMessage.task_id.is_(None)`
   - **面试陷阱**：`WHERE task_id != 1` 不会返回 `task_id = NULL` 的行

3. **`get_recent_chat_window` 为什么先倒序查再 reverse？**
   - 倒序 `ORDER BY DESC LIMIT 8` → 取"最新的 8 条"
   - 如果正序 `ORDER BY ASC LIMIT 8` → 取的是"最旧的 8 条"（不是我们要的）
   - 查出来后 `reverse()` → 恢复正序，直接拼进 LLM prompt

4. **`before_message_id` 参数的作用？**
   - 流程：存 user 消息 → 查窗口 → 调 LLM → 存 assistant 消息
   - 查窗口时，当前的 user 消息已经在数据库了
   - 如果不排除，窗口会包含当前问题，LLM 看到重复的问题
   - `WHERE id < before_message_id` 精确排除

---

## Step 5：`app/utils/stream_parser.py` — Think 流解析器（重点）

这是 Day 5 新增的核心组件。qwen3 等模型在回答前会输出思考过程：

```
<think>
让我分析一下风电叶片裂纹的修复方法...
裂纹分为表面裂纹和结构性裂纹两种...
</think>
根据分析，风电叶片裂纹的修复方法主要有以下几种...
```

**流式场景的核心挑战**：标签可能被拆分到多个 token 中：
```
token1: "内容<thi"    ← <think> 被截断了
token2: "nk>思考"     ← 标签的后半部分
```

如果不处理，前端会收到残缺的 HTML 标签，无法正确分离思考和正文。

### 前后端传输协议

我们用**协议标记**（不是 HTML 标签）来分隔 think 和正文：

```
<<<THINK_START>>>          ← think 开始
让我分析一下...             ← think 内容，逐 token 流式发送
<<<THINK_END>>>            ← think 结束
根据分析，修复方法有...      ← 正文内容，逐 token 流式发送
```

前端收到流后，按这两个标记分割，分别渲染到"思考过程"和"回答"两个区域。

### 完整代码

```python
"""
Think 流解析器 — 处理 LLM 流式输出中的 <think>...</think> 标签。

核心挑战：
  流式输出是逐 token 的，标签可能跨越多个 token。
  例如 "<think>" 可能被拆成 "<thi" + "nk>"。

解决方案：
  维护一个缓冲区（buffer），每次收到新 token 时追加到缓冲区，
  然后扫描缓冲区中的完整标签。如果缓冲区末尾可能是标签的前缀，
  就保留在缓冲区中等待下一个 token，不提前输出（避免输出残缺标签）。

设计原则：
  - 纯函数式：不依赖任何外部状态，所有状态封装在实例中
  - 零拷贝友好：输入 token 追加到 buffer，输出时切片
  - 可测试：feed() 和 flush() 都是确定性函数

使用方式：
  parser = ThinkStreamParser()
  for token in llm_stream:
      output = parser.feed(token)
      if output:
          yield output   # 发送给客户端
  remaining = parser.flush()
  if remaining:
      yield remaining
"""


class ThinkStreamParser:
    """
    将 LLM 原始流中的 <think>...</think> 替换为传输协议标记。

    输入:  "<think>我来分析一下...</think>答案是..."
    输出:  "<<<THINK_START>>>我来分析一下...<<<THINK_END>>>答案是..."

    支持：
    - 标签跨 token 拆分（核心难点）
    - 多个 think 块（虽然大多数模型只输出一个）
    - think 块内容为空
    - 流结束时 think 未闭合（自动补 THINK_END）
    """

    THINK_OPEN = "<think>"       # LLM 输出的原始标签
    THINK_CLOSE = "</think>"
    MARKER_START = "<<<THINK_START>>>"   # 发送给前端的协议标记
    MARKER_END = "<<<THINK_END>>>"

    def __init__(self) -> None:
        self._in_think: bool = False     # 当前是否在 think 块内
        self._buffer: str = ""           # 跨 token 缓冲区
        self._think_content: str = ""    # 累积的 think 原文（用于存库）

    @property
    def think_content(self) -> str:
        """获取累积的完整 think 内容（流结束后读取，存到 meta.think）"""
        return self._think_content.strip()

    def feed(self, token: str) -> str:
        """
        喂入一个 token，返回应发送给客户端的内容。

        工作原理：
        1. 将 token 追加到 buffer
        2. 循环扫描 buffer 中的完整标签
        3. 找到标签 → 替换为协议标记，切掉已处理的部分
        4. 没找到标签但 buffer 尾部可能是标签前缀 → 保留尾部，输出安全部分
        5. 返回本次应输出的内容
        """
        self._buffer += token
        output = ""

        while self._buffer:
            if self._in_think:
                # === 在 think 块内：寻找 </think> ===
                end_pos = self._buffer.find(self.THINK_CLOSE)
                if end_pos != -1:
                    # 找到闭合标签：输出 think 内容 + 结束标记
                    think_chunk = self._buffer[:end_pos]
                    output += think_chunk
                    output += self.MARKER_END
                    self._think_content += think_chunk
                    self._buffer = self._buffer[end_pos + len(self.THINK_CLOSE):]
                    self._in_think = False
                else:
                    # 未找到闭合标签
                    # 关键：buffer 尾部可能是 "</think>" 的前缀（如 "</thi"）
                    # 保留最后 (标签长度-1) 个字符，避免误输出残缺标签
                    safe_len = len(self._buffer) - (len(self.THINK_CLOSE) - 1)
                    if safe_len > 0:
                        think_chunk = self._buffer[:safe_len]
                        output += think_chunk
                        self._think_content += think_chunk
                        self._buffer = self._buffer[safe_len:]
                    break  # 等待更多 token

            else:
                # === 在正文中：寻找 <think> ===
                start_pos = self._buffer.find(self.THINK_OPEN)
                if start_pos != -1:
                    # 找到开始标签：输出标签前的正文 + 开始标记
                    output += self._buffer[:start_pos]
                    output += self.MARKER_START
                    self._buffer = self._buffer[start_pos + len(self.THINK_OPEN):]
                    self._in_think = True
                else:
                    # 未找到开始标签
                    # 保留尾部可能是 "<think>" 前缀的部分
                    safe_len = len(self._buffer) - (len(self.THINK_OPEN) - 1)
                    if safe_len > 0:
                        output += self._buffer[:safe_len]
                        self._buffer = self._buffer[safe_len:]
                    break  # 等待更多 token

        return output

    def flush(self) -> str:
        """
        流结束时调用：输出 buffer 中剩余的内容。

        如果 think 块未闭合（LLM 异常截断），自动补上 MARKER_END。
        """
        remaining = self._buffer
        self._buffer = ""

        if self._in_think:
            # think 未闭合：累积剩余内容 + 自动补结束标记
            self._think_content += remaining
            remaining += self.MARKER_END
            self._in_think = False

        return remaining
```

### 单元测试思路（不需要写代码，但你要理解）

```python
# 正常 case
parser = ThinkStreamParser()
assert parser.feed("<think>分析中</think>答案") == "<<<THINK_START>>>分析中<<<THINK_END>>>答案"

# 跨 token case（核心）
parser = ThinkStreamParser()
out1 = parser.feed("内容<thi")     # buffer 保留 "<thi"，输出 "内容"
out2 = parser.feed("nk>思考")      # 拼成 "<think>思考"，输出标记+思考
out3 = parser.feed("</think>正文") # 闭合，输出标记+正文
assert out1 + out2 + out3 == "内容<<<THINK_START>>>思考<<<THINK_END>>>正文"

# 未闭合 case
parser = ThinkStreamParser()
parser.feed("<think>思考中...")
remaining = parser.flush()         # 自动补 MARKER_END
assert "<<<THINK_END>>>" in remaining
```

**你需要回答自己的问题**：

1. **为什么不在 `<think>` 出现时就立即输出 `<<<THINK_START>>>`，而要用 buffer？**
   - 因为你收到 `"<thi"` 时不知道这是 `<think>` 的前缀还是普通文本 `"<thinking about..."` 的一部分
   - 必须等到收集够字符才能判断是否是完整标签
   - 这就是 buffer 的意义：**延迟决策，等信息足够再行动**

2. **`safe_len = len(buffer) - (len(tag) - 1)` 的数学含义？**
   - `<think>` 长度是 7，所以保留尾部 6 个字符
   - 为什么是 `标签长度 - 1`？因为最坏情况下标签被拆成 "最后1个字符在下一个token"
   - 例如 buffer 是 `"正文内容<think"`，保留尾部 6 个字符 `"<think"`
   - 如果下个 token 是 `">"`，拼起来就是 `"<think>"`，完整标签
   - 如果下个 token 是 `"ing"`，拼起来是 `"<thinking"`，不是标签，正常输出

3. **为什么 `flush()` 要自动补 `MARKER_END`？**
   - LLM 可能因为超时/取消而中途停止，`</think>` 没来得及输出
   - 前端如果收到 `MARKER_START` 但没收到 `MARKER_END`，不知道 think 到底结束了没有
   - 自动补上 → 前端的解析逻辑永远是成对的，不需要处理"未闭合"的特殊情况

4. **`think_content` 属性的用途？**
   - 流结束后，think 的完整内容需要存到数据库（`meta.think` 字段）
   - 前端可以在消息详情中展示完整的思考过程
   - 不累积的话，流结束后 think 内容就丢失了

5. **为什么用字符串标记 `<<<THINK_START>>>` 而不是 JSON 结构？**
   - 最简单的方案。前端 `split("<<<THINK_START>>>")` 就能分离
   - 如果用 JSON 结构（如 `{"type": "think", "content": "..."}`），每个 token 都要序列化/反序列化，开销大
   - 如果用标准 SSE（`event: think\ndata: ...\n\n`），需要 `text/event-stream` 媒体类型，前端要用不同的解析逻辑
   - 字符串标记是最轻量的方案，适合你当前的 `text/plain` 流式协议
   - **面试追问**：有什么缺点？（标记字符串不能出现在 LLM 输出中，否则会误判。但 `<<<THINK_START>>>` 这种格式在自然语言中几乎不会出现，风险极低）

6. **这个解析器和原项目的区别？**
   - 原项目把 think 解析**混在 router 层**（40+ 行状态机直接写在 `event_generator` 里）
   - 重写后**抽成独立类**，职责单一、可测试、可复用
   - 原项目用 `carry` 变量名，可读性差；新代码用 `_buffer` + 详细注释

---

## Step 6：`app/routers/chat.py` — 聊天路由（流式 + Think + 历史）

### 流式聊天的执行时序

```
客户端发起 POST /api/chat/stream
  |
[1] 校验问题非空
  |
[2] 存 user 消息到数据库（用请求 Session）
  |
[3] 获取会话窗口（最近 N 轮历史）
  |
[4] 获取图片上下文（如果有 task_id）
  |
[5] 返回 StreamingResponse    <-- HTTP 响应开始
  |
=== 以下在生成器内执行（请求 Session 已关闭）===
  |
[6] 构建 messages 发送给 Ollama
  |
[7] httpx.stream 调用 Ollama /api/chat
  |
[8] 每个 token 经过 ThinkStreamParser → yield 给客户端
  |
[9] 流结束，用独立 Session 存 assistant 消息（正文 + think 存 meta）
```

### 完整代码

```python
import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

import httpx

from app.core.config import settings
from app.core.database import AsyncSessionLocal, get_db
from app.crud import chat as chat_crud
from app.models.task import Task
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.chat import ChatHistoryResponse, ChatMessageSchema
from app.utils.stream_parser import ThinkStreamParser

logger = logging.getLogger(__name__)

router = APIRouter(tags=["AI 助手 (Chat)"])

# 允许的图片格式
_ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
_MAX_IMAGE_SIZE_MB = 10
_USER_IMAGE_QUOTA = 100  # 每个用户最多保留 100 张聊天图片


# ==================== 流式聊天 ====================


@router.post("/chat/stream")
async def chat_stream(
    request: Request,
    question: str = Form(..., description="用户问题"),
    task_id: int | None = Form(None, description="关联任务 ID"),
    images: list[UploadFile] = File(default=[], description="可选：上传一张或多张图片（视觉模型用）"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """
    流式聊天接口。

    使用 multipart/form-data 而不是 JSON body，因为需要支持可选的图片上传。
    前端用 FormData 发送：
      const fd = new FormData();
      fd.append("question", "你的问题");
      fd.append("task_id", "123");         // 可选
      fd.append("images", file1);          // 可选，可多次 append 上传多张
      fd.append("images", file2);

    两条 LLM 路径：
      - 纯文本 LLM：忽略上传图片，通过 task_id 拿 YOLO 检测结果文字拼入 prompt
      - 视觉 LLM：将上传图片转 base64 发送给模型
    """

    if not question.strip():
        raise HTTPException(status_code=400, detail="问题不能为空")

    # === [0] 处理上传的图片（可多张） - 按用户分目录存储 ===
    uploaded_image_paths: list[tuple[str, str | None]] = []  # [(相对路径, 原始文件名), ...]
    if images:
        # 用户专属目录：static/uploads/chat/{user_id}/
        user_chat_dir = Path(settings.UPLOAD_DIR) / "chat" / str(current_user.id)
        user_chat_dir.mkdir(parents=True, exist_ok=True)

        for img_file in images:
            if not img_file.filename:
                continue
            if img_file.content_type not in _ALLOWED_IMAGE_TYPES:
                raise HTTPException(400, f"文件 {img_file.filename} 格式不支持，仅支持 JPG、PNG、WebP")

            # 生成唯一文件名：时间戳 + UUID
            suffix = Path(img_file.filename).suffix or ".jpg"
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            unique_name = f"{timestamp}_{uuid.uuid4().hex[:8]}{suffix}"
            file_path = user_chat_dir / unique_name

            # 读取并保存
            content = await img_file.read()
            if len(content) > _MAX_IMAGE_SIZE_MB * 1024 * 1024:
                raise HTTPException(400, f"图片 {img_file.filename} 超过 {_MAX_IMAGE_SIZE_MB}MB 限制")

            file_path.write_bytes(content)

            # 存储相对路径（相对于 static/）
            relative_path = f"uploads/chat/{current_user.id}/{unique_name}"
            uploaded_image_paths.append((relative_path, img_file.filename))

            logger.info(
                "用户上传聊天图片 user_id=%d path=%s size_kb=%d",
                current_user.id,
                relative_path,
                len(content) // 1024,
            )

    # [1] 存 user 消息 + 关联图片（用请求 Session，此时 Session 还活着）
    user_message = await chat_crud.create_message(
        db,
        user_id=current_user.id,
        role="user",
        content=question,
        task_id=task_id,
        image_paths=uploaded_image_paths if uploaded_image_paths else None,
    )

    # [2] 清理超出配额的旧图片
    if uploaded_image_paths:
        await _enforce_user_image_quota(db, current_user.id)

    # [3] 获取会话窗口
    session_messages: list[dict[str, str]] = []
    if settings.RAG_SESSION_MEMORY_ENABLED:
        history = await chat_crud.get_recent_chat_window(
            db,
            user_id=current_user.id,
            task_id=task_id,
            turns=settings.RAG_SESSION_WINDOW_TURNS,
            before_message_id=user_message.id,
        )
        for msg in history:
            if msg.role in ("user", "assistant") and msg.content.strip():
                session_messages.append({"role": msg.role, "content": msg.content})

    # [4] 获取图片上下文
    # === 纯文本 LLM 路径：通过 task_id 获取 YOLO 检测结果文字 ===
    image_context: dict | None = None
    if task_id:
        task = await db.get(Task, task_id)
        if task and task.detect_result:
            image_context = task.detect_result

    # [5] 准备视觉模型图片路径（转换为绝对路径）
    # === 视觉 LLM 路径：收集要发给模型的图片路径列表 ===
    vision_image_paths: list[str] = []
    if settings.LLM_IS_VISION_MODEL:
        if uploaded_image_paths:
            # 用户上传的图片（转回绝对路径给视觉模型）
            static_dir = Path(settings.BASE_DIR).parent / "static"
            vision_image_paths = [str(static_dir / rel_path) for rel_path, _ in uploaded_image_paths]
        elif task_id and task:
            # 引用任务图片
            if task.original_path:
                task_img_path = Path(settings.BASE_DIR).parent / "static" / task.original_path
                if task_img_path.exists():
                    vision_image_paths = [str(task_img_path)]

    if vision_image_paths:
        logger.info("视觉模型将使用 %d 张图片", len(vision_image_paths))

    # [4] 构建 messages（Day 5: 简单拼接；Day 6: 替换为 RAG 调用）
    messages = _build_messages(
        question=question,
        session_messages=session_messages,
        image_context=image_context,
    )

    # [5] 流式生成器
    async def event_generator():
        parser = ThinkStreamParser()
        all_yielded: list[str] = []  # 收集所有 yield 给客户端的内容

        async with AsyncSessionLocal() as bg_session:
            try:
                async with httpx.AsyncClient() as client:
                    async with client.stream(
                        "POST",
                        f"{settings.OLLAMA_BASE_URL}/api/chat",
                        json={
                            "model": settings.LLM_MODEL_NAME,
                            "messages": messages,
                            "stream": True,
                        },
                        timeout=90.0,
                    ) as resp:
                        async for line in resp.aiter_lines():
                            if await request.is_disconnected():
                                logger.info("客户端断开连接，停止生成")
                                break

                            if not line:
                                continue

                            data = json.loads(line)
                            raw_token = data.get("message", {}).get("content", "")

                            if raw_token:
                                parsed = parser.feed(raw_token)
                                if parsed:
                                    all_yielded.append(parsed)
                                    yield parsed

                            if data.get("done"):
                                break

                            await asyncio.sleep(0)

                    # 流结束：flush 缓冲区中剩余内容
                    remaining = parser.flush()
                    if remaining:
                        all_yielded.append(remaining)
                        yield remaining

                # === 流结束后：从完整输出中提取纯正文 ===
                # all_yielded 拼起来类似：
                #   "<<<THINK_START>>>思考内容<<<THINK_END>>>正文内容"
                # 用正则去掉 THINK_START 到 THINK_END 之间的所有内容（含标记本身）
                full_output = "".join(all_yielded)
                content_only = re.sub(
                    rf"{re.escape(ThinkStreamParser.MARKER_START)}"
                    rf".*?"
                    rf"{re.escape(ThinkStreamParser.MARKER_END)}",
                    "",
                    full_output,
                    flags=re.DOTALL,
                ).strip()

                if not content_only:
                    content_only = "系统繁忙，未生成回答。"
                    yield content_only

                # 构建 meta（think 内容由 parser 累积）
                meta: dict | None = None
                if parser.think_content:
                    meta = {"think": parser.think_content}

                # 存 assistant 消息：content 是纯正文，think 存 meta
                await chat_crud.create_message(
                    bg_session,
                    user_id=current_user.id,
                    role="assistant",
                    content=content_only,
                    task_id=task_id,
                    meta=meta,
                )

            except asyncio.CancelledError:
                logger.info("流式生成被取消")
                raise
            except Exception:
                logger.exception("流式生成失败")
                yield "\n[系统错误，请重试]"

    return StreamingResponse(
        event_generator(),
        media_type="text/plain",
        headers={
            "X-Accel-Buffering": "no",   # Nginx: 禁用反向代理缓冲
            "Cache-Control": "no-cache",  # 禁止浏览器/CDN 缓存
            "Connection": "keep-alive",   # 保持长连接
        },
    )


def _build_messages(
    question: str,
    session_messages: list[dict[str, str]],
    image_context: dict | None = None,
) -> list[dict[str, str]]:
    """构建发送给 Ollama 的 messages 列表"""
    messages: list[dict[str, str]] = []

    system_content = (
        "你是一个专业的风电叶片缺陷分析助手。"
        "请根据用户的问题给出准确、专业的回答。"
    )

    if image_context and isinstance(image_context, dict):
        total = image_context.get("total", 0)
        objects = image_context.get("objects", []) or []
        defect_lines = [
            f"- {obj.get('class', 'unknown')} "
            f"(置信度: {obj.get('confidence', 'N/A')})"
            for obj in objects
        ]
        defect_str = "\n".join(defect_lines) or "- 无"
        system_content += (
            f"\n\n当前图像检测结果（共 {total} 个缺陷）:\n{defect_str}\n"
            "当用户询问「这张图」或「这个缺陷」时，请结合以上检测结果回答。"
        )

    messages.append({"role": "system", "content": system_content})

    for msg in session_messages:
        messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": question})
    return messages


# ==================== 聊天历史 ====================


@router.get("/chat/history", response_model=ChatHistoryResponse)
async def get_history(
    task_id: int | None = Query(None),
    limit: int = Query(default=50, ge=1, le=200),
    order: str = Query(default="asc", pattern="^(asc|desc)$"),
    before: int | None = Query(None, description="获取 id < before 的消息"),
    after: int | None = Query(None, description="获取 id > after 的消息"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChatHistoryResponse:
    history = await chat_crud.get_chat_history(
        db, current_user.id, task_id,
        limit=limit, order=order, before=before, after=after,
    )
    total = await chat_crud.count_chat_messages(db, current_user.id, task_id)

    items = [ChatMessageSchema.model_validate(msg) for msg in history]

    oldest_id = items[0].id if items else None
    newest_id = items[-1].id if items else None
    has_more = len(items) == limit

    return ChatHistoryResponse(
        items=items,
        total=total,
        has_more=has_more,
        oldest_id=oldest_id,
        newest_id=newest_id,
    )


async def _enforce_user_image_quota(db: AsyncSession, user_id: int) -> None:
    """
    清理超出配额的旧聊天图片。

    每个用户最多保留 _USER_IMAGE_QUOTA 张聊天图片，超出部分删除最旧的。
    """
    from sqlalchemy import select
    from app.models.chat import ChatImage, ChatMessage

    # 查询该用户的所有聊天图片，按创建时间倒序
    stmt = (
        select(ChatImage)
        .join(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(ChatImage.created_at.desc())
    )
    result = await db.execute(stmt)
    all_images = list(result.scalars().all())

    if len(all_images) > _USER_IMAGE_QUOTA:
        to_delete = all_images[_USER_IMAGE_QUOTA:]  # 超出配额的旧图片
        static_dir = Path(settings.BASE_DIR).parent / "static"

        for img in to_delete:
            # 删除文件
            file_path = static_dir / img.file_path
            try:
                file_path.unlink(missing_ok=True)
                logger.info("删除旧聊天图片 user_id=%d path=%s", user_id, img.file_path)
            except Exception as e:
                logger.warning("删除图片文件失败 path=%s error=%s", img.file_path, e)

            # 删除数据库记录
            await db.delete(img)

        await db.commit()
        logger.info("清理用户 %d 的 %d 张旧聊天图片", user_id, len(to_delete))
```

**你需要回答自己的问题**：

1. **为什么用 `StreamingResponse` + `text/plain` 而不是标准 SSE？**
   - 标准 SSE（`text/event-stream`）需要 `data: ...\n\n` 格式
   - 浏览器原生 `EventSource` API 不支持 POST 请求（只能 GET）
   - 你的聊天是 POST（带 JSON body），所以前端用 `fetch` + `ReadableStream`
   - `text/plain` 更简单，不需要额外的格式化开销
   - **面试**：不要说自己用的是 SSE，说「纯文本流式响应」

2. **响应头 `X-Accel-Buffering: no` 的重要性？**
   - Nginx 默认**缓冲**后端响应——等后端全部输出完再一次性转发
   - 这会杀死流式效果（用户等到流结束才看到所有内容一起出现）
   - `X-Accel-Buffering: no` 告诉 Nginx 立即转发每个 chunk
   - **部署必加**，否则生产环境流式效果消失

3. **为什么流结束后用独立 Session 保存？**
   - `StreamingResponse` 返回后，FastAPI 清理依赖注入的资源
   - 请求的 `db` Session 在 `get_db()` 的 `finally` 中关闭
   - 生成器还在执行时，请求 Session 已死
   - **时间线**：
     ```
     请求到达 → get_db() 打开 Session
       → 路由：存 user 消息、构建参数
       → return StreamingResponse ← HTTP 响应头发送
       → get_db() 关闭 Session ← Session 死了
       → 生成器开始执行
       → ...逐 token yield...
       → 流结束，用 bg_session 存消息
     ```
   - **面试话术**："StreamingResponse 的生成器和请求 Session 的生命周期不重叠。这和 BackgroundTasks 是同一类问题：Session 生命周期 != 业务执行时机。"

4. **`asyncio.sleep(0)` 为什么要加？**
   - 如果 Ollama 响应极快，事件循环被密集的 yield 占满
   - 其他协程（如另一个请求）"饿死"
   - `await asyncio.sleep(0)` 显式让出事件循环
   - 这是**协作式多任务**的基本礼仪

5. **为什么正文存数据库时要去掉 think 内容？**
   - `content` 字段存的是用户实际看到的回答（正文）
   - think 内容存在 `meta.think` 字段
   - 查聊天历史时，`content` 直接展示，`meta.think` 可选展开
   - 如果 think 混在 content 里，前端每次渲染都要重新解析，增加复杂度

6. **httpx vs requests vs aiohttp？**
   - `requests`：同步库，在 async 中会阻塞事件循环，**绝对不能用**
   - `aiohttp`：异步 HTTP 客户端，API 稍复杂
   - `httpx`：同步+异步双模式，API 类似 requests，FastAPI 生态标配
   - `httpx.AsyncClient().stream()`：流式读取响应，不把整个响应加载到内存

7. **Ollama `/api/chat` 的流式响应格式？**
   ```json
   {"model":"qwen3:14b","message":{"role":"assistant","content":"<think>"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":"分析"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":"中"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":"</think>"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":"答案"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":"是"},"done":false}
   {"model":"qwen3:14b","message":{"role":"assistant","content":""},"done":true}
   ```
   - NDJSON 格式（每行一个 JSON）
   - 注意 `<think>` 和 `</think>` 通常各自独占一个 token，但**不保证**

8. **为什么聊天接口用 `Form` + `File` 而不是 JSON body？**
   - JSON body（`Content-Type: application/json`）不支持文件上传
   - 需要可选图片上传 → 必须用 `multipart/form-data`
   - FastAPI 中：JSON body 用 `payload: ChatRequest`，multipart 用 `Form(...)` + `File(default=[])`
   - **前端适配**：发送 `FormData` 而不是 `JSON.stringify`
   - **面试点**："HTTP 协议约束：一个请求只能有一种 body 编码方式。需要文件上传就必须用 multipart。"

9. **图片存储设计：为什么数据库存相对路径，视觉模型用绝对路径？**
   - **数据库存相对路径**（`uploads/chat/1/20260310_143022_a3f8b2c1.jpg`）
     - 优点：数据可移植（static 目录位置变化时无需修改数据库）
     - 优点：路径更短，节省存储空间
     - 前端访问：`http://api.com/static/uploads/chat/1/xxx.jpg`
   - **视觉模型用绝对路径**
     - 必要性：`Path(p).read_bytes()` 需要绝对路径
     - 转换时机：router 层（第 [5] 步），在调用 service 层之前完成
     - 转换逻辑：`static_dir / rel_path` → `/path/to/static/uploads/chat/1/xxx.jpg`
   - **面试话术**："这是分层设计的体现。数据库层存相对路径保证可移植性，service 层需要绝对路径读取文件。转换在 router 层完成，遵循'router 负责 HTTP 协议和路径转换，service 负责纯业务逻辑'的原则。"

10. **图片清理策略：为什么按用户配额而不是按时间？**
   - **按用户配额**（每用户 100 张）
     - 优点：公平——每个用户占用相同资源
     - 优点：可预测——总图片数 = 用户数 × 100
     - 实现：上传新图片后自动删除最旧的
   - **按时间清理**（如 30 天前）
     - 缺点：活跃用户可能占用大量空间
     - 缺点：不活跃用户的图片被浪费保留
   - **面试话术**："按用户配额是资源公平分配的体现。类似 GitHub 的仓库配额、邮箱的存储配额。时间清理适合日志类数据，但聊天图片是用户资产，应该按用户隔离管理。"

11. **图片来源的优先级设计？**
   ```
   优先级 1: 用户在聊天中直接上传的图片（uploaded_image_paths，可多张）
     → 场景：用户拖入图片问"这几张图有什么问题？"
   优先级 2: task_id 关联任务的原始图片（仅一张）
     → 场景：用户在检测详情页聊天，图片来自之前上传的检测任务
   优先级 3: 无图片
     → 场景：纯文本知识问答，如"风电叶片裂纹怎么修复？"
   ```
   - 两种图片来源互不冲突：直接上传优先，没上传才用任务图片
   - **和原项目的区别**：原项目只有优先级 2（只能通过 task_id 间接获取图片）。
     新设计增加了直接上传，让用户不必先创建检测任务就能用视觉模型分析图片
   - **面试话术**："支持两种图片输入方式：绑定任务的间接引用和聊天中直接上传（支持多张）。优先级明确，两条路径在 router 层合并为统一的 vision_image_paths 列表传给 service。"

12. **上传的聊天图片怎么管理？**
    - **存储位置**：按用户分目录 `static/uploads/chat/{user_id}/`
    - **文件命名**：时间戳 + UUID（如 `20260310_143022_a3f8b2c1.jpg`）
    - **数据库路径**：存相对路径 `uploads/chat/1/xxx.jpg`（相对于 static/）
    - **清理策略**：每用户最多保留 100 张，上传新图片时自动删除最旧的
    - **前端访问**：`http://api.com/static/uploads/chat/1/xxx.jpg`
    - **面试话术**："按用户配额管理聊天图片，数据库存相对路径保证可移植性，视觉模型使用时转为绝对路径。清理策略在上传时触发，保证资源公平分配。"

13. **`vision_image_paths` 是怎么传递到 LLM 的？**
    - Day 5 暂时不用 `vision_image_paths`（裸调 Ollama 非视觉模型）
    - Day 6 接入 RAG 后，`vision_image_paths` 传给 `RagService.generate_chat_stream`
    - 视觉模型开关 `LLM_IS_VISION_MODEL=True` 时，service 层会：
      1. 读取每张图片文件 → base64 编码
      2. 调用 Ollama `/api/chat` 时在 user message 中附带 `images: [base64_str, ...]`
      3. 模型直接"看到"所有图片，能对比分析不同角度的缺陷
    - 非视觉模型只能看到 YOLO 检测结果的文字描述（如 "corrosion, 置信度: 0.95"）
    - **面试话术**："配置驱动两条推理路径：非视觉模型用 YOLO 检测结果的文字注入 prompt；视觉模型通过 ChatImage 表获取图片路径列表，转 base64 发给模型。"

---

## Step 7：挂载路由 + 代理配置 + Alembic 迁移

### 改 `app/main.py` — 挂载 chat 路由 + 禁用代理

```python
import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

# === 禁用代理，避免本地服务（Ollama）请求被拦截 ===
# 必须在 import FastAPI 和其他库之前设置，确保全局生效
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.database import engine, init_models
from app.core.logging import setup_logging
from app.routers import auth, chat, task, user  # 新增 chat
from app.services.yolo_service import YOLOService

# ... 其他代码保持不变 ...

# 挂载 chat 路由
app.include_router(chat.router, prefix="/api")
```

**你需要回答自己的问题**：

1. **为什么要禁用代理？**
   - 开发环境可能配置了系统代理（如 Clash、V2Ray）
   - `httpx.AsyncClient()` 默认读取 `HTTP_PROXY` 环境变量
   - 请求 `http://localhost:11434` 时被代理拦截 → 502 Bad Gateway
   - 禁用代理后，本地请求直连 Ollama

2. **为什么在 main.py 而不是 chat.py 中设置？**
   - Day 6 的 `rag_service.py` 也需要调用 Ollama
   - 在 main.py 统一设置 → 全局生效，避免重复代码
   - 必须在 `import FastAPI` 之前设置，确保所有模块都生效

3. **生产环境需要改吗？**
   - 生产环境通常不配置代理，或者 Nginx 反向代理已处理
   - 如果生产环境有代理，在 `.env` 中设置 `NO_PROXY=localhost,127.0.0.1`
   - 当前代码兼容两种环境

### 改 `alembic/env.py`

```python
from app.models.chat import ChatMessage, ChatImage  # noqa: F401
```

### 安装依赖

```bash
uv add httpx
```

### 创建目录和文件

```bash
mkdir -p app/utils
touch app/utils/__init__.py
# 然后创建 app/utils/stream_parser.py
```

### 执行迁移

```bash
uv run alembic revision --autogenerate -m "add_chat_messages_table"
# 检查迁移文件！确认有：
# - create_table('chat_messages', ...) + create_table('chat_images', ...)
# - chat_messages 两个外键（user_id, task_id）+ 复合索引 idx_chat_user_task
# - chat_images 外键（message_id）
uv run alembic upgrade head
```

---

## Day 5 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化
uv run ruff format --check app/

# 3. Apifox 验证（确保 Ollama 运行中）：

# a) 流式聊天（观察 think 标记）
#    POST /api/chat/stream {"question": "风电叶片常见缺陷有哪些？"}
#    预期输出（原始流）：
#    <<<THINK_START>>>让我整理一下风电叶片的常见缺陷类型...<<<THINK_END>>>风电叶片常见缺陷主要有...

# b) 多轮对话（会话窗口生效）
#    POST /api/chat/stream {"question": "继续说说裂纹"}
#    预期：基于上一轮对话上下文回答

# c) 聊天历史
#    GET /api/chat/history?limit=10
#    预期：返回刚才的聊天记录
#    检查 assistant 消息的 meta 字段：应该包含 {"think": "..."}

# d) 数据库验证
#    chat_messages 表有 user + assistant 成对的消息
#    assistant 消息的 content 是纯正文（不含 <think> 标签）
#    assistant 消息的 meta 字段有 think 内容
```

---

## 文件写作顺序

```
1.  app/core/config.py              <- 改（加 LLM 配置）
2.  app/models/chat.py              <- 新建
3.  app/models/user.py              <- 改（补 chats relationship）
4.  app/models/task.py              <- 改（补 chats relationship）
5.  app/schemas/chat.py             <- 新建
6.  app/crud/chat.py                <- 新建
7.  app/utils/__init__.py           <- 新建（空文件）
8.  app/utils/stream_parser.py      <- 新建（Think 解析器）
9.  app/routers/chat.py             <- 新建（核心）
10. app/main.py                     <- 改（挂 chat 路由）
11. alembic/env.py                  <- 改（import ChatMessage, ChatImage）
12. uv add httpx                    <- 安装依赖
13. alembic 迁移 + upgrade
```

---

## 面试话术（90 秒）

> 聊天模块实现了流式文本输出，用 `StreamingResponse` + `httpx` 流式调用 Ollama，逐 token 推送给前端。
> 接口用 multipart/form-data（Form + File）而不是 JSON body，支持可选的图片直传给视觉模型。
> 图片来源有两个优先级：用户直接上传（支持多张） > 任务关联图片，在 router 层统一合并为 vision_image_paths 列表。
> 核心指标是 TTFT（Time to First Token）——流式输出让用户在 200ms 内看到第一个字。
>
> 因为 qwen3 模型会输出 `<think>` 标签包裹思考过程，我写了一个 `ThinkStreamParser` 来实时解析流中的标签，
> 将 `<think>` 替换为协议标记 `<<<THINK_START>>>`，前端据此分离展示思考过程和正文。
> 核心难点是标签可能被拆分到多个 token 中，解析器用缓冲区机制处理跨 token 的标签检测。
>
> 流结束后，正文存到 `content` 字段，思考过程存到 `meta.think`（JSONB），前端可选展开。
>
> 聊天历史用 Cursor 分页，`WHERE id < last_id` 锚定位置，不受新消息插入影响。
> 流式生成器中的数据库保存用独立 Session，因为生成器的执行时机和请求 Session 生命周期不匹配。
