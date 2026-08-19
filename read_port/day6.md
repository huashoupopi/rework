# Day 6：RAG 服务核心（检索 + 重排 + 路由 + 流式生成）

> 目标：实现 RAG 核心管道——向量检索 + Reranker 重排 + 置信度路由 + 流式生成，并接入 Day 5 的 chat 路由
> 这是整个项目**最核心、面试最高频**的模块
> 预计文件数：1 个新建 + 3 个修改
> 验证工具：Apifox

---

## 前置准备

Day 6 开始之前确保：
- Day 5 全部通过（chat/stream 能裸调 Ollama 流式输出，Think 解析正常）
- PostgreSQL 已启用 pgvector 扩展（Day 1 迁移已做）
- Ollama 运行中且 qwen3:14b 已加载

### 安装 Day 6 依赖

```bash
uv add llama-index-core llama-index-vector-stores-postgres \
       llama-index-embeddings-huggingface llama-index-llms-ollama \
       llama-index-postprocessor-flag-embedding-reranker
# torch 只用于 reranker 推理，CPU 版足够（M1 也能用）
```

---

## 整体流程图（先画在纸上再写代码）

```
用户提问
  |
[1] 会话窗口（最近 N 轮，由 router 层传入）
  |
[2] Query 增强（拼接图片缺陷标签，提高检索命中率）
  |
[3] 向量检索（pgvector Hybrid Search, top_k=10）
  |
[4] 降级兜底（hybrid 返回 0 -> 降级为纯向量检索）
  |
[5] Reranker 重排（BGE-Reranker Cross-Encoder, top_n=5）
  |
[6] 置信度路由（top_score >= 阈值 -> RAG，否则 fallback）
  |
[7] Prompt 构建（system + context + history + question）
  |
[8] 流式生成（LlamaIndex Ollama astream_complete）
  |
[9] yield raw tokens -> router 层的 ThinkStreamParser 处理
  |
[10] 流末尾 yield <<<SOURCES>>>json<<<SOURCES_END>>> 给前端展示参考文献
     + result_meta 传递 sources 给 router 存入数据库
```

> 安全检测（Prompt Injection）放在 Day 8，Day 6 先跳过。
> Think 解析在 router 层完成（Day 5 的 ThinkStreamParser），service 层只管 yield 原始 token。

### 架构分层原则

```
router 层（chat.py）          service 层（rag_service.py）
---------------------         --------------------------
参数校验                       向量检索
认证鉴权                       Reranker 重排
存 user 消息                   置信度路由
获取会话窗口                    Prompt 构建
获取图片上下文                  LLM 流式生成
ThinkStreamParser              yield raw tokens
存 assistant 消息
```

**为什么这样分？**
- router 负责 HTTP 协议（认证、参数、响应格式）和 DB 读写
- service 负责纯业务逻辑（AI 推理），不依赖 HTTP 或 DB
- Think 解析是**展示层关注点**（前端怎么显示），放 router 层
- 换成 WebSocket 或 CLI 调用时，service 层零改动

---

## Step 1：`app/core/config.py` — 新增 RAG 配置

在 Day 5 配置基础上追加：

```python
# === RAG 核心配置 ===
MODELS_DIR: str = str(Path(__file__).resolve().parent.parent.parent / "models")
HF_HOME: str = ""
HUGGINGFACE_HUB_CACHE: str = ""

# RAG 向量表名（pgvector 存储用，需要在 .env 中配置，如 DB_TABLE=wind_knowledge）
# 注意：此字段在 Day 1 的 config.py 中可能已存在（DB_TABLE: str = ""），
# 如果没有请手动添加。
DB_TABLE: str = ""

# RAG 并发与超时
RAG_MAX_CONCURRENCY: int = 2
RAG_OLLAMA_REQUEST_TIMEOUT_S: float = 60.0
RAG_STREAM_TOTAL_TIMEOUT_S: float = 90.0

# RAG 置信度路由
RAG_ROUTE_MIN_CONTEXT_NODES: int = 1
RAG_ROUTE_MIN_TOP_SCORE: float = -2.0
```

> ⚠️ 请确保 `.env` 文件中配置了以下内容：
> - `DB_TABLE=wind_knowledge`（或你选择的表名），否则 pgvector 不知道往哪张表存/读向量数据
> - `HF_HOME=/path/to/backend/models/hf_cache`（模型缓存路径，必须明确设置）
> - `HUGGINGFACE_HUB_CACHE=/path/to/backend/models/hf_cache`（与 HF_HOME 相同）
>
> **为什么必须在 `.env` 中设置 `HF_HOME`？**
> - `HuggingFaceEmbedding` 在导入时就会读取环境变量
> - 如果 `.env` 中不设置，`settings.HF_HOME` 是空字符串 `""`
> - 虽然 `_build_derived_paths` 会设置默认值，但此时 `rag_service.py` 已经导入了库
> - 库已经使用了系统默认路径（`~/.cache/huggingface/` 或 `~/Library/Caches/llama_index/`）
> - **解决方案**：在 `.env` 中明确设置，让 `pydantic` 在初始化 `settings` 时就加载正确的值

在 `_build_derived_paths` 中追加：

```python
models_path = Path(self.MODELS_DIR)
if not self.HF_HOME:
    self.HF_HOME = str(models_path / "hf_cache")
if not self.HUGGINGFACE_HUB_CACHE:
    self.HUGGINGFACE_HUB_CACHE = str(models_path / "hf_cache")
for dir_path in [self.MODELS_DIR, self.HF_HOME]:
    Path(dir_path).mkdir(parents=True, exist_ok=True)
```

**你需要回答自己的问题**：

