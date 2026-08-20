import asyncio
import base64
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, AsyncGenerator

from app.core.config import settings
from app.security import GUARDRAIL_RESPONSE, check_context_node, check_user_input
from app.services.cjk_fts import tokenize_for_fts
from app.services.query_rewrite import needs_rewrite
from app.services.rag_trace import (
    first_node_score,
    maybe_start_trace,
    rerank_moved,
)
from app.services.retrieval_fusion import retrieve_two_path

os.environ["HF_HOME"] = settings.HF_HOME
os.environ["HUGGINGFACE_HUB_CACHE"] = settings.HUGGINGFACE_HUB_CACHE
os.environ["LLAMA_INDEX_CACHE_DIR"] = settings.HF_HOME

import re

import httpx  # noqa: F401
import torch  # noqa: F401
from llama_index.core import Settings as LlamaSettings  # noqa: F401
from llama_index.core import VectorStoreIndex  # noqa: F401
from llama_index.core.base.llms.types import ChatMessage, MessageRole
from llama_index.core.schema import QueryBundle  # noqa: F401
from llama_index.embeddings.huggingface import HuggingFaceEmbedding  # noqa: F401
from llama_index.llms.ollama import Ollama  # noqa: F401
from llama_index.postprocessor.flag_embedding_reranker import FlagEmbeddingReranker  # noqa: F401
from llama_index.vector_stores.postgres import PGVectorStore  # noqa: F401

logger = logging.getLogger(__name__)

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


# 截断标记：如果 assistant content 中出现这些，说明后面是模型自问自答的污染
_TRUNCATION_MARKERS = [
    "\n=============",  # 旧的多轮分隔符
    "\nuser:",  # 嵌入的伪造 user turn
    "\nuser：",
    "\n用户:",
    "\n用户：",
    "\nassistant:",  # 嵌入的伪造 assistant turn
    "\nassistant：",
    "\nAssistant 提供的回答",  # 评审式语句
    "\nThinking Process:",  # 泄漏的 thinking 块
]

_ASSISTANT_NOISE_PATTERNS = [
    re.compile(r"^助手[回答]*[:：]\s*", re.MULTILINE),
    re.compile(r"^您的回答非常准确且专业[！!]*\s*", re.MULTILINE),
    re.compile(r"^Assistant 回答是否准确\??\s*", re.MULTILINE),
    re.compile(r"^用户问题[:：]\s*.*$", re.MULTILINE),
]


_RAG_TERM_FIDELITY_INSTRUCTIONS = (
    "优先保留上下文中的专业术语、设备名称、材料名称和部件名称。\n"
    "如果上下文列出了检测方法、工艺步骤、关键部件或工具名称，请明确点名列出。\n"
    "不要为了概括而把原始术语改写成更泛的说法；例如不要只说“热像检测”，"
    "而遗漏“热像仪”，也不要遗漏“导雷系统”这类关键部件。\n"
    "当用户询问“第一步”“首先”这类步骤问题时，先直接回答第一步，"
    "再补充 1 句最关键的后续步骤或关键检查点，避免把核心流程截断。"
)


def sanitize_assistant_history(content: str) -> str:
    """清洗 assistant 历史内容中的污染模式，仅用于回灌模型，不修改 DB。

    策略：
    1. 先在最早的截断标记处截断（移除模型自问自答的后半部分）
    2. 再用正则清洗行首的结构噪音
    """
    text = content

    # 第一步：在最早的截断标记处截断
    earliest_cut = len(text)
    for marker in _TRUNCATION_MARKERS:
        pos = text.lower().find(marker.lower())
        if pos != -1 and pos < earliest_cut:
            earliest_cut = pos
    if earliest_cut < len(text):
        text = text[:earliest_cut]

    # 第二步：正则清洗行首噪音
    for pat in _ASSISTANT_NOISE_PATTERNS:
        text = pat.sub("", text)

    return text.strip()


def build_augmented_query(question: str, image_context: dict | None) -> str:
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
    return f"{question} 缺陷类型:{', '.join(parts)}"


_REWRITE_SYSTEM = (
    "你是一个查询改写引擎。根据对话历史，将用户最新一句话改写为"
    "一条自包含、适合向量检索的中文查询。\n"
    "规则：\n"
    "- 补全所有指代和省略，使查询脱离对话上下文也能看懂\n"
    "- 保留原始意图，不要扩展、不要回答、不要解释\n"
    "- 只输出改写后的查询，不要输出任何其他内容\n"
    "- 如果原始问题已经自包含，原样输出即可"
)


