import json
import logging
from urllib import error, request

from pydantic import BaseModel, Field

from app.core.config import settings

logger = logging.getLogger(__name__)

# 先把 RAG 想成一件非常朴素的事：
# 1. 用户先提问题
# 2. 系统先去自己的资料里找相关内容
# 3. 再把“问题 + 找到的资料”一起发给大模型
# 4. 大模型基于这些资料回答
#
# 这个文件就是一个“教学版最小 RAG”。
# 它故意不接 pgvector、不接 reranker、不接复杂框架，
# 只保留最核心的主链路，方便你先把脑子里的图搭起来。


class KnowledgeChunk(BaseModel):
    # 一小段知识片段。
    # 真实项目里，它可能来自 PDF 切块、Markdown 切块或数据库。
    chunk_id: str
    text: str
    keywords: list[str] = Field(default_factory=list)


class RetrievedChunk(BaseModel):
    # 检索后的结果。
    # score 越高，说明我们觉得它和问题越相关。
    chunk_id: str
    score: int
    text: str


class ChatTurn(BaseModel):
    # 一轮对话里的单条消息。
    # 这里故意只保留最核心的两个字段：角色 和 内容。
    role: str
    content: str


class SourceItem(BaseModel):
    # 给前端展示“这次回答参考了哪些资料”。
    # Day 6 里 meta.sources 的作用，本质上就是这个意思。
    id: int
    chunk_id: str
    score: int
    snippet: str


class DemoResult(BaseModel):
    # 为了让打印结果更清楚，我们把教学 demo 的输出整理成一个对象。
    question: str
    query_terms: list[str] = Field(default_factory=list)
    chat_window: list[ChatTurn] = Field(default_factory=list)
    route: str
    retrieved: list[RetrievedChunk] = Field(default_factory=list)
    sources: list[SourceItem] = Field(default_factory=list)
    prompt: str


# --- 1. 一个很小的教学知识库 ---
KNOWLEDGE_BASE = [
    KnowledgeChunk(
        chunk_id="blade-crack",
        text=(
            "叶片裂纹常见于雷击、疲劳载荷和长期腐蚀。处理时先停机复检，"
            "再评估裂纹深度，必要时做打磨、补强和树脂修复。"
        ),
        keywords=["叶片", "裂纹", "雷击", "疲劳", "修复", "停机"],
    ),
    KnowledgeChunk(
        chunk_id="surface-oil",
        text=(
            "表面油污通常来自运输、检修或润滑剂污染。优先做清洁复测，"
            "确认是否只是表面附着物，避免误判成材料损伤。"
        ),
        keywords=["表面油污", "油污", "清洁", "附着物", "复测"],
    ),
    KnowledgeChunk(
        chunk_id="corrosion",
        text=(
            "表面腐蚀需要记录范围、深度和位置。轻度腐蚀可先除锈和涂层修补，"
            "若已影响结构强度，应升级为人工复检和停机评估。"
        ),
        keywords=["腐蚀", "除锈", "涂层", "复检", "停机"],
    ),
]

# --- 2. 查询提示词 ---
QUERY_HINTS = [
    "叶片",
    "裂纹",
    "隐裂",
    "雷击",
    "腐蚀",
    "表面腐蚀",
    "表面油污",
    "油污",
    "附着物",
    "修复",
    "复检",
    "停机",
    "清洁",
]


def build_demo_chat_window() -> list[ChatTurn]:
    """
    这是一个“假的历史对话窗口”。
    目的不是做真实聊天，而是帮你理解 Day 6 里的 chat_window 到底是什么。

    通俗理解：
    它就是“用户刚刚前面说过的话”。
    如果没有它，模型只看到当前这一句，容易答得很生硬。
    """
    return [
        ChatTurn(role="user", content="我在看风机叶片的缺陷案例。"),
        ChatTurn(role="assistant", content="可以，我会优先按叶片缺陷知识来回答。"),
    ]


def role_to_zh(role: str) -> str:
    role_map = {
        "user": "用户",
        "assistant": "助手",
        "system": "系统",
    }
    return role_map.get(role, role or "未知")


def build_chat_window_text(chat_window: list[ChatTurn]) -> str:
    """
    把历史对话拼成一段文本，后面会一起塞进 prompt。

    你可以把它理解成：
    在正式提问前，先把“前情提要”交给模型看一眼。
    """
    if not chat_window:
        return ""

    lines: list[str] = []
    for item in chat_window:
        lines.append(f"{role_to_zh(item.role)}: {item.content}")

    return "\n".join(lines)