1. **`RAG_MAX_CONCURRENCY = 2` 为什么限制并发？**
   - Embedding + Reranker + LLM 推理都是 CPU/GPU 密集型
   - 不限制 → 10 个用户同时提问 → 内存/显存爆炸 → 所有人超时
   - `asyncio.Semaphore(2)` 让多余的请求排队，而不是拒绝
   - **面试话术**："用 asyncio.Semaphore 做并发控制，防止 GPU/CPU 过载。超限请求排队而非拒绝，保证最终都能处理。"

2. **`RAG_ROUTE_MIN_TOP_SCORE = -2.0` 怎么理解？**
   - BGE-Reranker 输出的相关性分数范围约 `-10 ~ 0`，越高越相关
   - `-2.0` 是经验值
   - 太高（`-0.5`）→ 相关查询被误判为 fallback（漏答）
   - 太低（`-8.0`）→ 不相关内容被当 RAG 上下文（幻觉）
   - **追问**：怎么调？准备一批有答案/无答案的测试问题 → 画 Precision-Recall 曲线 → 找 F1 最大的点

---

## Step 2：`app/services/rag_service.py` — RAG 核心服务

这是整个项目最重要的文件。分段理解，逐块写。

### 2.1 文件头部

```python
"""
RAG 核心服务：PGVector + BGE-M3 + BGE-Reranker + Ollama

流程：检索 -> 重排 -> 路由 -> 生成
本模块只负责 AI 推理逻辑，不依赖 HTTP 协议或数据库 Session。
Think 标签解析由 router 层的 ThinkStreamParser 处理。

视觉模型支持：
  LLM_IS_VISION_MODEL=True 时，流式生成走 _stream_vision 路径，
  通过 Ollama /api/chat 发送 base64 图片。
  LLM_IS_VISION_MODEL=False 时，走 _stream_text 路径，
  图片信息以文字描述注入 prompt。
"""

import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncGenerator

# === 环境变量必须在 import torch/transformers 之前设置 ===
# 原因：这些库在 import 时就读取环境变量决定缓存目录
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    os.environ.pop(key, None)

from app.core.config import settings  # noqa: E402

os.environ["HF_HOME"] = settings.HF_HOME
os.environ["HUGGINGFACE_HUB_CACHE"] = settings.HUGGINGFACE_HUB_CACHE
os.environ["LLAMA_INDEX_CACHE_DIR"] = settings.HF_HOME  # LlamaIndex 缓存路径

import httpx  # noqa: E402
import torch  # noqa: E402
from llama_index.core import Settings as LlamaSettings  # noqa: E402
from llama_index.core import VectorStoreIndex  # noqa: E402
from llama_index.core.schema import QueryBundle  # noqa: E402
from llama_index.embeddings.huggingface import HuggingFaceEmbedding  # noqa: E402
from llama_index.llms.ollama import Ollama  # noqa: E402
from llama_index.postprocessor.flag_embedding_reranker import (  # noqa: E402
    FlagEmbeddingReranker,
)
from llama_index.vector_stores.postgres import PGVectorStore  # noqa: E402

logger = logging.getLogger(__name__)
```

**你需要回答自己的问题**：

1. **为什么环境变量设置在 `import torch` 之前？**
   - `transformers`、`torch` 在 import 时立即读取 `HF_HOME` 决定缓存目录
   - import 之后设置 → 库已用默认路径初始化，设置无效
   - Python 的 import 是**立即执行**的

2. **为什么需要设置 `LLAMA_INDEX_CACHE_DIR`？**
   - `HuggingFaceEmbedding` 是 LlamaIndex 的封装，有自己的缓存机制
   - 默认缓存路径：`~/Library/Caches/llama_index/`（macOS）或 `~/.cache/llama_index/`（Linux）
   - 设置 `LLAMA_INDEX_CACHE_DIR` 后，BGE-M3 模型会下载到项目的 `models/hf_cache/` 目录
   - `FlagEmbeddingReranker` 使用 HuggingFace 的 `transformers`，读取 `HF_HOME`，所以会下载到正确位置
   - **面试点**：不同库的缓存机制不同，需要分别配置

3. **`# noqa: E402` 是什么？**
   - ruff/flake8 规则 E402：module level import not at top of file
   - 因为环境变量设置代码在 import 之前，违反了"import 在文件顶部"的规则
   - `noqa` 告诉 linter：我知道违反了，这是故意的
   - **面试点**：不要滥用 `noqa`，只在有充分理由时使用，并用注释说明原因

4. **为什么要禁用代理？**
   - 开发机可能有 HTTP 代理（科学上网）
   - Ollama 运行在 `localhost`，走代理会连不上
   - `NO_PROXY` 告诉 HTTP 库：localhost 直连

### 2.2 辅助函数