def _needs_rewrite(question: str, *, has_history: bool = False) -> bool:
    """有历史的短问才改写。不认指代词，避免「轻度的怎么划分?」被跳过。"""
    return needs_rewrite(question, has_history=has_history)


async def rewrite_query_with_context(
    question: str,
    chat_window: list[dict[str, str]],
) -> str:
    """利用 LLM 将多轮对话中的指代性 query 改写为自包含检索 query。"""
    if not chat_window:
        return question
    if not _needs_rewrite(question, has_history=True):
        logger.debug("rag rewrite skipped: question is self-contained %r", question)
        return question

    history_lines: list[str] = []
    # 只取最近 4 轮，控制 token 成本
    for msg in chat_window[-8:]:
        role = "用户" if msg.get("role") == "user" else "助手"
        content = (msg.get("content") or "")[:200]
        history_lines.append(f"{role}: {content}")

    user_prompt = (
        "对话历史:\n" + "\n".join(history_lines) + "\n\n"
        f"用户最新问题: {question}\n"
        f"改写后的检索查询:"
    )

    messages = [
        ChatMessage(role=MessageRole.SYSTEM, content=_REWRITE_SYSTEM),
        ChatMessage(role=MessageRole.USER, content=user_prompt),
    ]

    try:
        t = time.perf_counter()
        if settings.LLM_PROVIDER == "openai":
            # 直接调 API，不走 LlamaIndex（避免 thinking 模式的巨大延迟）
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{settings.LLM_API_BASE}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.LLM_API_KEY}"},
                    json={
                        "model": settings.LLM_MODEL_NAME,
                        "messages": [
                            {"role": "system", "content": _REWRITE_SYSTEM},
                            {"role": "user", "content": user_prompt},
                        ],
                        "max_tokens": 100,
                        "temperature": 0.3,
                        "chat_template_kwargs": {"enable_thinking": False},
                    },
                    timeout=15.0,
                )
                resp.raise_for_status()
                data = resp.json()
                rewritten = (data["choices"][0]["message"]["content"] or "").strip()
        else:
            llm_resp = await LlamaSettings.llm.achat(messages)
            rewritten = (llm_resp.message.content or "").strip()
        ms = (time.perf_counter() - t) * 1000
        if rewritten and len(rewritten) < 500:
            logger.info(
                "rag stage=rewrite ms=%.1f original=%r rewritten=%r",
                ms,
                question,
                rewritten,
            )
            return rewritten
        logger.warning("rag rewrite 结果异常，回退原始 query: %r", rewritten[:100])
        return question
    except Exception:
        logger.warning("rag rewrite 失败，回退原始 query", exc_info=True)
        return question


def build_debug_nodes(nodes: list) -> list[dict[str, Any]]:
    """eval 观测口：把检索节点变成 (名次, 分数, 全文) 列表。

    text 不截断——eval 判分要在 chunk 全文里找 term，截断会造成假阴性
    （这正是弃用 sources.snippet 判检索的原因，见 eval30_审题报告 §二A）。
    """
    out: list[dict[str, Any]] = []
    for rank, node in enumerate(nodes, start=1):
        score = getattr(node, "score", None)
        out.append(
            {
                "rank": rank,
                "score": round(float(score), 4) if score is not None else None,
                "text": getattr(node, "text", "") or "",
            }
        )
    return out


def build_source(context_nodes: list, source_threshold: float = -5.0) -> list[dict[str, Any]]:
    sources: list[dict[str, Any]] = []
    for idx, node in enumerate(context_nodes, start=1):
        metadata = getattr(node, "metadata", {}) or {}

        doc = metadata.get("file_name") or metadata.get("filename")
        if not doc and "file_path" in metadata:
            doc = Path(metadata["file_path"]).name
        if not doc:
            doc = metadata.get("doc_key") or "unknown"

        score = getattr(node, "score", None)
        if score is not None:
            score = round(float(score), 4)

        text = getattr(node, "text", "") or ""
        snippet = text[:100].replace("\n", " ").strip()
        if len(text) > 100:
            snippet += "..."

        if score is not None and score < source_threshold:
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


