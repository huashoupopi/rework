# Day 5：聊天模型 + CRUD + 聊天路由（流式 SSE）

> 目标：完成 ChatMessage 模型 + 聊天 CRUD（含 Cursor 分页）+ 流式聊天路由（先对接 Ollama 裸调，Day 6 再接 RAG）
> 预计文件数：5 个新建 + 3 个修改
> 验证工具：Apifox

---

## Step 1：`app/models/chat.py` — ChatMessage 表模型

**要求**：
- 继承 `Base`
- 与 User 和 Task 都有关系（Task 可选——通用聊天不绑定任务）

**字段清单**：

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| id | int | 主键, index | 自增 |
| user_id | int | ForeignKey("users.id", ondelete="CASCADE") | 消息所属用户 |
| task_id | int \| None | ForeignKey("tasks.id", ondelete="CASCADE"), nullable | 关联任务（可选） |
| role | str(20) | NOT NULL | "user" 或 "assistant" |
| content | Text | NOT NULL | 消息内容 |
| meta | JSONB \| None | nullable | RAG 元数据（sources/timing/route 等） |
| created_at | datetime | server_default=func.now() | 创建时间 |

**关键设计**：

```python
from sqlalchemy.dialects.postgresql import JSONB

# 复合索引：加速"某用户在某任务下的聊天记录"查询
__table_args__ = (Index("idx_chat_user_task", "user_id", "task_id"),)
```

**relationship**（双向）：
```python
# chat.py 侧
user: Mapped["User"] = relationship(back_populates="chats", lazy="selectin")
task: Mapped["Task | None"] = relationship(back_populates="chats", lazy="selectin")

# user.py 侧补充
chats: Mapped[list["ChatMessage"]] = relationship(
    back_populates="user", lazy="selectin", cascade="all, delete-orphan"
)

# task.py 侧补充
chats: Mapped[list["ChatMessage"]] = relationship(
    back_populates="task", lazy="selectin", cascade="all, delete-orphan"
)
```

**你需要回答自己的问题**：

1. **为什么 `task_id` 是 nullable 的？**
   - 有些聊天不绑定具体检测任务（比如用户问通用知识问题）
   - nullable FK 允许 `task_id = NULL`，表示"不关联任何任务"
   - **追问**：nullable FK 在查询时需要注意什么？（JOIN 时要用 LEFT JOIN，否则会丢失 task_id=NULL 的记录）

2. **为什么用 `JSONB` 而不是 `JSON`？**
   - `JSONB` = Binary JSON，存储时解析为二进制格式
   - 优势：支持 GIN 索引、支持 `@>` 等操作符查询、不保留空格和 key 顺序
   - `JSON` 存原始文本，每次查询都要重新解析
   - 你的 `meta` 字段会存 RAG 的 sources、timing 等结构化数据，后面可能需要按 route 类型查询
   - **面试话术**："选 JSONB 是因为后续可能需要按 meta 内字段做查询（如统计 RAG/fallback 路由分布），JSONB 支持 GIN 索引，查询性能比 JSON 好一个数量级。"

3. **复合索引 `(user_id, task_id)` 加速什么查询？**
   - 核心查询："获取用户 X 在任务 Y 下的聊天记录" → `WHERE user_id = ? AND task_id = ?`
   - 复合索引的列顺序有讲究：`(user_id, task_id)` 也能加速只按 `user_id` 查询（最左前缀原则）
   - 但如果只按 `task_id` 查就用不上这个索引
   - **面试高频**：复合索引的最左前缀原则是什么？为什么 `(A, B)` 能加速 `WHERE A=?` 但不能加速 `WHERE B=?`？

4. **`ondelete="CASCADE"` 为什么同时写在两个外键上？**
   - 删用户 → 自动删该用户的所有聊天记录（`user_id` FK）
   - 删任务 → 自动删该任务的所有聊天记录（`task_id` FK）
   - 这是**数据库层面**的级联删除，和 ORM 层的 `cascade` 互为补充
   - **追问**：如果只有 ORM cascade 没有 DB ondelete，直接用 SQL 删用户会怎样？（聊天记录变成孤儿数据，外键约束报错或悬空）

---

## Step 2：`app/schemas/chat.py` — 聊天相关 Schema

**要求**：

```python
class ChatRequest(BaseModel):
    question: str
    task_id: int | None = None  # 可选，关联任务上下文

class ChatMessageSchema(BaseModel):
    id: int
    role: str
    content: str
    meta: dict[str, Any] | None = None
    created_at: datetime
    model_config = ConfigDict(from_attributes=True)

class ChatHistoryResponse(BaseModel):
    items: list[ChatMessageSchema]
    total: int
    has_more: bool           # 是否有更早的消息
    oldest_id: int | None    # 最旧消息 ID（用于"加载更多"）
    newest_id: int | None    # 最新消息 ID（用于轮询新消息）
```