```python
# YOLO 缺陷标签 -> 中文映射
DEFECT_LABEL_ZH: dict[str, str] = {
    "corrosion": "腐蚀",
    "craze": "裂纹",
    "hide_craze": "隐裂",
    "surface_attach": "表面附着物",
    "surface_corrosion": "表面腐蚀",
    "surface_eye": "表面气孔",
    "surface_injure": "表面损伤",
    "surface_oil": "表面油污",
    "thunderstrike": "雷击",
}


def build_augmented_query(question: str, image_context: dict | None) -> str:
    """
    Query 增强：将图片检测到的缺陷标签附加到问题后面，提高向量检索命中率。

    示例：
      输入: "这张图有什么问题", image_context={"objects": [{"class": "corrosion"}, ...]}
      输出: "这张图有什么问题 缺陷类型: corrosion(腐蚀), craze(裂纹)"

    为什么有用：
      用户问"这张图有什么问题"时，query 没有任何缺陷关键词，
      向量检索很难匹配到知识库中具体缺陷的文档。
      把检测标签拼上去，检索和 Reranker 就能命中相关文档。
    """
    if not image_context or not isinstance(image_context, dict):
        return question

    objects = image_context.get("objects") or []
    if not objects:
        return question

    seen: set[str] = set()
    parts: list[str] = []
    for obj in objects:
        cls_name = obj.get("class", "")
        if not cls_name or cls_name in seen:
            continue
        seen.add(cls_name)
        zh = DEFECT_LABEL_ZH.get(cls_name, "")
        parts.append(f"{cls_name}({zh})" if zh else cls_name)

    if not parts:
        return question

    return f"{question} 缺陷类型: {', '.join(parts)}"


def build_sources(
    context_nodes: list, score_threshold: float = -5.0
) -> list[dict[str, Any]]:
    """
    从 context_nodes 构建结构化 sources 列表（给前端展示参考来源）。
    过滤掉分数低于 score_threshold 的来源（展示层过滤，不影响 LLM 生成）。
    """
    sources: list[dict[str, Any]] = []
    for idx, node in enumerate(context_nodes, start=1):
        metadata = getattr(node, "metadata", {}) or {}

        doc = metadata.get("file_name")
        if not doc and "file_path" in metadata:
            doc = os.path.basename(metadata["file_path"])
        if not doc:
            doc = "unknown"

        score = getattr(node, "score", None)
        if score is not None:
            score = round(float(score), 4)

        text = getattr(node, "text", "") or ""
        snippet = text[:100].replace("\n", " ").strip()
        if len(text) > 100:
            snippet += "..."

        if score is not None and score < score_threshold:
            continue

        source: dict[str, Any] = {
            "id": idx,
            "doc": doc,
            "score": score,
            "snippet": snippet,
        }
        if "page" in metadata:
            source["page"] = metadata["page"]
        sources.append(source)

    return sources
```

**你需要回答自己的问题**：

1. **Query 增强为什么用双语标签 `corrosion(腐蚀)`？**
   - 知识库可能有中文文档也有英文文档
   - BGE-M3 是多语言 Embedding 模型，能理解中英文
   - 双语标签同时覆盖两种语言的检索命中

2. **`build_sources` 的 `score_threshold` 和路由的 `RAG_ROUTE_MIN_TOP_SCORE` 有什么区别？**
   - 路由阈值（`-2.0`）：决定走 RAG 还是 fallback（核心决策）
   - sources 过滤阈值（`-5.0`）：决定展示哪些参考来源（展示层过滤，更宽松）
   - 路由走了 RAG → 用 top-5 生成回答 → 但展示时只展示分数 >= -5.0 的来源
   - 两个阈值不同是合理的

### 2.3 RagService 核心类