def extract_query_terms(question: str) -> list[str]:
    """
    从用户问题里提取关键词。
    这一步在真实 RAG 里通常由 embedding 完成，
    这里只用最简单的关键词命中来帮你理解检索流程。

    通俗理解：
    你问一句话，系统先看看这句话里有哪些“重点词”。
    后面检索时，就靠这些重点词去知识库里找资料。
    """
    terms: list[str] = []

    # 先用预设提示词表匹配。
    # 比如问题里出现“裂纹”“腐蚀”，就先抓出来。
    for hint in QUERY_HINTS:
        if hint in question and hint not in terms:
            terms.append(hint)

    if terms:
        return terms

    # 如果提示词表一个也没匹配上，
    # 就退一步，去遍历知识库里的关键词。
    # 这是一个很笨但很好理解的兜底办法。
    for chunk in KNOWLEDGE_BASE:
        for keyword in chunk.keywords:
            if keyword in question and keyword not in terms:
                terms.append(keyword)

    return terms


def retrieve_chunks(question: str, top_k: int = 2) -> list[RetrievedChunk]:
    """
    教学版检索：
    1. 先提取 query 关键词
    2. 再统计每个 chunk 命中了几个关键词
    3. 分数越高，认为越相关

    通俗理解：
    这一步就像你在书里查资料。
    哪一段内容和你的问题重合词更多，
    我们就暂时认为它更可能有用。
    """
    query_terms = extract_query_terms(question)
    if not query_terms:
        # 一个关键词都提不出来，就说明这次问题和当前教学知识库关系很弱。
        return []

    results: list[RetrievedChunk] = []
    for chunk in KNOWLEDGE_BASE:
        score = 0
        for term in query_terms:
            # 这里的“打分”非常简单：
            # 只要问题关键词出现在 chunk 正文或关键词列表里，就加 1 分。
            if term in chunk.text or term in chunk.keywords:
                score += 1

        if score <= 0:
            # 分数为 0，说明这一段资料和当前问题没有明显关系，跳过。
            continue

        results.append(
            RetrievedChunk(
                chunk_id=chunk.chunk_id,
                score=score,
                text=chunk.text,
            )
        )

    results.sort(key=lambda item: item.score, reverse=True)
    return results[:top_k]


def build_sources(retrieved_chunks: list[RetrievedChunk]) -> list[SourceItem]:
    """
    把检索结果整理成 sources。

    为什么要单独做这一步？
    因为“检索结果”是给程序内部用的，
    但“sources”更像是给前端或用户展示的参考来源。
    """
    sources: list[SourceItem] = []
    for index, item in enumerate(retrieved_chunks, start=1):
        snippet = item.text[:60].replace("\n", " ").strip()
        if len(item.text) > 60:
            snippet += "..."

        sources.append(
            SourceItem(
                id=index,
                chunk_id=item.chunk_id,
                score=item.score,
                snippet=snippet,
            )
        )
    return sources


def choose_route(retrieved_chunks: list[RetrievedChunk], min_score: int = 1) -> str:
    """
    决定这次请求走哪条路。

    Day 6 里有 rag / fallback 路由。
    这里我们先做一个最简单版本：
    - 有结果，而且最高分达到阈值 -> rag
    - 否则 -> fallback
    """
    if not retrieved_chunks:
        return "fallback"

    top_score = retrieved_chunks[0].score
    if top_score >= min_score:
        return "rag"
    return "fallback"


def build_prompt(
    question: str,
    retrieved_chunks: list[RetrievedChunk],
    route: str,
    chat_window: list[ChatTurn],
) -> str:
    """
    教学版 Prompt 构建：
    有上下文就把上下文拼进去，没有就直接问模型。

    这是 RAG 最关键的一步。
    很多人以为 RAG 的重点是“检索”，
    其实真正落到模型身上，是你怎么把检索结果喂给它。
    """
    # route 不同，system prompt 也不同。
    # 这就是 Day 6 “路由影响回答策略”的最小版。
    if route == "rag":
        system_prompt = (
            "你是一个风电运维助手。请优先基于提供的上下文回答；如果上下文不足，就直接说不知道。"
        )
    else:
        system_prompt = (
            "你是一个风电运维助手。"
            "当前没有找到特别可靠的知识库内容。"
            "你可以给出一般性建议，但必须明确说明这不是基于知识库的精确答案。"
        )

    session_text = build_chat_window_text(chat_window)
    prompt = f"{system_prompt}\n\n"

    if session_text:
        prompt += f"=== 最近对话 ===\n{session_text}\n\n"

    if route == "rag" and retrieved_chunks:
        context_lines: list[str] = []
        for item in retrieved_chunks:
            # 把“检索到的资料”一条条拼进 prompt。
            # 真正的 RAG 系统通常也会做这件事，只是上下文来源更复杂。
            context_lines.append(f"[{item.chunk_id}] score={item.score} {item.text}")

        context_text = "\n".join(context_lines)
        prompt += f"=== 检索到的上下文 ===\n{context_text}\n\n"

    prompt += f"用户问题: {question}\n"
    return prompt