**你需要回答自己的问题**：

1. **`ChatHistoryResponse` 为什么不用 `skip/limit` 而用 `oldest_id/newest_id`？**
   - 这是 **Cursor 分页**（游标分页），比 Offset 分页更适合聊天场景
   - Offset 分页的问题：如果用户在翻页过程中有新消息插入，offset 会错位（重复或遗漏消息）
   - Cursor 分页用 `WHERE id < oldest_id` 锚定位置，不受新数据影响
   - **面试高频**：Offset 分页 vs Cursor 分页的优缺点？（Offset 简单但大数据慢且有错位；Cursor 稳定且快但不能跳页）

2. **`has_more` 怎么判断？**
   - 查询时多查一条：`LIMIT = requested_limit + 1`
   - 如果返回 `limit + 1` 条 → `has_more = True`，只返回前 `limit` 条
   - 如果返回 ≤ `limit` 条 → `has_more = False`，已经到底了

---

## Step 3：`app/crud/chat.py` — 聊天 CRUD

**要求**：

```python
async def create_message(
    db: AsyncSession,
    user_id: int,
    role: str,
    content: str,
    task_id: int | None = None,
    meta: dict | None = None,
) -> ChatMessage:
    # 创建消息对象 → db.add → db.commit → db.refresh → return

async def get_chat_history(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    before: int | None = None,    # Cursor: 获取 id < before 的消息
    after: int | None = None,     # Cursor: 获取 id > after 的消息
    limit: int = 20,
    order: str = "desc",          # desc = 最新在前, asc = 最旧在前
) -> Sequence[ChatMessage]:
    # 1. base_query = select(ChatMessage).where(user_id == ?)
    # 2. 可选: .where(task_id == ?)
    # 3. Cursor: if before → .where(id < before)
    # 4. Cursor: if after → .where(id > after)
    # 5. .order_by(desc/asc).limit(limit)

async def get_recent_chat_window(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
    turns: int = 4,
) -> list[ChatMessage]:
    # 获取最近 N 轮对话（每轮 = 1 user + 1 assistant = 2 条消息）
    # 用于 RAG 会话窗口上下文
    # limit = turns * 2, order by created_at desc, 然后 reverse

async def count_chat_messages(
    db: AsyncSession,
    user_id: int,
    task_id: int | None = None,
) -> int:
    # select(func.count(ChatMessage.id)).where(...)
```

**你需要回答自己的问题**：

1. **Cursor 分页的 SQL 长什么样？**
   ```sql
   -- 获取 id < 50 的最新 20 条消息
   SELECT * FROM chat_messages
   WHERE user_id = 1 AND id < 50
   ORDER BY id DESC
   LIMIT 20;
   ```
   - 对比 Offset 分页：`SELECT * ... OFFSET 40 LIMIT 20`
   - Offset 要扫描并丢弃前 40 行；Cursor 用索引直接跳到 id=50 处，**O(1) 起始**

2. **`get_recent_chat_window` 为什么要 reverse？**
   - 数据库查的是 `ORDER BY created_at DESC LIMIT 8`（最新 8 条倒序）
   - 但传给 LLM 做上下文时需要**正序**（从旧到新），所以要 reverse
   - **面试点**：这就是 RAG 会话窗口的实现——取最近 N 轮对话拼到 prompt 里

3. **为什么 `count_chat_messages` 要单独写而不用 `len(history)`？**
   - `len(history)` 只是当前页的数量，不是总数
   - `func.count()` 让数据库算总数，不加载所有数据到内存
   - 总数用于前端显示"共 X 条消息"

---

## Step 4：`app/routers/chat.py` — 聊天路由（流式 SSE）

**要求**：

```python
# POST /chat/stream — 流式聊天（SSE）
# GET  /chat/history — 获取聊天历史（Cursor 分页）
```

**流式聊天接口核心逻辑**（Day 5 先用 Ollama 裸调，Day 6 接 RAG）：

```python
from fastapi.responses import StreamingResponse
import httpx

@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # 1. 保存用户消息到数据库
    await create_message(db, current_user.id, "user", req.question, req.task_id)

    # 2. 构建 prompt（Day 5 先简单拼，Day 6 加 RAG 上下文）
    messages = [
        {"role": "system", "content": "你是一个专业的风电叶片缺陷分析助手。"},
        {"role": "user", "content": req.question},
    ]

    # 3. 流式调用 Ollama
    async def event_generator():
        full_response = ""
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{settings.OLLAMA_BASE_URL}/api/chat",
                json={"model": settings.LLM_MODEL_PATH, "messages": messages, "stream": True},
                timeout=90.0,
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    data = json.loads(line)
                    chunk = data.get("message", {}).get("content", "")
                    if chunk:
                        full_response += chunk
                        yield chunk

        # 4. 流结束后保存 assistant 消息
        async with AsyncSessionLocal() as save_db:
            await create_message(save_db, current_user.id, "assistant", full_response, req.task_id)

    return StreamingResponse(event_generator(), media_type="text/plain")
```