```python
class RagService:
    """
    RAG 核心服务：PGVector + BGE-M3 + BGE-Reranker + Ollama
    单例模式，全局只初始化一次。

    设计决策：
    - 用 classmethod + 类变量实现单例（模型占数百 MB 内存，不能多实例）
    - 双重检查锁保证并发安全的初始化
    - 信号量限制并发请求数，防止 CPU/GPU 过载
    - generate_chat_stream 只 yield 原始 token，Think 解析由调用方处理
    """

    _index: VectorStoreIndex | None = None
    _reranker: FlagEmbeddingReranker | None = None
    _initialized: bool = False
    _init_lock = asyncio.Lock()
    _chat_sema = asyncio.Semaphore(settings.RAG_MAX_CONCURRENCY)

    RETRIEVAL_TOP_K: int = 10
    RERANK_TOP_N: int = 5
    SCORE_THRESHOLD: float = -6.0  # 节点过滤阈值（比路由阈值更宽松）

    @classmethod
    async def initialize(cls) -> None:
        """
        双重检查锁初始化。

        第一次 if：快速路径，已初始化直接返回（不获取锁）
        async with lock：保证只有一个协程执行初始化
        第二次 if：防止多个协程同时通过第一次检查后重复初始化

        场景推演：
          协程 A: if False -> 获取锁 -> if False -> 初始化 -> True -> 释放锁
          协程 B: if False -> 等锁 -> 获取锁 -> if True -> 直接返回
        """
        if cls._initialized:
            return
        async with cls._init_lock:
            if cls._initialized:
                return

            logger.info("初始化 RAG 服务...")
            try:
                # [1] Embedding 模型（BGE-M3, 1024 维，中英双语）
                LlamaSettings.embed_model = HuggingFaceEmbedding(
                    model_name="BAAI/bge-m3"
                )

                # [2] Ollama LLM
                LlamaSettings.llm = Ollama(
                    model=settings.LLM_MODEL_NAME,
                    base_url=settings.OLLAMA_BASE_URL,
                    request_timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
                    keep_alive=settings.OLLAMA_KEEP_ALIVE,
                    additional_kwargs={"num_ctx": 8192},
                )

                # [3] PGVector Store（Hybrid Search = 向量 + 全文）
                vector_store = PGVectorStore.from_params(
                    database=settings.DB_NAME,
                    host=settings.DB_HOST,
                    password=settings.DB_PASSWORD,
                    port=str(settings.DB_PORT),
                    user=settings.DB_USER,
                    table_name=settings.DB_TABLE,
                    embed_dim=1024,         # BGE-M3 输出维度
                    hybrid_search=True,     # 向量 + 关键词混合检索
                    text_search_config="simple",  # simple 不做语言特定处理，对中文是可用的最低配置（无真正中文分词，需 zhparser 扩展才能精确分词）
                )
                cls._index = VectorStoreIndex.from_vector_store(
                    vector_store=vector_store
                )

                # [4] Reranker（Cross-Encoder，精排用）
                use_fp16 = torch.cuda.is_available() or (
                    torch.backends.mps.is_available()
                    if hasattr(torch.backends, "mps")
                    else False
                )
                cls._reranker = FlagEmbeddingReranker(
                    model="BAAI/bge-reranker-v2-m3",
                    top_n=cls.RERANK_TOP_N,
                    use_fp16=use_fp16,
                )

                cls._initialized = True
                logger.info("RAG 服务初始化完成")

            except Exception:
                logger.exception("RAG 初始化失败")

    @classmethod
    async def generate_chat_stream(
        cls,
        question: str,
        image_context: dict | None = None,
        chat_window: list[dict[str, str]] | None = None,
        vision_image_paths: list[str] | None = None,
        result_meta: dict | None = None,
    ) -> AsyncGenerator[str, None]:
        """
        RAG 主流程 -- 流式生成。

        本方法 yield 的是 LLM 的原始 token（包含 <think> 标签）。
        Think 标签的解析由 router 层的 ThinkStreamParser 处理。
        流结束后会 yield 一个 sources JSON 块（<<<SOURCES>>>...<<<SOURCES_END>>>）。

        Args:
            question: 用户问题
            image_context: YOLO 检测结果（可选，非视觉模型用于文字注入 prompt）
            chat_window: 最近 N 轮对话历史（可选，由 router 层查询后传入）
            vision_image_paths: 图片路径列表（可选，视觉模型用于 base64 传图，支持多张）
            result_meta: 可变字典，service 层填充 sources/route 等元数据，
                         router 层在流结束后读取并存入数据库。
                         为什么用 mutable dict？因为 async generator 无法 return 值，
                         只能通过共享引用传递附加数据。
        """
        # 确保已初始化
        if not cls._initialized or not cls._index:
            await cls.initialize()
            if not cls._index:
                yield "RAG 引擎初始化失败，请联系管理员。"
                return

        t0 = time.perf_counter()

        try:
            # 信号量：限制并发 RAG 请求数
            async with cls._chat_sema:
                # 总超时：防止单个请求卡死
                async with asyncio.timeout(settings.RAG_STREAM_TOTAL_TIMEOUT_S):

                    # === [1] 构建会话窗口 prompt 片段 ===
                    session_block = ""
                    if chat_window:
                        lines: list[str] = []
                        for msg in chat_window:
                            role_zh = "用户" if msg["role"] == "user" else "助手"
                            lines.append(f"{role_zh}: {msg['content']}")
                        session_block = (
                            "\n\n=== 最近对话 ===\n"
                            + "\n".join(lines)
                            + "\n================\n\n"
                        )

                    # === [2] Query 增强 ===
                    augmented_query = build_augmented_query(question, image_context)
                    logger.info("rag stage=query len=%d", len(augmented_query))

                    # === [3] 向量检索（Hybrid Search）===
                    retriever = cls._index.as_retriever(
                        similarity_top_k=cls.RETRIEVAL_TOP_K,
                        vector_store_query_mode="hybrid",
                    )
                    nodes = await retriever.aretrieve(augmented_query)
                    retrieve_ms = (time.perf_counter() - t0) * 1000
                    logger.info(
                        "rag stage=retrieve ms=%.1f nodes=%d",
                        retrieve_ms, len(nodes),
                    )

                    # === [4] 降级兜底 ===
                    if not nodes:
                        logger.warning(
                            "Hybrid search 返回 0 结果，降级为纯向量检索"
                        )
                        fallback_retriever = cls._index.as_retriever(
                            similarity_top_k=cls.RETRIEVAL_TOP_K,
                            vector_store_query_mode="default",
                        )
                        nodes = await fallback_retriever.aretrieve(augmented_query)

                    # === [5] Reranker 重排 ===
                    if cls._reranker and nodes:
                        query_bundle = QueryBundle(query_str=augmented_query)
                        nodes = await asyncio.to_thread(
                            cls._reranker.postprocess_nodes, nodes, query_bundle
                        )
                    rerank_ms = (time.perf_counter() - t0) * 1000

                    # 过滤低分节点
                    context_nodes = [
                        n for n in nodes
                        if n.score is None or n.score > cls.SCORE_THRESHOLD
                    ]

                    # === [6] 置信度路由 ===
                    top_score: float | None = None
                    if context_nodes and context_nodes[0].score is not None:
                        top_score = float(context_nodes[0].score)

                    has_image = bool(
                        image_context and isinstance(image_context, dict)
                    )
                    use_rag = (
                        len(context_nodes) >= settings.RAG_ROUTE_MIN_CONTEXT_NODES
                        and top_score is not None
                        and top_score >= settings.RAG_ROUTE_MIN_TOP_SCORE
                    )
                    route = "rag" if (use_rag or has_image) else "fallback"

                    logger.info(
                        "rag stage=route route=%s nodes=%d top_score=%s ms=%.1f",
                        route,
                        len(context_nodes),
                        f"{top_score:.4f}" if top_score is not None else "n/a",
                        rerank_ms,
                    )

                    # === [6.5] 构建参考文献 sources ===
                    sources: list[dict[str, Any]] = []
                    if route == "rag" and context_nodes:
                        sources = build_sources(context_nodes)
                    # 通过 result_meta 传递给 router 层（存 DB 用）
                    if result_meta is not None:
                        result_meta["sources"] = sources
                        result_meta["route"] = route

                    # === [7] Prompt 构建 ===
                    full_prompt = cls._build_prompt(
                        question=question,
                        context_nodes=context_nodes,
                        route=route,
                        session_block=session_block,
                        image_context=image_context if has_image else None,
                    )

                    # === [8] 流式生成（根据模型类型分支）===
                    # 视觉模型：用 httpx 直调 Ollama /api/chat，附带 base64 图片
                    # 非视觉模型：用 LlamaIndex astream_complete，图片信息已在 prompt 文字中
                    use_vision = (
                        settings.LLM_IS_VISION_MODEL
                        and vision_image_paths
                        and all(Path(p).exists() for p in vision_image_paths)
                    )

                    if use_vision:
                        stream_fn = cls._stream_vision(
                            full_prompt, vision_image_paths, t0
                        )
                    else:
                        stream_fn = cls._stream_text(full_prompt, t0)

                    emitted = False
                    async for token in stream_fn:
                        emitted = True
                        yield token

                    if not emitted:
                        yield "系统繁忙，未生成回答。"

                    # === [9] 流末尾 yield 参考文献（前端解析展示）===
                    if sources:
                        yield (
                            "\n<<<SOURCES>>>"
                            + json.dumps(sources, ensure_ascii=False)
                            + "<<<SOURCES_END>>>"
                        )

                    total_ms = (time.perf_counter() - t0) * 1000
                    logger.info(
                        "rag stage=done route=%s vision=%s sources=%d ms=%.1f",
                        route, use_vision, len(sources), total_ms,
                    )

        except TimeoutError:
            logger.warning("rag stage=timeout")
            yield "系统繁忙（生成超时），请稍后再试。"
        except asyncio.CancelledError:
            logger.info("rag stage=cancelled")
            raise
        except Exception:
            logger.exception("RAG 生成失败")
            yield "\n系统错误，检索服务暂时不可用。"

    @classmethod
    def _build_prompt(
        cls,
        question: str,
        context_nodes: list,
        route: str,
        session_block: str = "",
        image_context: dict | None = None,
    ) -> str:
        """
        根据路由结果构建发送给 LLM 的完整 prompt。

        RAG 路由：system prompt + 图片上下文 + 会话窗口 + 检索上下文 + 问题
        Fallback 路由：system prompt + 会话窗口 + 问题（无检索上下文）
        """
        # System prompt（根据路由不同）
        if route == "rag":
            system = (
                "你是一个专业的风电运维专家助手。"
                "请严格基于检索到的【上下文】来回答用户的问题，不要编造。\n"
                "如果上下文中没有相关信息，请直接说不知道。\n"
                "回答请使用中文。"
            )
        else:
            system = (
                "你是一个专业的风电运维技术助手。\n"
                "当前知识库中未找到与用户问题直接相关的文档。\n"
                "请根据你的通用知识尽可能回答，"
                "但要诚实说明这不是来自专业文档的答案。\n"
                "回答请使用中文。"
            )

        # 图片上下文（拼到 system prompt）
        if image_context and isinstance(image_context, dict):
            total = image_context.get("total", 0)
            objects = image_context.get("objects", []) or []
            defect_lines = [
                f"- {obj.get('class', 'unknown')} "
                f"(置信度: {obj.get('confidence', 'N/A')})"
                for obj in objects
            ]
            defect_str = "\n".join(defect_lines) or "- 无"
            system += (
                f"\n\n=== 当前图像检测结果（共 {total} 个缺陷）===\n"
                f"{defect_str}\n"
                "当用户询问「这张图」或「这个缺陷」时，请结合检测结果回答。"
            )

        # 拼接完整 prompt
        prompt = f"{system}\n\n"

        if session_block:
            prompt += session_block

        if route == "rag" and context_nodes:
            context_text = "\n\n".join(
                n.text[:800] for n in context_nodes[:5]
            )
            prompt += f"=== 检索到的上下文 ===\n{context_text}\n\n"

        prompt += f"用户问题: {question}\n"
        return prompt

    # === 流式生成：非视觉模型路径 ===
    @classmethod
    async def _stream_text(
        cls, prompt: str, t0: float
    ) -> AsyncGenerator[str, None]:
        """
        非视觉模型流式生成：通过 LlamaIndex astream_complete。

        图片信息已作为文字描述注入到 prompt 中（YOLO 检测结果）。
        模型看不到图片本身，只看到 "corrosion(腐蚀), 置信度: 0.95" 这样的文字。
        """
        last_text_len = 0
        first_token = True

        response_gen = await LlamaSettings.llm.astream_complete(prompt)
        async for chunk in response_gen:
            # 提取增量 token（兼容两种 LlamaIndex 后端）
            token = getattr(chunk, "delta", None)
            if token is None:
                current_text = getattr(chunk, "text", "") or ""
                if len(current_text) <= last_text_len:
                    continue
                token = current_text[last_text_len:]
                last_text_len = len(current_text)

            if not token:
                continue

            if first_token:
                ttfb_ms = (time.perf_counter() - t0) * 1000
                logger.info("rag stage=ttfb ms=%.1f mode=text", ttfb_ms)
                first_token = False

            yield token

    # === 流式生成：视觉模型路径 ===
    @classmethod
    async def _stream_vision(
        cls, prompt: str, image_paths: list[str], t0: float
    ) -> AsyncGenerator[str, None]:
        """
        视觉模型流式生成：通过 httpx 直调 Ollama /api/chat，附带 base64 图片。

        为什么不用 LlamaIndex 的 astream_complete？
        - LlamaIndex 的 Ollama 后端的 astream_complete 接受纯文本 prompt
        - 视觉模型需要在 Ollama 的 /api/chat 接口中传 images 字段
        - 直调 httpx 更直接、更可控

        Ollama 视觉模型的请求格式：
        {
            "model": "qwen2.5-vl:7b",
            "messages": [
                {
                    "role": "user",
                    "content": "描述这张图片中的缺陷",
                    "images": ["base64_img1", "base64_img2"]
                }
            ],
            "stream": true
        }
        """
        # 读取所有图片并编码为 base64
        images_b64: list[str] = []
        for image_path in image_paths:
            image_bytes = Path(image_path).read_bytes()
            images_b64.append(base64.b64encode(image_bytes).decode("utf-8"))
            logger.info(
                "vision 图片已编码 path=%s size_kb=%.1f",
                image_path, len(image_bytes) / 1024,
            )

        # 构建 Ollama /api/chat 请求
        # 注意：视觉模型的 prompt 里仍然包含检索上下文和 YOLO 结果（文字版），
        # 但额外附加了原始图片，让模型"看到"实际缺陷
        ollama_payload = {
            "model": settings.LLM_MODEL_NAME,
            "messages": [
                {
                    "role": "user",
                    "content": prompt,
                    "images": images_b64,
                }
            ],
            "stream": True,
            "options": {"num_ctx": 8192},
            "keep_alive": settings.OLLAMA_KEEP_ALIVE,
        }

        first_token = True

        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{settings.OLLAMA_BASE_URL}/api/chat",
                json=ollama_payload,
                timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
            ) as resp:
                async for line in resp.aiter_lines():
                    if not line:
                        continue

                    data = json.loads(line)
                    token = data.get("message", {}).get("content", "")

                    if token:
                        if first_token:
                            ttfb_ms = (time.perf_counter() - t0) * 1000
                            logger.info(
                                "rag stage=ttfb ms=%.1f mode=vision", ttfb_ms
                            )
                            first_token = False
                        yield token

                    if data.get("done"):
                        break
```

