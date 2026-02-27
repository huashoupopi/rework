# Day 6：RAG 服务核心（检索 + 重排 + 路由 + 流式生成）

> 目标：实现 RAG 核心管道——向量检索 + Reranker 重排 + 置信度路由 + 会话窗口 + 流式生成
> 这是整个项目**最核心、面试最高频**的模块
> 预计文件数：1 个新建 + 2 个修改
> 验证工具：Apifox

---

## 前置条件

Day 6 开始之前确保：
- PostgreSQL 已启用 pgvector 扩展（Day 1 迁移已做）
- Ollama 已安装且拉取了 `qwen3:14b`：`ollama pull qwen3:14b`
- 知识库已入库（可以先手动用 Day 7 的脚本入几条测试数据，或者先写 RAG 逻辑用 mock 数据测试）

---

## Step 1：`app/services/rag_service.py` — RAG 服务（核心中的核心）

这是整个项目最重要的文件。先理解架构，再动手写。

### 整体流程图（先画在纸上）

```
用户提问
  ↓
[1] 安全检测（评分 ≥ 3 → 拒答）
  ↓
[2] 会话窗口（取最近 N 轮对话做上下文）
  ↓
[3] Query 增强（拼接图片缺陷标签）
  ↓
[4] 向量检索（pgvector Hybrid Search, top_k=10）
  ↓
[5] 降级兜底（hybrid 返回 0 → 降级为纯向量检索）
  ↓
[6] Reranker 重排（BGE-Reranker, top_n=5）
  ↓
[7] 上下文安全检测（逐节点检查 injection）
  ↓
[8] 置信度路由（top_score ≥ 阈值 → RAG，否则 fallback）
  ↓
[9] Prompt 构建（system + context + history + question）
  ↓
[10] 流式生成（Ollama streaming）
  ↓
[11] Meta 块提取 + Think 块解析
  ↓
[12] 保存 assistant 消息（独立 Session）
```

### 代码骨架

```python
import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

class RagService:
    _initialized = False
    _init_lock = asyncio.Lock()

    # 各组件引用
    _embed_model = None
    _llm = None
    _vector_store = None
    _index = None
    _reranker = None

    @classmethod
    async def initialize(cls) -> None:
        """双重检查锁初始化（单例）"""
        if cls._initialized:
            return
        async with cls._init_lock:
            if cls._initialized:
                return
            logger.info("初始化 RAG 服务...")
            # 1. 加载 Embedding 模型
            # 2. 初始化 Ollama LLM
            # 3. 连接 PGVector Store
            # 4. 构建 VectorStoreIndex
            # 5. 加载 Reranker
            cls._initialized = True
            logger.info("RAG 服务初始化完成")

    @classmethod
    async def generate_chat_stream(
        cls,
        question: str,
        user_id: int,
        task_id: int | None = None,
        image_context: str | None = None,
    ):
        """RAG 主流程——流式生成"""
        # [1] 安全检测（Day 8 再接入，先跳过）
        # [2] 会话窗口
        # [3] Query 增强
        # [4] 向量检索
        # [5] 降级兜底
        # [6] Reranker 重排
        # [7] 上下文安全检测（Day 8）
        # [8] 置信度路由
        # [9] Prompt 构建
        # [10] 流式生成
        # [11] yield chunks
        pass
```

**你需要回答自己的问题**：

1. **双重检查锁（Double-Checked Locking）是什么？为什么需要两次 `if _initialized`？**
   - 第一次检查：快速路径——已初始化直接返回，不需要获取锁（性能优化）
   - `async with _init_lock`：保证只有一个协程进入初始化逻辑
   - 第二次检查：防止多个协程同时通过第一次检查后重复初始化
   - 没有第二次检查 → 两个协程同时到达 lock → A 获取锁初始化 → B 获取锁**再次初始化**
   - **面试必答**：这是并发编程的经典模式，Java 的 singleton 也用这个

2. **为什么 RAG 初始化放在 `initialize()` 而不是 `__init__`？**
   - 初始化涉及异步操作（连接 PGVector、下载模型），不能在 `__init__` 里 await
   - 用 classmethod + 异步方法，在 lifespan 里 `await RagService.initialize()` 调用
   - 类似 YOLO 的 `load_model()`，但 RAG 更复杂（多个组件）

---

## Step 2：向量检索 + Hybrid Search

### LlamaIndex 集成要点

```python
from llama_index.core import VectorStoreIndex, Settings
from llama_index.vector_stores.postgres import PGVectorStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding

# Embedding
embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")

# PGVector Store
vector_store = PGVectorStore.from_params(
    host=settings.DB_HOST,
    port=settings.DB_PORT,
    database=settings.DB_NAME,
    user=settings.DB_USER,
    password=settings.DB_PASSWORD,
    table_name=settings.DB_TABLE,
    embed_dim=1024,              # BGE-M3 输出维度
    hybrid_search=True,          # 开启混合检索
    text_search_config="simple", # 全文检索配置
)

# Index
index = VectorStoreIndex.from_vector_store(vector_store, embed_model=embed_model)

# Retriever
retriever = index.as_retriever(similarity_top_k=10, vector_store_query_mode="hybrid")
```