def run_demo(
    question: str,
    top_k: int = 2,
    chat_window: list[ChatTurn] | None = None,
) -> DemoResult:
    """
    把教学版 RAG 的主链路串起来：
    question -> retrieve -> route -> build_prompt

    你可以把这个函数当成“总控函数”。
    如果你暂时记不住全文件，就先记住它。
    """
    final_chat_window = chat_window or []
    query_terms = extract_query_terms(question)
    retrieved_chunks = retrieve_chunks(question, top_k=top_k)
    route = choose_route(retrieved_chunks)
    sources = build_sources(retrieved_chunks)
    prompt = build_prompt(
        question=question,
        retrieved_chunks=retrieved_chunks,
        route=route,
        chat_window=final_chat_window,
    )
    return DemoResult(
        question=question,
        query_terms=query_terms,
        chat_window=final_chat_window,
        route=route,
        retrieved=retrieved_chunks,
        sources=sources,
        prompt=prompt,
    )


def call_ollama(prompt: str, model_name: str = "", base_url: str = "") -> str:
    """
    可选：把拼好的 prompt 发给本地 Ollama。
    默认读取 rework 当前配置。

    这一步不是理解 RAG 的重点。
    真正的重点是：在调用模型之前，我们已经先做了检索和 prompt 拼接。
    """
    final_model_name = model_name or settings.LLM_MODEL_NAME
    final_base_url = base_url or settings.OLLAMA_BASE_URL

    payload = json.dumps(
        {
            "model": final_model_name,
            "prompt": prompt,
            "stream": False,
        }
    ).encode("utf-8")

    req = request.Request(
        url=f"{final_base_url.rstrip('/')}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with request.urlopen(req, timeout=30) as response:
            data = json.loads(response.read().decode("utf-8"))
    except error.URLError as exc:
        logger.exception("调用 Ollama 失败")
        raise RuntimeError(
            "调用 Ollama 失败，请先确认 `ollama serve` 已启动，并检查 OLLAMA_BASE_URL 配置。"
        ) from exc

    answer = data.get("response", "").strip()
    if not answer:
        raise RuntimeError("Ollama 返回为空，无法生成回答。")
    return answer


def print_demo_result(result: DemoResult) -> None:
    """
    把结果按比较容易读的方式打印出来。
    你现在第二阶段学习时，重点看这 6 块：
    1. Chat Window
    2. Query Terms
    3. Route
    4. Retrieved
    5. Sources
    6. Prompt
    """
    print("=== Chat Window（模拟最近几轮对话）===")
    print(json.dumps(result.model_dump(mode="json")["chat_window"], ensure_ascii=False, indent=2))
    print("=== Query Terms（系统从你的问题里抓到了什么关键词）===")
    print(result.query_terms)
    print("\n=== Route（这次请求走哪条路）===")
    print(result.route)
    print("\n=== Retrieved（系统从知识库里找到了哪些资料）===")
    print(json.dumps(result.model_dump(mode="json")["retrieved"], ensure_ascii=False, indent=2))
    print("\n=== Sources（整理后可展示给前端/用户的参考来源）===")
    print(json.dumps(result.model_dump(mode="json")["sources"], ensure_ascii=False, indent=2))
    print("\n=== Prompt（最终真正发给大模型的内容）===")
    print(result.prompt)


def main() -> None:
    # 你第一次学习时，只需要改下面这 3 个值。
    question = "风电叶片裂纹应该怎么处理？"
    top_k = 2
    use_ollama = False
    chat_window = build_demo_chat_window()

    # 第 1 步：先让教学版 RAG 跑起来。
    result = run_demo(
        question=question,
        top_k=top_k,
        chat_window=chat_window,
    )

    # 第 2 步：把中间结果打印出来，让你看清楚它到底做了什么。
    print_demo_result(result)

    # 第 3 步：如果你已经装好了 Ollama，再把 prompt 发给模型。
    # 如果你现在只是学流程，这里保持 False 就行。
    if use_ollama:
        answer = call_ollama(result.prompt)
        print("\n=== LLM Answer ===")
        print(answer)


if __name__ == "__main__":
    main()