**你需要回答自己的问题**：

1. **双重检查锁（DCL）的并发场景推演？**
   ```
   协程 A: if _initialized(False) -> 准备获取锁
   协程 B: if _initialized(False) -> 准备获取锁
   协程 A: 获取锁 -> 第二次检查(False) -> 执行初始化 -> True -> 释放锁
   协程 B: 获取锁 -> 第二次检查(True) -> 直接返回
   ```
   没有第二次检查 → B 也执行初始化 → 模型加载两次 → 内存翻倍

2. **Hybrid Search 是什么？解决什么问题？（面试必答）**
   - 纯向量检索：语义相似能找到，但精确关键词（如故障代码 `Err_105`）可能匹配不到
   - 全文检索：精确匹配关键词，但不理解语义（"损坏"和"破损"匹配不上）
   - Hybrid = 两者融合，覆盖更全
   - **面试金句**："Hybrid Search 结合了语义理解和精确匹配的优势。纯向量漏关键词，纯关键词漏语义，混合互补。"

3. **Bi-Encoder vs Cross-Encoder（面试必答）**
   - **Bi-Encoder（Retriever）**：query 和 document **各自独立**编码成向量 → 算余弦相似度
     - 快（query 编一次，文档提前编好） → 适合 10 万文档初筛
   - **Cross-Encoder（Reranker）**：query + document **拼在一起**过模型
     - 准（模型看到两者的每个 token 交互） → 适合 10 个候选精排
   - **面试金句**："Bi-Encoder 效率高适合大规模初筛，Cross-Encoder 精度高适合小规模精排。两阶段检索是业界标准。"