**你需要回答自己的问题**：

1. **为什么用 `StreamingResponse` 而不是普通 JSON 返回？**
   - LLM 生成是逐 token 的，可能要 10-60 秒才生成完
   - 如果等生成完再一次性返回，用户要等很久才能看到第一个字
   - 流式返回让用户**看到每个 token 实时出现**，体验好很多（像 ChatGPT 一样）
   - **面试话术**："流式输出的核心是降低首 token 延迟（Time to First Token, TTFT），从可能的 10 秒降低到 200ms。"

2. **`media_type="text/plain"` 还是 `"text/event-stream"`？**
   - `text/event-stream` 是标准 SSE 协议，需要 `data: xxx\n\n` 格式
   - `text/plain` 更简单，直接流式传输纯文本
   - 你的原项目用 `text/event-stream`，但如果前端用 `fetch` + `ReadableStream` 读取，`text/plain` 也能工作
   - 看你前端怎么处理——如果用 `EventSource` API 就必须用 SSE 格式

3. **流结束后为什么用独立 Session 保存 assistant 消息？**
   - 和 BackgroundTasks 的理由类似：`StreamingResponse` 的生成器在响应开始后才执行
   - 但这里更微妙——请求的 `db` Session 在 `get_db()` 依赖注入结束时关闭
   - 而生成器可能在 Session 关闭后还在执行（流还在传输中）
   - 所以保存操作需要独立 Session
   - **面试高频**：这和后台任务独立 Session 是同一类问题——**Session 生命周期和业务执行时机不匹配**

4. **如果客户端中途断开连接怎么办？**
   - `StreamingResponse` 的生成器会收到一个异常（`GeneratorExit` 或底层连接错误）
   - 应该在 `event_generator` 里 try/except 处理，确保断开时能清理资源
   - 已生成的部分内容可以选择保存或丢弃（取决于业务需求）
   - **追问**：怎么检测客户端断开？（在每次 yield 后检查 `await request.is_disconnected()`，或者依赖 ASGI 服务器的连接关闭通知）

5. **Ollama API 的 `/api/chat` 接口是什么格式？**
   - 请求：`{"model": "qwen3:14b", "messages": [...], "stream": true}`
   - 响应（stream=true 时）：每行一个 JSON，`{"message": {"content": "xxx"}, "done": false}`
   - 最后一行：`{"done": true, "total_duration": ..., "eval_count": ...}`
   - **面试点**：Ollama 兼容 OpenAI API 格式，切换到 OpenAI/Claude 只需改 base_url 和 model 名

---

## Step 5：挂载路由 + Alembic 迁移

### 改 `app/main.py`

```python
from app.routers import auth, user, tasks, chat  # 新增 chat

app.include_router(chat.router, prefix="/api")
```

### 改 `alembic/env.py`

```python
from app.models.chat import ChatMessage  # noqa: F401
```

### 执行迁移

```bash
uv run alembic revision --autogenerate -m "add_chat_messages_table"
# 检查迁移文件！确认有 create_table + 复合索引
uv run alembic upgrade head
```

---

## Day 5 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化无差异
uv run ruff format --check app/

# 3. Apifox 验证：
#    - POST /api/chat/stream 发送问题 → 流式返回文字
#    - GET /api/chat/history 返回聊天记录
#    - 数据库 chat_messages 表有数据
```

---

## 文件写作顺序

```
1. app/models/chat.py              ← 新建
2. app/models/user.py              ← 改（补 chats relationship）
3. app/models/task.py              ← 改（补 chats relationship）
4. app/schemas/chat.py             ← 新建
5. app/crud/chat.py                ← 新建
6. app/routers/chat.py             ← 新建
7. app/main.py                     ← 改（挂 chat 路由）
8. alembic/env.py                  ← 改（import ChatMessage）
9. alembic 迁移 + upgrade
```

---

## 面试话术（90 秒）

> 聊天模块实现了流式 SSE 输出，用 `StreamingResponse` + `httpx.stream` 逐 token 推送给前端。
> 核心指标是 TTFT（Time to First Token）——流式输出让用户在 200ms 内看到第一个字，而不是等 10 秒。
> 聊天历史用 Cursor 分页而不是 Offset 分页，因为聊天场景有频繁的新消息插入，Offset 会导致翻页错位。
> Cursor 分页用 `WHERE id < last_id` 锚定位置，不受新数据影响，且利用主键索引 O(1) 起始。
> ChatMessage 表有复合索引 `(user_id, task_id)`，加速"某用户在某任务下的聊天记录"这个核心查询。
> 流结束后的消息保存用独立 Session，因为 StreamingResponse 的生成器执行时机和请求 Session 生命周期不匹配。