**你需要回答自己的问题**：

1. **Hybrid Search 是什么？解决什么问题？**
   - 纯向量检索：把 query 和文档都转成向量，算余弦相似度
   - 问题：语义相似但关键词不同时能检索到，但精确关键词匹配可能漏掉
   - Hybrid = 向量检索 + 全文关键词检索，两路结果融合
   - 例子：用户搜"Err_105"，纯向量可能匹配不到（没见过这个编号），但关键词检索能精确命中
   - **面试必答**："Hybrid Search 结合了语义理解和精确匹配的优势，解决纯向量检索漏掉关键词的问题。"

2. **`embed_dim=1024` 是什么？为什么是 1024？**
   - BGE-M3 模型输出的向量维度是 1024
   - pgvector 建表时需要指定 `VECTOR(1024)` 列，维度必须匹配
   - 不同 Embedding 模型维度不同（OpenAI 的 text-embedding-3-small 是 1536）
   - **追问**：维度越高越好吗？（不一定。高维度信息量更多但存储开销大、检索慢。1024 是性价比好的选择）

3. **`text_search_config="simple"` 是什么？**
   - PostgreSQL 全文检索的分词配置
   - `"simple"` = 按空格分词，不做词干提取（适合中文——中文不需要英语词干提取）
   - 如果纯英文场景用 `"english"` 更好（会把 running → run）
   - **追问**：中文分词 PostgreSQL 怎么处理？（需要安装 `zhparser` 扩展，或者在入库前用 jieba 预分词）

---

## Step 3：Reranker 重排

```python
from llama_index.postprocessor.flag_embedding_reranker import FlagEmbeddingReranker

reranker = FlagEmbeddingReranker(
    model="BAAI/bge-reranker-v2-m3",
    top_n=5,        # 重排后保留 top 5
    use_fp16=True,  # 半精度推理，速度更快
)

# 重排是 CPU 密集型，放到线程池
reranked_nodes = await asyncio.to_thread(
    reranker.postprocess_nodes, retrieved_nodes, query_bundle
)
```

**你需要回答自己的问题**：

1. **Retriever 已经排过序了，为什么还要 Reranker？**
   - Retriever 用的是 **Bi-Encoder**：query 和 document 各自编码，算余弦相似度——快但粗
   - Reranker 用的是 **Cross-Encoder**：把 query + document 拼在一起过模型——慢但准
   - 好比初筛 vs 精排：Retriever 从 10 万文档里挑 10 个，Reranker 在 10 个里精排出 5 个
   - **面试必答**："Bi-Encoder 效率高适合大规模初筛，Cross-Encoder 精度高适合小规模精排。两阶段检索是业界标准。"

2. **`use_fp16=True` 是什么？**
   - FP16 = 半精度浮点数（16 bit），比 FP32（32 bit）省一半内存，推理速度快 1.5-2 倍
   - 精度损失极小（对 Reranker 的排序结果几乎无影响）
   - **追问**：什么场景不能用 FP16？（训练阶段需要更高精度；某些模型的特定层对精度敏感）

3. **为什么用 `asyncio.to_thread` 执行 Reranker？**
   - Cross-Encoder 推理是 CPU 密集型（矩阵乘法），耗时 1-3 秒
   - 同步执行会阻塞事件循环，其他请求全部 hang 住
   - `to_thread` 把计算丢到线程池，和 YOLO 推理同理

---

## Step 4：置信度路由

```python
def _route_decision(nodes: list, image_context: str | None) -> str:
    """根据检索结果质量决定走 RAG 还是 fallback"""
    if not nodes:
        return "fallback"
    top_score = max(n.score for n in nodes)
    has_enough_context = len(nodes) >= settings.RAG_ROUTE_MIN_CONTEXT_NODES  # 默认 1
    score_ok = top_score >= settings.RAG_ROUTE_MIN_TOP_SCORE  # 默认 -2.0
    has_image = bool(image_context)

    if (has_enough_context and score_ok) or has_image:
        return "rag"
    return "fallback"
```

**你需要回答自己的问题**：

1. **为什么要置信度路由？不直接用检索结果拼 prompt？**
   - 检索结果质量差时，强行拼到 prompt 里会导致 LLM **幻觉**（基于错误上下文生成看似正确的废话）
   - 不如直接告诉用户"我不确定"或让 LLM 用自身知识回答
   - **面试金句**："低分强答等于幻觉。我们用置信度路由把不确定的查询路由到 fallback，宁可不答也不胡说。"

2. **`top_score >= -2.0` 这个阈值怎么来的？**
   - BGE-Reranker 输出的 score 范围大约是 `-10 ~ 0`，越高越相关
   - `-2.0` 是经验值——根据实际数据调试得出
   - 太高 → 很多相关查询被误判为 fallback（漏答）
   - 太低 → 不相关的内容也被当作 RAG 上下文（幻觉）
   - **追问**：怎么系统性地调这个阈值？（用评测集跑 Precision-Recall 曲线，找 F1 最大的点）