4. **为什么 Reranker 用 `asyncio.to_thread`？**
   - Cross-Encoder 推理是 CPU 密集型（矩阵乘法），耗时 1-3 秒
   - 同步执行 → 阻塞事件循环 → 其他请求全部 hang 住
   - `to_thread` 放到线程池，和 YOLO 推理用 `to_thread` 同理

5. **为什么低分走 fallback 而不是强行用检索结果？**
   - 检索结果质量差 → 强行拼到 prompt → LLM 基于错误上下文生成"看似正确的废话" → 幻觉
   - **面试金句**："低分强答等于幻觉。置信度路由把不确定的查询路由到 fallback，宁可不答也不胡说。"

6. **`has_image` 为什么直接走 RAG？**
   - 有图片上下文 = 用户在做缺陷分析 = 即使知识库没命中，图片信息已注入 system prompt
   - LLM 可以基于缺陷类型 + 自身知识给出分析
   - 这是业务逻辑判断

7. **Hybrid 检索返回 0 为什么降级到纯向量？**
   - Hybrid 内部需要同时有向量和关键词结果进行融合
   - `"simple"` 分词对中文只做空格切分，无法正确分词 → 关键词部分可能返回 0
   - 但更常见的原因是：向量表为空、embed_dim 不匹配、或 pgvector 索引异常
   - 降级到纯向量 → 只用语义匹配 → 通常能找到结果
   - 这是一个优雅的降级策略

8. **token 增量提取为什么有两种方式？**
   ```python
   token = getattr(chunk, "delta", None)  # 方式 1：原生增量
   token = current_text[last_text_len:]    # 方式 2：累积文本手动计算
   ```
   - LlamaIndex Ollama 后端支持 `delta`（增量 token）
   - 其他 LLM 后端可能只有 `text`（累积全文）
   - 兼容两种 = 以后换 LLM 后端不改代码

9. **`result_meta` 共享字典模式是什么？为什么不用 return？**
   - async generator 只能 `yield`，不能 `return` 一个值给调用方
   - 如果想在流结束后把 sources/route 等元数据传给 router：
     - 方案 A：yield 特殊标记（只能传给前端，router 层解析麻烦）
     - 方案 B：传入一个 mutable dict，service 填充，router 读取（当前方案）
   - 两者结合：`result_meta` 给 router 存 DB 用，`<<<SOURCES>>>` 标记给前端展示用
   - **面试话术**："async generator 无法 return 附加数据。用共享可变字典做 side-channel 传递元信息，同时在流末尾 yield JSON 标记给前端。"

10. **`build_sources` 为什么只在 `route == "rag"` 时调用？**
    - fallback 路由没有检索上下文 → 没有参考文献可展示
    - 返回空 sources → 前端不显示"参考来源"区域
    - **追问**：sources 和 context_nodes 有什么关系？
      - context_nodes 是给 LLM 的输入（拼 prompt）
      - sources 是给用户看的输出（展示来源文档名、分数、摘要）
      - 同一批数据，不同视角