class RagService:
    _index: VectorStoreIndex | None = None
    _reranker: FlagEmbeddingReranker | None = None
    _initialized: bool = False
    _init_lock = asyncio.Lock()
    _chat_sema = asyncio.Semaphore(settings.RAG_MAX_CONCURRENCY)

    @classmethod
    def _load_models_sync(cls) -> None:
        """同步加载 embedding / LLM / 向量索引 / reranker。必须在线程里跑。"""
        LlamaSettings.embed_model = HuggingFaceEmbedding(
            model_name="BAAI/bge-m3",
            model_kwargs={"dtype": "float16"},
        )

        if settings.LLM_PROVIDER == "openai":
            from llama_index.llms.openai_like import OpenAILike

            extra_kwargs = {"max_tokens": 8192}
            if settings.LLM_ENABLE_THINKING:
                extra_kwargs["extra_body"] = {
                    "chat_template_kwargs": {"enable_thinking": True},
                }
                extra_kwargs["temperature"] = 0.2

            LlamaSettings.llm = OpenAILike(
                model=settings.LLM_MODEL_NAME,
                api_base=settings.LLM_API_BASE,
                api_key=settings.LLM_API_KEY,
                is_chat_model=True,
                timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
                additional_kwargs=extra_kwargs,
                # 自建网关前的 Cloudflare WAF 会拦 openai 客户端默认 UA
                # （"OpenAI/Python ..."→ 403 Your request was blocked），故显式换 UA。
                default_headers={"User-Agent": "rework-backend/1.0"},
            )
            logger.info(
                "LLM 初始化完成: provider=openai api_base=%s model=%s",
                settings.LLM_API_BASE,
                settings.LLM_MODEL_NAME,
            )
        else:
            LlamaSettings.llm = Ollama(
                model=settings.LLM_MODEL_NAME,
                base_url=settings.OLLAMA_BASE_URL,
                request_timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
                keep_alive=settings.OLLAMA_KEEP_ALIVE,
                additional_kwargs={"num_ctx": 8192},
            )
        # PGVectorStore 连接说明：
        # 1. pgvector 不是独立数据库，而是 PostgreSQL 扩展；向量检索/写入仍然占用 PostgreSQL 连接。
        # 2. 这里不会复用 app.core.database 里的 ORM engine。
        #    PGVectorStore 内部会自己创建独立的 SQLAlchemy engine。
        # 3. 按当前依赖版本，它会创建 sync + async 两套 engine，因此这里等价于 2 套独立 pool。
        # 4. 如果没有传 create_engine_kwargs，这两套 pool 也会继续使用 SQLAlchemy 默认值：
        #    pool_size=5, max_overflow=10。
        # 5. 如果以后 PostgreSQL 连接预算紧张，这里要和 database.py 一起显式传
        #    create_engine_kwargs，不能只改 ORM 那一套。

        #     vector_store = PGVectorStore.from_params(
        #     database=settings.DB_NAME,
        #     host=settings.DB_HOST,
        #     port=str(settings.DB_PORT),
        #     password=settings.DB_PASSWORD,
        #     user=settings.DB_USER,
        #     table_name=settings.DB_TABLE,
        #     embed_dim=1024,
        #     hybrid_search=True,
        #     text_search_config="simple",
        #     create_engine_kwargs={
        #         "pool_size": 3,
        #         "max_overflow": 2,
        #         "pool_timeout": 30,
        #         "pool_pre_ping": True,
        #     },
        # )

        vector_store = PGVectorStore.from_params(
            database=settings.DB_NAME,
            host=settings.DB_HOST,
            port=str(settings.DB_PORT),
            password=settings.DB_PASSWORD,
            user=settings.DB_USER,
            table_name=settings.DB_TABLE,
            embed_dim=1024,
            hybrid_search=True,
            text_search_config="simple",
        )
        cls._index = VectorStoreIndex.from_vector_store(vector_store=vector_store)

        use_fp16 = torch.cuda.is_available() or (
            torch.backends.mps.is_available() if hasattr(torch.backends, "mps") else False
        )
        cls._reranker = FlagEmbeddingReranker(
            model="BAAI/bge-reranker-v2-m3",
            top_n=settings.RERANK_TOP_N,
            use_fp16=use_fp16,
        )

    @classmethod
    async def initialize(cls) -> None:
        if cls._initialized:
            return
        async with cls._init_lock:
            if cls._initialized:
                return

            logger.info("初始化RAG服务...")
            try:
                # HuggingFace / reranker 加载是同步 CPU。放进线程，避免卡住事件循环。
                # 仍由 lifespan 预热：RAG 没就绪就不要对外服务。
                # 不改成懒加载：首个聊天请求会把整段模型加载转嫁给用户。
                await asyncio.to_thread(cls._load_models_sync)
                cls._initialized = True
                logger.info("RAG服务初始化完成")
            except Exception:
                logger.exception("RAG服务初始化失败")
                raise

    @classmethod
    async def generate_chat_stream(
        cls,
        question: str,
        image_context: dict | None = None,
        chat_window: list[dict[str, str]] | None = None,
        vision_image_paths: list[str] | None = None,
        result_meta: dict | None = None,
    ) -> AsyncGenerator[str, None]:
        if result_meta is not None:
            result_meta["finish_reason"] = "ok"

        if not cls._initialized or not cls._index:
            await cls.initialize()
            if not cls._index:
                if result_meta is not None:
                    result_meta["finish_reason"] = "init_failed"
                yield "RAG 引擎初始化失败，请联系管理员"
                return

        t0 = time.perf_counter()
        # 关闭时 maybe_start_trace 返回 None，不构造对象。
        trace = maybe_start_trace()
        # 放在最前面——不安全直接拒答，不浪费后续计算资源
        # 包含：长度校验 + Unicode 归一化 + 规则评分
        # ============================================
        is_safe, injection_score, injection_rules = check_user_input(question)
        if not is_safe:
            if result_meta is not None:
                result_meta["finish_reason"] = "guardrail_blocked"
            yield GUARDRAIL_RESPONSE
            return
        if trace is not None:
            trace.lap_ms()  # 门卫耗时不记入 rewrite 跳

        try:
            async with cls._chat_sema:
                async with asyncio.timeout(settings.RAG_STREAM_TOTAL_TIMEOUT_S):
                    session_messages = chat_window or []

                    # 多轮 query 改写：解决指代消歧（"那隐裂呢" → "隐裂的修复方案"）
                    retrieval_query = question
                    if session_messages:
                        retrieval_query = await rewrite_query_with_context(
                            question, session_messages
                        )
                        # eval 多轮层判分依赖此字段；记录实际用于检索的 query，
                        # 改写被启发式跳过时它就等于原句——观测现实，不美化
                        if result_meta is not None:
                            result_meta["rewritten_query"] = retrieval_query
                    if not session_messages:
                        rewrite_skipped, rewrite_reason = True, "no_history"
                    elif not _needs_rewrite(question, has_history=True):
                        rewrite_skipped, rewrite_reason = True, "heuristic_skip"
                    else:
                        rewrite_skipped, rewrite_reason = False, None
                    if trace is not None:
                        rewrite_fields: dict = {
                            "skipped": rewrite_skipped,
                            "original": question,
                            "rewritten": retrieval_query,
                        }
                        if rewrite_reason is not None:
                            rewrite_fields["reason"] = rewrite_reason
                        trace.add("rewrite", **rewrite_fields)
                    augmented_question = build_augmented_query(retrieval_query, image_context)
                    hybrid_query = tokenize_for_fts(augmented_question) or augmented_question
                    logger.info("rag stage=query len=%d", len(augmented_question))

                    top_k = settings.RETRIEVAL_TOP_K
                    dense_retriever = cls._index.as_retriever(
                        similarity_top_k=top_k, vector_store_query_mode="default"
                    )
                    sparse_retriever = cls._index.as_retriever(
                        similarity_top_k=top_k, vector_store_query_mode="sparse"
                    )
                    fallback_retriever = cls._index.as_retriever(
                        similarity_top_k=top_k, vector_store_query_mode="default"
                    )
                    nodes, retrieve_mode = await retrieve_two_path(
                        dense_retriever.aretrieve(hybrid_query),
                        sparse_retriever.aretrieve(hybrid_query),
                        lambda: fallback_retriever.aretrieve(augmented_question),
                        fusion=settings.RAG_FUSION_MODE,
                        rrf_k=settings.RRF_K,
                    )
                    retriever_ms = (time.perf_counter() - t0) * 1000
                    logger.info("rag stage=retriever ms=%.1f node=%d", retriever_ms, len(nodes))
                    if retrieve_mode == "fallback_dense":
                        logger.warning("两路检索都空，降级为纯向量检索")

                    if trace is not None:
                        trace.add(
                            "retrieve",
                            mode=retrieve_mode,
                            query=augmented_question,
                            tokenized_query=hybrid_query,
                            returned=len(nodes),
                            top_score=first_node_score(nodes),
                        )

                    pre_rerank_nodes = nodes  # rerank 返回新列表，此引用保住 rerank 前名次表
                    if cls._reranker and nodes:
                        query_bundle = QueryBundle(query_str=augmented_question)
                        nodes = await asyncio.to_thread(
                            cls._reranker.postprocess_nodes,
                            nodes,
                            query_bundle,
                        )
                    rerank_ms = (time.perf_counter() - t0) * 1000
                    if trace is not None:
                        trace.add(
                            "rerank",
                            **{
                                "in": len(pre_rerank_nodes),
                                "out": len(nodes),
                                "moved": rerank_moved(pre_rerank_nodes, nodes),
                            },
                        )

                    # eval 观测口（裁决 A）：带出 rerank 前 top_k / 后 top_n 的完整名次表。
                    # 生产保持关闭——chunk 全文进 meta 会显著放大消息体积。
                    if settings.RAG_EVAL_DEBUG and result_meta is not None:
                        result_meta["retrieval_debug"] = {
                            "pre_rerank": build_debug_nodes(pre_rerank_nodes),
                            "post_rerank": build_debug_nodes(nodes),
                        }

                    context_nodes = [
                        n for n in nodes if n.score is None or n.score > settings.SOURCE_THRESHOLD
                    ]

                    # 放在 Reranker 之后（已精排，节点少），Prompt 构建之前
                    # 使用 CONTEXT_RULES（不含格式弱信号）
                    # ============================================
                    safe_nodes: list = []
                    for node in context_nodes:
                        node_text = getattr(node, "text", "") or ""
                        node_safe, node_score = check_context_node(node_text)
                        if node_safe:
                            safe_nodes.append(node)
                        else:
                            logger.warning(
                                "剔除可疑上下文节点 score=%d snippet=%.50s",
                                node_score,
                                node_text,
                            )
                    context_nodes = safe_nodes

                    top_score: float | None = None
                    if context_nodes and context_nodes[0].score is not None:
                        top_score = float(context_nodes[0].score)

                    has_image = bool(image_context and isinstance(image_context, dict))
                    has_vision = bool(
                        settings.LLM_IS_VISION_MODEL
                        and vision_image_paths
                        and all(Path(p).exists() for p in vision_image_paths)
                    )
                    use_rag = (
                        len(context_nodes) >= settings.RAG_ROUTE_MIN_CONTEXT_NODES
                        and top_score is not None
                        and top_score >= settings.RAG_ROUTE_MIN_TOP_SCORE
                    )
                    route = "rag" if (use_rag or has_image or has_vision) else "fallback"

                    logger.info(
                        "rag stage=route route=%s node=%d top_score=%s injection_score=%d ms=%.1f",
                        route,
                        len(context_nodes),
                        f"{top_score:.4f}" if top_score is not None else "n/a",
                        injection_score,
                        rerank_ms,
                    )
                    if trace is not None:
                        trace.add(
                            "route",
                            route=route,
                            context_nodes=len(context_nodes),
                            top_score=top_score,
                            injection_score=injection_score,
                        )

                    sources: list[dict[str, Any]] = []
                    if route == "rag" and context_nodes:
                        sources = build_source(context_nodes)

                    if result_meta is not None:
                        result_meta["sources"] = sources
                        result_meta["route"] = route

                    use_vision = (
                        settings.LLM_IS_VISION_MODEL
                        and vision_image_paths
                        and all(Path(p).exists() for p in vision_image_paths)
                    )

                    ttfb_sink: list[float] | None = [] if trace is not None else None
                    generate_mode = "vision" if use_vision else "chat"
                    if use_vision:
                        # 视觉链路仍用 _build_prompt（直接发 HTTP），后续迭代统一
                        full_prompt = cls._build_prompt(
                            question=question,
                            context_nodes=context_nodes,
                            route=route,
                            session_block="",
                            image_context=image_context if has_image else None,
                        )
                        stream_fn = cls._stream_vision(
                            full_prompt, vision_image_paths, t0, ttfb_sink=ttfb_sink
                        )
                    else:
                        messages = cls._build_messages(
                            question=question,
                            context_nodes=context_nodes,
                            route=route,
                            chat_window=session_messages,
                            image_context=image_context if has_image else None,
                        )
                        logger.info(
                            "rag stage=messages count=%d roles=%s",
                            len(messages),
                            [m.role.value for m in messages],
                        )
                        for i, m in enumerate(messages):
                            logger.debug(
                                "msg[%d] role=%s len=%d preview=%.100s",
                                i,
                                m.role.value,
                                len(m.content),
                                m.content[:100],
                            )
                        stream_fn = cls._stream_chat(messages, t0, ttfb_sink=ttfb_sink)
                    emitted = False
                    async for token in stream_fn:
                        emitted = True
                        yield token
                    if not emitted:
                        yield "LLM没有返回任何内容，请稍后再试或联系管理员"

                    if sources:
                        yield (
                            "\n<<<SOURCES>>>"
                            + json.dumps(sources, ensure_ascii=False)
                            + "<<<SOURCES_END>>>"
                        )
                    total_ms = (time.perf_counter() - t0) * 1000
                    logger.info(
                        "rag stage=done route=%s vision=%s sources=%d ms=%.1f",
                        route,
                        use_vision,
                        len(sources),
                        total_ms,
                    )
                    if trace is not None:
                        finish_reason = "ok"
                        if result_meta is not None:
                            finish_reason = str(result_meta.get("finish_reason") or "ok")
                        generate_fields: dict = {
                            "mode": generate_mode,
                            "finish_reason": finish_reason,
                        }
                        if ttfb_sink:
                            generate_fields["ttfb_ms"] = ttfb_sink[0]
                        trace.add("generate", **generate_fields)
                        if result_meta is not None:
                            result_meta["rag_trace"] = trace.finish()
        except TimeoutError:
            if result_meta is not None:
                result_meta["finish_reason"] = "timeout"
                if trace is not None and "rag_trace" not in result_meta:
                    result_meta["rag_trace"] = trace.finish()
            logger.warning("rag stage=timeout")
            yield "系统繁忙（生成超时），请稍后再试。"
        except asyncio.CancelledError:
            if result_meta is not None:
                result_meta["finish_reason"] = "cancelled"
                if trace is not None and "rag_trace" not in result_meta:
                    result_meta["rag_trace"] = trace.finish()
            logger.info("rag stage=cancelled")
            raise
        except Exception:
            if result_meta is not None:
                result_meta["finish_reason"] = "internal_error"
                if trace is not None and "rag_trace" not in result_meta:
                    result_meta["rag_trace"] = trace.finish()
            logger.exception("RAG 生成失败")
            yield "\n系统错误，检索服务暂时不可用。"

    @classmethod
    def _build_messages(
        cls,
        question: str,
        context_nodes: list,
        route: str,
        chat_window: list[dict[str, str]] | None = None,
        image_context: dict | None = None,
    ) -> list[ChatMessage]:
        """构建结构化 chat messages，替代旧的自由文本 prompt 拼接。"""
        messages: list[ChatMessage] = []
        include_history = bool(
            chat_window and _needs_rewrite(question, has_history=True)
        )

        # 1. System prompt
        if route == "rag":
            system_text = (
                "你是一个专业的风电运维专家助手。\n"
                "请严格基于检索到的【上下文】来回答用户的问题，不要编造。\n"
                "如果上下文中没有相关信息，请直接说不知道。\n"
                "回答请使用中文。不要用英文回答。\n\n"
                "【硬约束】\n"
                "- 直接回答用户当前问题，不要改写成新的提问。\n"
                "- 不要虚构用户身份、岗位、背景或案例。\n"
                '- 不要输出"我的问题是...""用户的问题是..."。\n'
                '- 不要输出"助手回答:""您的回答非常准确"等评审或转述语句。\n'
                f"- {_RAG_TERM_FIDELITY_INSTRUCTIONS}"
            )
        else:
            system_text = (
                "你是一个专业的风电运维技术助手。\n"
                "当前知识库中未找到与用户问题直接相关的文档。\n"
                "请根据你的通用知识尽可能回答，"
                "但要诚实说明这不是来自专业文档的答案。\n"
                "回答请使用中文。不要用英文回答。\n\n"
                "【硬约束】\n"
                "- 直接回答用户当前问题，不要改写成新的提问。\n"
                "- 不要虚构用户身份、岗位、背景或案例。\n"
                '- 不要输出"我的问题是...""用户的问题是..."。\n'
                '- 不要输出"助手回答:""您的回答非常准确"等评审或转述语句。\n'
                "- 如果用户只是打招呼，请简短问候，并说明你可以帮助完成哪些风电运维问题。"
            )
        # 2. 图片检测上下文（合并进 system prompt）
        if image_context and isinstance(image_context, dict):
            total = image_context.get("total", 0)
            objects = image_context.get("objects", []) or []
            defect_lines = [
                f"- {obj.get('class', 'unknown')} (置信度: {obj.get('confidence', 'N/A')})"
                for obj in objects
            ]
            defect_str = "\n".join(defect_lines) or "- 无"
            system_text += (
                f"\n\n当前图像检测结果（共 {total} 个缺陷）：\n"
                f"{defect_str}\n"
                "当用户询问「这张图」或「这个缺陷」时，请结合检测结果回答。"
            )

        # 3. RAG 检索上下文（合并进 system prompt）
        if route == "rag" and context_nodes:
            context_text = "\n\n".join(n.text[:800] for n in context_nodes[:5])
            system_text += (
                "\n\n以下是仅供回答当前问题使用的检索上下文。"
                "必须优先依据这些内容作答；如果上下文不足，明确说明不足，不要编造。\n\n"
                + context_text
            )

        messages.append(ChatMessage(role=MessageRole.SYSTEM, content=system_text))

        # 4. 历史对话（结构化 user/assistant turns）
        if include_history:
            for msg in chat_window:
                role = MessageRole.USER if msg.get("role") == "user" else MessageRole.ASSISTANT
                content = msg.get("content", "")
                if role == MessageRole.ASSISTANT:
                    content = sanitize_assistant_history(content)
                if content:
                    messages.append(ChatMessage(role=role, content=content))

        # 5. 当前用户问题
        messages.append(ChatMessage(role=MessageRole.USER, content=question))

        return messages

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
                "回答请使用中文。不要用英文回答。\n" + _RAG_TERM_FIDELITY_INSTRUCTIONS
            )
        else:
            system = (
                "你是一个专业的风电运维技术助手。\n"
                "当前知识库中未找到与用户问题直接相关的文档。\n"
                "请根据你的通用知识尽可能回答，"
                "但要诚实说明这不是来自专业文档的答案。\n"
                "回答请使用中文。不要用英文回答。"
            )

        # 图片上下文（拼到 system prompt）
        if image_context and isinstance(image_context, dict):
            total = image_context.get("total", 0)
            objects = image_context.get("objects", []) or []
            defect_lines = [
                f"- {obj.get('class', 'unknown')} (置信度: {obj.get('confidence', 'N/A')})"
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
            context_text = "\n\n".join(n.text[:800] for n in context_nodes[:5])
            prompt += f"=== 检索到的上下文 ===\n{context_text}\n\n"

        prompt += f"用户问题: {question}\n"
        return prompt

    @classmethod
    async def _stream_text(cls, prompt: str, t0: float) -> AsyncGenerator[str, None]:
        """[已废弃] 纯文本补全流式输出，使用 LlamaIndex 的 astream_complete 接口。

        早期开发阶段（LM Studio 本地模型）使用此方法，当时 prompt 是拼接好的纯字符串，
        直接调用 /completions 接口做文本补全。

        废弃原因：切换到结构化对话模式（system/user/assistant 多角色 messages）后，
        改用 _stream_chat（调用 /chat/completions），支持多轮上下文和 thinking 解析。
        本方法不再被任何调用方使用，保留仅供参考。

        流式增量提取逻辑：
        - 优先取 chunk.delta（LlamaIndex 标准增量字段）
        - 如果 delta 为空，回退到 chunk.text 做手动增量切片
          （某些 provider 只返回累积文本而非增量 token）
        """
        last_text_len = 0
        first_token = True

        response_gen = await LlamaSettings.llm.astream_complete(prompt)
        async for chunk in response_gen:
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
                logger.info(
                    "rag stage=ttfb ms=%.1f mode=text",
                    ttfb_ms,
                )
                first_token = False
            yield token

    @classmethod
    async def _stream_chat(
        cls,
        messages: list[ChatMessage],
        t0: float,
        ttfb_sink: list[float] | None = None,
    ) -> AsyncGenerator[str, None]:
        """结构化对话流式输出，使用 LlamaIndex 的 astream_chat 接口。

        当前主力生成方法。接收 system/user/assistant 多角色 messages，
        调用 /chat/completions 协议（兼容 OpenAI / NVIDIA NIM / LM Studio / Ollama）。

        核心逻辑：
        1. thinking 处理：部分推理模型（如 LM Studio 的 reasoning model）会在
           additional_kwargs 中返回 thinking_delta，此方法将其包裹为
           <think>...</think> 标签输出，由上层 ThinkStreamParser 转换为前端标记。
        2. 流式增量提取：优先取 chunk.delta，回退到 chunk.message.content 的手动增量切片。
        3. TTFB 记录：第一个 token 到达时记录 Time To First Byte，用于性能监控。
        """
        first_token = True
        last_content_len = 0
        thinking_started = False
        thinking_ended = False
        stream_t0 = time.perf_counter()

        response_gen = await LlamaSettings.llm.astream_chat(messages)
        async for chunk in response_gen:
            # 处理 reasoning_content（LM Studio reasoning model 的思考内容）
            thinking_delta = (
                chunk.additional_kwargs.get("thinking_delta", "")
                if chunk.additional_kwargs
                else ""
            )
            if thinking_delta and not thinking_ended:
                if not thinking_started:
                    thinking_started = True
                    yield "<think>"
                yield thinking_delta
                continue
            elif thinking_started and not thinking_ended:
                thinking_ended = True
                yield "</think>"

            # 优先取 delta，回退到 message.content 的增量
            token = getattr(chunk, "delta", None) or ""
            if not token:
                msg = getattr(chunk, "message", None)
                if msg:
                    current = getattr(msg, "content", "") or ""
                    if len(current) > last_content_len:
                        token = current[last_content_len:]
                        last_content_len = len(current)

            if not token:
                continue
            if first_token:
                ttfb_ms = (time.perf_counter() - t0) * 1000
                logger.info("rag stage=ttfb ms=%.1f mode=chat", ttfb_ms)
                if ttfb_sink is not None:
                    # trace 要单跳 TTFB，不能搬日志里从总 t0 起算的累计值
                    ttfb_sink.append(round((time.perf_counter() - stream_t0) * 1000, 1))
                first_token = False
            yield token

    @classmethod
    async def _stream_vision(
        cls,
        prompt: str,
        image_paths: list[str],
        t0: float,
        ttfb_sink: list[float] | None = None,
    ) -> AsyncGenerator[str, None]:
        images_b64: list[str] = []
        for image_path in image_paths:
            image_bytes = Path(image_path).read_bytes()
            images_b64.append(base64.b64encode(image_bytes).decode("utf-8"))
            logger.info(
                "vision 图片已编码 path=%s size_kb=%.1f", image_path, len(image_bytes) / 1024
            )

        if settings.LLM_PROVIDER == "openai":
            payload = {
                "model": settings.LLM_MODEL_NAME,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            *[
                                {
                                    "type": "image_url",
                                    "image_url": {"url": f"data:image/jpeg;base64,{img}"},
                                }
                                for img in images_b64
                            ],
                        ],
                    }
                ],
                "stream": True,
                "max_tokens": 8192,
            }
            if settings.LLM_ENABLE_THINKING:
                payload["chat_template_kwargs"] = {"enable_thinking": True}
                payload["temperature"] = 0.6
            headers = {"Authorization": f"Bearer {settings.LLM_API_KEY}"}
            api_url = f"{settings.LLM_API_BASE}/chat/completions"
        else:
            payload = {
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
            api_url = f"{settings.OLLAMA_BASE_URL}/api/chat"

        first_token = True
        thinking_started = False
        thinking_ended = False
        stream_t0 = time.perf_counter()

        stream_headers = headers if settings.LLM_PROVIDER == "openai" else None

        async with (
            httpx.AsyncClient() as client,
            client.stream(
                "POST",
                api_url,
                json=payload,
                headers=stream_headers,
                timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
            ) as resp,
        ):
            async for line in resp.aiter_lines():
                if not line:
                    continue

                if settings.LLM_PROVIDER == "openai":
                    if line.startswith("data: "):
                        line = line[len("data: ") :]
                    if line == "[DONE]":
                        break
                    if not line:
                        continue

                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("vision stream: skip non-JSON line: %r", line[:80])
                    continue

                if settings.LLM_PROVIDER == "openai":
                    delta = data.get("choices", [{}])[0].get("delta", {})
                    reasoning = delta.get("reasoning_content") or ""
                    token = delta.get("content") or ""

                    if reasoning and not thinking_ended:
                        if not thinking_started:
                            thinking_started = True
                            yield "<think>"
                        yield reasoning
                        continue
                    elif thinking_started and not thinking_ended:
                        thinking_ended = True
                        yield "</think>"
                else:
                    token = data.get("message", {}).get("content") or ""

                if token:
                    if first_token:
                        ttfb_ms = (time.perf_counter() - t0) * 1000
                        logger.info("rag stage=ttfb ms=%.1f mode=vision", ttfb_ms)
                        if ttfb_sink is not None:
                            ttfb_sink.append(round((time.perf_counter() - stream_t0) * 1000, 1))
                        first_token = False
                    yield token
                if settings.LLM_PROVIDER == "ollama" and data.get("done"):
                    break