3. **`has_image` 为什么直接走 RAG？**
   - 如果用户的问题关联了检测任务（有图片上下文），说明是具体的缺陷分析问题
   - 即使检索分数不高，图片上下文也能帮助 LLM 生成有用的回答
   - 这是业务逻辑判断，不是纯技术决策

---

## Step 5：会话窗口 + Prompt 构建

```python
async def _build_prompt(
    question: str,
    context_nodes: list,
    chat_history: list[ChatMessage],
    route: str,
    image_context: str | None = None,
) -> list[dict]:
    """构建发送给 LLM 的 messages 列表"""
    messages = []

    # 1. System Prompt（根据 route 不同）
    if route == "rag":
        system = "你是风电叶片缺陷分析专家。请根据以下参考资料回答问题。如果资料不足以回答，请说明。"
    else:
        system = "你是风电叶片缺陷分析专家。请根据你的知识回答问题。"
    messages.append({"role": "system", "content": system})

    # 2. RAG 上下文（仅 rag 路由）
    if route == "rag" and context_nodes:
        context = "\n---\n".join(node.text for node in context_nodes)
        messages.append({"role": "user", "content": f"参考资料：\n{context}"})
        messages.append({"role": "assistant", "content": "我已阅读参考资料，请提问。"})

    # 3. 会话历史
    for msg in chat_history:
        messages.append({"role": msg.role, "content": msg.content})

    # 4. 当前问题
    messages.append({"role": "user", "content": question})

    return messages
```

**你需要回答自己的问题**：

1. **会话窗口为什么不把全部历史都塞进去？**
   - LLM 上下文窗口有限（qwen3:14b 约 4096-8192 tokens）
   - 太多历史 = token 成本高 + 可能引入噪声（早期对话和当前问题无关）
   - 用 `get_recent_chat_window(turns=4)` 只取最近 4 轮
   - **面试话术**："会话窗口是精度和成本的权衡。全量保留耗 token 且引入噪声，只取最近 N 轮覆盖 90% 的上下文需求。"

2. **RAG 上下文为什么用 `user + assistant` 的假对话注入？**
   - 把上下文放在 system prompt 里也可以，但有些模型对 system 的上下文利用率不如对话
   - 用 "用户提供资料 → 助手确认" 的格式更自然，LLM 更容易"记住"上下文
   - 这是 prompt engineering 技巧，不是唯一做法

---

## Step 6：更新 `app/routers/chat.py` — 接入 RAG

把 Day 5 的 Ollama 裸调替换为 RAG 管道：

```python
@router.post("/chat/stream")
async def chat_stream(req: ChatRequest, ...):
    # 1. 保存用户消息
    # 2. 获取会话窗口
    chat_history = await get_recent_chat_window(db, current_user.id, req.task_id, turns=4)
    # 3. 获取图片上下文（如果有 task_id）
    image_context = None
    if req.task_id:
        task = await db.get(Task, req.task_id)
        if task and task.detect_result:
            image_context = str(task.detect_result)
    # 4. 调用 RAG 流式生成
    async def event_generator():
        async for chunk in RagService.generate_chat_stream(
            question=req.question,
            user_id=current_user.id,
            task_id=req.task_id,
            image_context=image_context,
        ):
            yield chunk
    return StreamingResponse(event_generator(), media_type="text/event-stream")
```

---

## Step 7：更新 `app/main.py` — lifespan 加载 RAG

```python
await RagService.initialize()
```

---

## Day 6 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. Apifox 验证：
#    - POST /api/chat/stream 发送知识库相关问题 → 流式返回 RAG 结果
#    - 发送无关问题 → fallback 路由生效
#    - 查看日志确认：route=rag/fallback、top_score、context_nodes 数量
```

---

## 文件写作顺序

```
1. app/services/rag_service.py     ← 新建（核心）
2. app/routers/chat.py             ← 改（接入 RAG）
3. app/main.py                     ← 改（lifespan 加 RAG 初始化）
4. Apifox 验证
```

---

## 面试话术（90 秒 · 这是最重要的一段）

> 我的 RAG 管道分为检索、重排、路由、生成四个阶段。
> 检索用 pgvector 的 Hybrid Search，结合向量语义匹配和关键词精确匹配，解决纯向量检索漏掉精确关键词的问题。
> 检索出的 top-10 结果经过 BGE-Reranker Cross-Encoder 精排，保留 top-5。
> 然后走置信度路由：如果 Reranker 最高分 ≥ -2.0 且有效上下文节点 ≥ 1，走 RAG 路径；否则走 fallback 让模型用自身知识回答。
> 为什么要路由？因为低分强答等于幻觉——宁可不答也不胡说。
> 会话窗口只保留最近 4 轮对话，控制 token 预算、降低噪声。
> Reranker 是 CPU 密集型，用 asyncio.to_thread 放到线程池执行，不阻塞事件循环。
> 整个管道用异步信号量限制并发数为 2，防止 GPU/CPU 过载。