11. **`_build_prompt` 为什么单独提取成方法？**
   - `generate_chat_stream` 已经很长了，prompt 构建是独立逻辑
   - 单独方法更易读、更易测试
   - 以后调整 prompt（如换 system prompt、加 few-shot 示例）只改这个方法

12. **`n.text[:800]` 为什么截断到 800 字符？**
    - 5 个节点 × 800 字符 = 4000 字符 ≈ 1000 token
    - 加上 system prompt + 会话窗口 + 问题，总共约 2000-3000 token
    - 在 `num_ctx=8192` 的窗口内留够生成空间
    - 不截断 → 上下文超长 → 模型截断或报错

13. **视觉模型和非视觉模型的流式生成有什么区别？（面试加分）**
    - **非视觉模型（`_stream_text`）**：
      - 通过 LlamaIndex 的 `astream_complete(prompt)` 调用
      - 图片信息以 YOLO 检测结果的文字描述注入 prompt（如 "corrosion(腐蚀), 置信度: 0.95"）
      - 模型只"看到"文字，不知道缺陷长什么样
    - **视觉模型（`_stream_vision`）**：
      - 通过 httpx 直调 Ollama `/api/chat`，在 user message 中附带 `images: [base64_str, ...]`（支持多张）
      - 模型直接"看到"原始图片，能对比分析不同角度的缺陷
      - prompt 中仍然包含 YOLO 检测结果文字（双重信息源）
    - **为什么视觉模型不用 LlamaIndex？**
      - LlamaIndex 的 `astream_complete` 只接受纯文本 prompt
      - 视觉模型需要在 API 层面传图片（Ollama 的 `images` 字段）
      - 直调 httpx 更直接、更可控，不需要等 LlamaIndex 官方支持
    - **面试话术**："通过配置开关实现两条推理路径。非视觉模型走 LlamaIndex astream_complete，视觉模型走 httpx 直调 Ollama chat API 附带 base64 图片列表。切换模型只改 `.env`，代码零改动。"

14. **`_stream_vision` 中 base64 编码会不会很大？**
    - 一张 500KB 的图片 → base64 编码后约 667KB（膨胀约 33%）
    - 通过 localhost 发送到 Ollama，网络开销可忽略
    - 如果图片特别大（如 10MB 原始照片），建议先压缩/缩放到合理分辨率
    - **追问**：为什么不把图片 URL 传给 Ollama？（Ollama 是本地服务，不能访问外部 URL；base64 是最可靠的传输方式）

---

## Step 3：改 `app/routers/chat.py` — 接入 RAG

Day 6 的 router 改动很小——把 Day 5 的 `httpx` 裸调替换为 `RagService.generate_chat_stream`。

### 核心改动

```python
# 删掉
import httpx

# 新增
from app.services.rag_service import RagService
```

**`event_generator` 内部替换为**：

```python
async def event_generator():
    full_response = ""
    parser = ThinkStreamParser()
    result_meta: dict = {}  # service 层会填充 sources、route 等

    async with AsyncSessionLocal() as bg_session:
        try:
            # Day 6: 调用 RAG service（替代 Day 5 的 httpx 裸调）
            async for raw_token in RagService.generate_chat_stream(
                question=question,
                image_context=image_context,
                chat_window=session_messages,
                vision_image_paths=vision_image_paths,  # 视觉模型用
                result_meta=result_meta,   # service 填充，router 读取
            ):
                if await request.is_disconnected():
                    logger.info("客户端断开连接，停止生成")
                    break

                # ThinkStreamParser 处理 <think> 标签
                parsed = parser.feed(raw_token)
                if parsed:
                    full_response += parsed
                    yield parsed

                await asyncio.sleep(0)

            # 流结束：flush 缓冲区
            remaining = parser.flush()
            if remaining:
                full_response += remaining
                yield remaining

            # 从完整输出中提取纯正文（去掉 think 标记和 think 内容）
            import re
            content_only = re.sub(
                rf"{re.escape(ThinkStreamParser.MARKER_START)}"
                rf".*?"
                rf"{re.escape(ThinkStreamParser.MARKER_END)}",
                "",
                full_response,
                flags=re.DOTALL,
            ).strip()

            if not content_only:
                content_only = "系统繁忙，未生成回答。"
                yield content_only

            # 构建 meta（think + sources + route）
            meta: dict = {}
            if parser.think_content:
                meta["think"] = parser.think_content
            if result_meta.get("sources"):
                meta["sources"] = result_meta["sources"]
            if result_meta.get("route"):
                meta["route"] = result_meta["route"]

            # 存 assistant 消息
            await chat_crud.create_message(
                bg_session,
                user_id=current_user.id,
                role="assistant",
                content=content_only,
                task_id=task_id,
                meta=meta or None,  # 空 dict 存 None，节省空间
            )

        except asyncio.CancelledError:
            logger.info("流式生成被取消")
            raise
        except Exception:
            logger.exception("流式生成失败")
            yield "\n[系统错误，请重试]"
```

同时删掉 Day 5 的 `_build_messages` 函数（prompt 构建已移到 service 层）。

**你需要回答自己的问题**：

1. **为什么 prompt 构建放在 service 而不是 router？**
   - **职责分离**：router 负责 HTTP 协议 + DB 读写，service 负责 AI 推理逻辑
   - 如果 prompt 在 router → 换 WebSocket 或 CLI 调用要复制 prompt 逻辑
   - **面试话术**："router 薄、service 厚。核心业务逻辑下沉到 service 层。"

2. **ThinkStreamParser 为什么在 router 层而不是 service 层？**
   - Think 解析是**展示层关注点**（前端怎么显示思考过程）
   - service 层不应该知道前端的展示协议（`<<<THINK_START>>>` 标记）
   - 不同前端可能有不同的 think 展示需求：
     - Web 前端：用标记分离后分区域展示
     - CLI 客户端：可能想完全隐藏 think
     - API 调用者：可能想要 JSON 结构
   - service 只管 yield 原始 token，怎么处理由调用方决定

3. **正则提取正文 `re.sub(...DOTALL...)` 是什么意思？**
   ```python
   re.sub(r"<<<THINK_START>>>.*?<<<THINK_END>>>", "", text, flags=re.DOTALL)
   ```
   - `.*?` 非贪婪匹配：匹配 START 到最近的 END 之间的所有内容
   - `re.DOTALL`：让 `.` 匹配换行符（默认 `.` 不匹配 `\n`，think 内容常有换行）
   - 效果：去掉所有 think 块，只保留正文

---

## Step 4：改 `app/main.py` — lifespan 加载 RAG

```python
from app.services.rag_service import RagService

@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    await init_models()
    YOLOService.load_model()
    await RagService.initialize()   # 新增
    yield
```

**为什么在 lifespan 初始化？**
- Embedding 加载 5-15 秒、Reranker 加载 3-10 秒
- 第一次请求时初始化 → 用户等 20 秒 → 体验极差
- lifespan 在服务启动时执行，用户永远不遇到冷启动
- `generate_chat_stream` 里的 `if not cls._initialized` 是防御性编程（lifespan 失败时兜底）

---

## Day 6 验收清单

> ⚠️ **前置条件**：RAG 路由测试需要知识库中有数据。如果你还没有灌入文档，验收时所有查询都会走 fallback 路由。
> 可以先跳到 Day 7 完成 `build_knowledge.py` 灌入测试文档后再回来验证 RAG 路由，
> 或者在 `knowledge_base/` 目录下放一份风电叶片缺陷相关的 Markdown 文件，手动运行构建脚本灌入数据。

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/backend

# 1. ruff 无报错
uv run ruff check app/

# 2. 格式化
uv run ruff format --check app/

# 3. 启动服务（观察日志）
uv run uvicorn app.main:app --reload --port 8000
# 日志应该看到：
# "初始化 RAG 服务..."
# "RAG 服务初始化完成"

# 4. Apifox 验证：

# a) RAG 路由测试
#    POST /api/chat/stream {"question": "风电叶片裂纹怎么修复？"}
#    观察输出流：
#    <<<THINK_START>>>思考内容<<<THINK_END>>>基于文档的回答...
#    检查日志：route=rag, top_score=..., nodes=...

# b) Fallback 路由测试
#    POST /api/chat/stream {"question": "今天天气怎么样？"}
#    检查日志：route=fallback

# c) 图片上下文测试
#    POST /api/chat/stream {"question": "分析一下检测结果", "task_id": 1}
#    检查日志：route=rag (has_image=True)

# d) 数据库验证
#    assistant 消息的 content 是纯正文（不含 <think>）
#    assistant 消息的 meta 字段：{"think": "完整思考内容"}
```

---

## 文件写作顺序

```
1. app/core/config.py               <- 改（加 RAG 配置）
2. app/services/rag_service.py      <- 新建（核心）
3. app/routers/chat.py              <- 改（接入 RAG，删掉 httpx 裸调和 _build_messages）
4. app/main.py                      <- 改（lifespan 加 RagService.initialize()）
5. 安装依赖（llama-index 系列 + torch）
6. Apifox 验证
```

---

## 面试话术（90 秒 -- 这是最重要的一段）

> 我的 RAG 管道分为检索、重排、路由、生成四个阶段。
>
> 检索用 pgvector 的 Hybrid Search，结合向量语义匹配和关键词精确匹配，解决纯向量检索漏掉精确关键词的问题。Embedding 用 BGE-M3，1024 维，支持中英双语。
>
> 检索出的 top-10 结果经过 BGE-Reranker Cross-Encoder 精排，保留 top-5。Bi-Encoder 快但粗，Cross-Encoder 慢但准——两阶段检索是业界标准。Reranker 是 CPU 密集型，用 asyncio.to_thread 放到线程池，不阻塞事件循环。
>
> 然后走置信度路由：Reranker 最高分 >= -2.0 且有效节点 >= 1 走 RAG，否则 fallback。低分强答等于幻觉，宁可不答也不胡说。
>
> 流式输出用 StreamingResponse 逐 token 推送，TTFT 降到 200ms。qwen3 模型的 `<think>` 标签由 ThinkStreamParser 实时解析，前端可以分区域展示思考过程和正文。解析器用缓冲区处理标签跨 token 拆分的边界情况。
>
> 并发控制用 asyncio.Semaphore 限制最大 2 个 RAG 请求，防止 GPU/CPU 过载。总超时 90 秒防止卡死。
>
> 系统还支持视觉模型切换。配置 `LLM_IS_VISION_MODEL=True` 后，流式生成走 `_stream_vision` 路径，通过 httpx 直调 Ollama chat API 附带 base64 图片，模型能直接"看到"缺陷图片进行分析。非视觉模型则走 `_stream_text` 路径，图片信息以 YOLO 检测结果的文字注入 prompt。两条路径通过配置切换，代码零改动。
>
> 参考文献展示：RAG 路由时调用 build_sources 提取来源文档名、Reranker 分数和内容摘要。通过 result_meta 共享字典传给 router 层存入数据库 meta.sources，同时在流末尾 yield 特殊标记给前端实时展示。两条路径互补——流式对话和历史消息都能看到参考来源，这是 RAG 相比纯 LLM 的核心优势：可追溯性。
>
> 架构分层：router 层负责 HTTP 协议、认证、DB 读写和 Think 解析；service 层负责纯 AI 推理逻辑（检索、重排、路由、生成），不依赖 HTTP 或数据库。换成 WebSocket 或 CLI 调用时，service 零改动。
