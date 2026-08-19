# LM Studio 推理模型聊天 Bug 修复 —— 完整教程

> 这不是一份"怎么改代码"的 changelog，而是一份**从发现问题到解决问题的完整思维过程教程**。
> 目标：让你下次遇到类似的流式处理问题时，能独立排查和修复。

---

## 目录

1. [Bug 全景：到底坏了什么](#一bug-全景到底坏了什么)
2. [排查方法论：怎么一步步定位的](#二排查方法论怎么一步步定位的)
3. [修复 1：API 端点修复（最简单的一行）](#三修复-1api-端点修复)
4. [修复 2：思考内容提取（理解数据流是关键）](#四修复-2思考内容提取)
5. [修复 3：流式去重（最难的部分）](#五修复-3流式去重)
6. [知识点总结：这次 Bug 教会了我们什么](#六知识点总结)

---

## 一、Bug 全景：到底坏了什么

用户用 LM Studio 运行 qwen3.5-4b 推理模型聊天时，**三个功能同时坏了**：

| # | 症状 | 严重程度 |
|---|------|---------|
| 1 | 回答被截断，不完整 | 🔴 功能不可用 |
| 2 | 没有思考框（前端看不到模型推理过程） | 🟡 功能缺失 |
| 3 | 没有参考文献框（RAG 来源未展示） | 🟡 功能缺失 |

一个很重要的线索藏在服务端日志里：

```
POST /v1/completions    ← 注意：这是文本补全 API
```

正确应该是 `POST /v1/chat/completions`（对话 API）。这条日志就是整个排查的突破口。

---

## 二、排查方法论：怎么一步步定位的

### 原则：分层验证，从外到内

流式聊天的数据流经 5 层，排查时从最外层开始，逐层验证：

```
                         ① 是不是模型的问题？
                            ↓
LM Studio API ──→ ② LlamaIndex 处理对不对？
                            ↓
              ──→ ③ _stream_chat 提取逻辑对不对？
                            ↓
              ──→ ④ ThinkStreamParser 转换对不对？
                            ↓
              ──→ ⑤ event_generator yield 对不对？
```

**实际排查路径**：

1. **看日志** → 发现调用了 `/v1/completions` 而不是 `/v1/chat/completions`
   - 立刻定位到 LlamaIndex 的 `is_chat_model` 配置问题
   - 修复后，思考内容不再截断，但前端仍然没有思考框

2. **对比 API 响应格式** → 发现 LM Studio 推理模型的思考不在 `content` 里
   - Ollama 方案：`<think>我在想...</think>答案` 全在 `content` 字段
   - LM Studio 方案：`reasoning_content: "我在想..."` 是**独立字段**
   - 我们的 `_stream_chat` 只读了 `content`，完全漏掉了思考内容

3. **修复思考提取后** → 前端有了思考框，但回答出现两遍

4. **curl 直接调 LM Studio** → 无重复 → 证明不是模型/模板的问题
   - 重复是在 LlamaIndex 注入复杂 RAG 上下文后触发的模型行为

5. **设计流式去重算法** → 三次迭代才做对（下面详细讲）

### 关键教训

> **不要假设问题只有一个**。这次有三个独立的 bug，互相掩盖了症状。如果只修了一个就停下，其他两个会一直存在。

---

## 三、修复 1：API 端点修复

### 问题本质

LlamaIndex 的 `OpenAILike` 类有一个参数 `is_chat_model`，默认值是 `False`：

```python
# LlamaIndex 源码（简化）
class OpenAILike(OpenAI):
    is_chat_model: bool = False  # ← 默认值是 False！
```

这个参数决定了调用哪个 API 端点：

| `is_chat_model` | 端点 | 消息格式 |
|---|---|---|
| `False` | `/v1/completions` | 纯文本，不支持角色 |
| `True` | `/v1/chat/completions` | `[{role, content}]` 对话结构 |

LM Studio 的推理模型是**对话模型**，必须用 Chat Completions API。

### 修复代码

**文件：`app/services/rag_service.py` → `initialize()` 方法**

```python
# 修复前（错误）
LlamaSettings.llm = OpenAILike(
    model=settings.LLM_MODEL_NAME,
    api_base=settings.LM_STUDIO_BASE_URL,
    api_key="lm-studio",
    # is_chat_model 没设置，默认 False → 调用 /v1/completions
    timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
)

# 修复后（正确）
LlamaSettings.llm = OpenAILike(
    model=settings.LLM_MODEL_NAME,
    api_base=settings.LM_STUDIO_BASE_URL,
    api_key="lm-studio",
    is_chat_model=True,           # ← 关键：用 Chat Completions API
    timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
    additional_kwargs={"max_tokens": 8192},  # 推理模型思考很长，给足 token
)
```

### 你该学到什么

> **永远不要信任第三方库的默认值**。用一个 LLM 适配器之前，先看它的参数列表，搞清楚每个默认值对你的场景是否正确。`is_chat_model=False` 对 GPT-3 文本补全是对的，但对任何现代对话模型都是**错的**。

---

## 四、修复 2：思考内容提取

### 问题本质

推理模型返回思考内容有两种方案，你必须搞清楚你的模型用的是哪种：

```
方案 A（Ollama/vLLM 常见）：
  content: "<think>我在想...</think>答案是 42"
  → 思考和正文混在同一个字段，靠 <think> 标签区分

方案 B（LM Studio/OpenAI o1 系列）：
  reasoning_content: "我在想..."    ← 独立字段
  content: "答案是 42"              ← 只有正文
  → 思考和正文是分开的字段
```

我们的项目之前只支持方案 A（因为之前用的是 Ollama）。切到 LM Studio 后，思考内容在 `reasoning_content` 字段里，但我们没读它。

### LlamaIndex 的中间转换

LM Studio API 的 `reasoning_content` 经过 LlamaIndex 后，变成了 `additional_kwargs["thinking_delta"]`：

```
LM Studio API 层                    LlamaIndex 层
─────────────────────────────────────────────────────────
delta.reasoning_content  ──映射→  chunk.additional_kwargs["thinking_delta"]
delta.content            ──映射→  chunk.delta
```

### 修复代码

**文件：`app/services/rag_service.py` → `_stream_chat()` 方法**

这是一个**状态机**，有两个阶段：思考阶段 → 正文阶段

```python
@classmethod
async def _stream_chat(
    cls, messages: list[ChatMessage], t0: float
) -> AsyncGenerator[str, None]:
    """使用 astream_chat 进行结构化对话生成。"""
    first_token = True
    last_content_len = 0
    # ===== 状态机：追踪"思考 → 正文"的阶段转换 =====
    thinking_started = False
    thinking_ended = False

    response_gen = await LlamaSettings.llm.astream_chat(messages)
    async for chunk in response_gen:
        # ===== 阶段 1：思考内容处理 =====
        # 从 LlamaIndex 的 additional_kwargs 中提取 thinking_delta
        thinking_delta = (
            chunk.additional_kwargs.get("thinking_delta", "")
            if chunk.additional_kwargs else ""
        )

        if thinking_delta and not thinking_ended:
            # 思考阶段：有思考内容到达
            if not thinking_started:
                thinking_started = True
                yield "<think>"       # ← 注入开始标签（给下游 Parser 用）
            yield thinking_delta      # ← 原样输出思考内容
            continue                  # ← 重要：跳过正文处理
        elif thinking_started and not thinking_ended:
            # 思考刚结束：有了 thinking 但本次 chunk 没有 thinking_delta
            thinking_ended = True
            yield "</think>"          # ← 注入结束标签

        # ===== 阶段 2：正文内容处理 =====
        # 优先取 chunk.delta（增量），回退到 message.content 的增量
        token = getattr(chunk, "delta", None) or ""
        if not token:
            # 回退逻辑：某些 LLM 不提供 delta，只累积 message.content
            msg = getattr(chunk, "message", None)
            if msg:
                current = getattr(msg, "content", "") or ""
                if len(current) > last_content_len:
                    token = current[last_content_len:]  # 取新增部分
                    last_content_len = len(current)

        if not token:
            continue
        if first_token:
            ttfb_ms = (time.perf_counter() - t0) * 1000
            logger.info("rag stage=ttfb ms=%.1f mode=chat", ttfb_ms)
            first_token = False
        yield token
```

### 数据流全图

```
LM Studio                      _stream_chat              ThinkStreamParser         前端
─────────                      ────────────              ─────────────────         ────
reasoning_content: "分析..."  → yield "<think>"         → "<<<THINK_START>>>"    → 折叠思考框
reasoning_content: "所以..."  → yield "分析...\n所以.." → (思考内容原样通过)      → 框内展示
(reasoning_content 变空)      → yield "</think>"        → "<<<THINK_END>>>"      → 折叠结束
content: "答"                 → yield "答"              → "答"（直通）           → 正文流式显示
content: "案"                 → yield "案"              → "案"（直通）           → 正文流式显示
```

### 你该学到什么

1. **`continue` 的重要性**：第 587 行的 `continue` 确保思考阶段不会意外进入正文处理逻辑。没有它，thinking_delta 和 delta 可能在同一个 chunk 中被双重读取。

2. **状态机是流式处理的核心模式**：`thinking_started` / `thinking_ended` 两个 bool 构成了一个三状态机：`未开始 → 思考中 → 已结束`。流式数据到达的顺序不可控，只有状态机能安全地追踪阶段。

3. **回退逻辑的防御价值**：`chunk.delta` 优先，`message.content` 增量回退。这保证即使某些 LLM 实现不提供 `delta`，我们仍然能正确工作。`last_content_len` 是关键——它记住"我已经读到哪了"，只取新增部分。

---

## 五、修复 3：流式去重（最难的部分）

这是整个修复中最有技术含量的部分。我们经历了**三次失败迭代**才做对。

### 5.0 问题是什么

qwen3.5-4b（4B 参数小模型）在收到复杂提示词（RAG 上下文 + 系统指令 + 对话历史）后，会把整段回答**生成两遍**：

```
正常输出：
  <think>分析问题...</think>你好！我是专业的风电运维技术助手，很高兴为你服务。

模型实际输出：
  <think>分析问题...</think>你好！我是专业的风电运维技术助手，很高兴为你服务。
  你好！我是专业的风电运维技术助手，很高兴为你服务。    ← 重复！
```

这是**流式输出**，token 一个一个来。一旦 yield 给前端就无法收回。

### 5.1 失败方案 1：先 yield，后用 DB 去重

**想法**：先把所有内容 yield 给前端，反正 DB 存的时候有 `_deduplicate_content()` 兜底。

**为什么失败**：

```python
def _deduplicate_content(content: str) -> str:
    """尝试在中间位置找到重复切割点"""
    text = content.strip()
    length = len(text)
    for split_pos in range(length // 3, length * 2 // 3):
        if text[:split_pos].strip() == text[split_pos:].strip():
            return text[:split_pos].strip()
    return text
```

这个函数能清理 DB 存储，但**前端已经显示了两遍**。用户体验是：看到一段话，然后又看到一模一样的话。DB 干净了没用，用户已经被恶心到了。

**教训：流式场景下，"事后清理"不等于"问题解决"。用户看到的是流，不是最终结果。**

### 5.2 失败方案 2：先 yield，再用前缀匹配检测

**想法**：正文开头 15 个字符作为指纹，后面每来一个字符就匹配。匹配上了就知道重复了。

**为什么失败**：虽然检测到了重复，但 15 个字符已经 yield 出去了！

```
时间线：
  yield "你"      ← 已发出
  yield "好"      ← 已发出
  yield "！"      ← 已发出
  ...
  yield "你"      ← 开始匹配！但这个字符已经 yield 了
  yield "好"      ← 继续匹配...已经 yield 了
  ...匹配满 15 字符...
  → 确认重复，停止

结果：前端看到了 "正文...你好！我是专业的风电" 共 15 个重复字符
```

**教训：检测重复和阻止重复是两个不同的问题。先 yield 再检测 = 泄漏。**

### 5.3 失败方案 3：缓冲式指纹检测（几乎成功）

**想法**：反过来！先不 yield，把可疑的字符存到 `_pending` 缓冲区。匹配满了就扔掉，不匹配再释放。

**几乎成功**，但泄漏了 5-6 个字符。原因很微妙：

`ThinkStreamParser` 为了检测 `<think>` 标签，会缓冲最后 6 个字符（`len("<think>") - 1 = 5`）。思考结束后这些字符还在缓冲区里。当第二份重复开始到来时，缓冲区的字符被挤出来了——在我们的指纹匹配开始之前。

```
Parser 内部状态：
  buffer = "务。"（第一份回答的末尾，被 parser 扣住的 6 个字节）

重复开始到来：
  新 token: "\n\n你好"
  → parser.feed("\n\n你好")
  → buffer 变成 "务。\n\n你好"
  → 安全释放: "务。"  ← 这 2 个字符在去重逻辑之前就 yield 了！
  → 然后才轮到去重逻辑处理 "\n\n你好"

结果：泄漏了 "务。" 这种尾巴
```

### 5.4 最终方案：Parser Passthrough + 缓冲式指纹去重

**核心洞察**：思考结束后，不可能再出现 `<think>` 标签。所以 Parser 的 6 字符缓冲完全没用了，反而是个隐患。**思考结束时立刻关掉 Parser 的缓冲**。

#### 第一步：给 ThinkStreamParser 加 `set_passthrough()` 方法

**文件：`app/utils/stream_parser.py`**

```python
class ThinkStreamParser:
    THINK_OPEN = "<think>"
    THINK_CLOSE = "</think>"
    MARKER_START = "<<<THINK_START>>>"
    MARKER_END = "<<<THINK_END>>>"

    def __init__(self) -> None:
        self._in_think: bool = False
        self._buffer: str = ""
        self._think_content: str = ""
        self._passthrough: bool = False    # ← 新增：直通模式标记

    def set_passthrough(self) -> str:
        """思考块结束后切换为直通模式，释放缓冲区并停止标签检测。

        为什么需要这个方法？
        - feed() 中为了检测 <think> 标签，会保留最后 5 个字符在缓冲区
        - 思考结束后不可能再出现 <think>，所以这个缓冲毫无意义
        - 如果不释放，缓冲区里的字符会在下一次 feed() 时才被推出
        - 这个延迟推出的时机恰好在去重逻辑之前，造成尾部泄漏

        返回：缓冲区中的残留内容（需要加入去重流程）
        """
        remaining = self._buffer    # 取出残留
        self._buffer = ""           # 清空缓冲
        self._passthrough = True    # 开启直通
        return remaining

    def feed(self, token: str) -> str:
        # ===== 直通模式：零延迟，零缓冲 =====
        if self._passthrough:
            return token

        # ===== 正常模式：标签检测（需要缓冲） =====
        self._buffer += token
        output = ""

        while self._buffer:
            if self._in_think:
                # ----- 在思考块内：检测 </think> -----
                end_pos = self._buffer.find(self.THINK_CLOSE)
                if end_pos != -1:
                    # 找到 </think>
                    think_chunk = self._buffer[:end_pos]
                    output += think_chunk
                    output += self.MARKER_END
                    self._think_content += think_chunk
                    self._buffer = self._buffer[end_pos + len(self.THINK_CLOSE):]
                    self._in_think = False
                else:
                    # 没找到完整标签：安全释放前面的部分，保留末尾用于跨 token 检测
                    safe_len = len(self._buffer) - (len(self.THINK_CLOSE) - 1)
                    if safe_len > 0:
                        think_chunk = self._buffer[:safe_len]
                        output += think_chunk
                        self._think_content += think_chunk
                        self._buffer = self._buffer[safe_len:]
                    break
            else:
                # ----- 不在思考块内：检测 <think> -----
                start_pos = self._buffer.find(self.THINK_OPEN)
                if start_pos != -1:
                    # 找到 <think>
                    output += self._buffer[:start_pos]
                    output += self.MARKER_START
                    self._buffer = self._buffer[start_pos + len(self.THINK_OPEN):]
                    self._in_think = True
                else:
                    # 没找到完整标签：安全释放前面的部分
                    safe_len = len(self._buffer) - (len(self.THINK_OPEN) - 1)
                    if safe_len > 0:
                        output += self._buffer[:safe_len]
                        self._buffer = self._buffer[safe_len:]
                    break
        return output

    def flush(self) -> str:
        """流结束时调用，释放所有剩余缓冲。"""
        remaining = self._buffer
        self._buffer = ""
        if self._in_think:
            self._think_content += remaining
            remaining += self.MARKER_END
            self._in_think = False
        return remaining
```

**缓冲机制图解**（这是理解 Parser 的关键）：

```
假设 token 流是: "abc" → "de<" → "thin" → "k>我" → "在想" → "</th" → "ink>" → "答案"

feed("abc"):
  buffer = "abc"
  检测 <think>？没有
  safe_len = 3 - 5 = -2 → 不释放（太短，可能是 <think> 的一部分）
  output = ""
  （为什么？因为 "abc" 可能后面跟 "de<think>" 变成 "abcde<think>"）
  （实际上 "abc" 不可能是 <think> 的一部分，但 parser 不知道后面会来什么）

等等，实际上 safe_len = len("abc") - (len("<think>") - 1) = 3 - 5 = -2
所以什么都不释放，全留在 buffer 里。

feed("de<"):
  buffer = "abcde<"
  检测 <think>？没有（"<" 在末尾，可能是 "<think>" 的开头）
  safe_len = 6 - 5 = 1
  释放 "a"，buffer = "bcde<"
  output = "a"

feed("thin"):
  buffer = "bcde<thin"
  检测 <think>？没有（"<thin" 可能是 "<think>" 的开头）
  safe_len = 9 - 5 = 4
  释放 "bcde"，buffer = "<thin"
  output = "bcde"

feed("k>我"):
  buffer = "<think>我"
  检测 <think>？是！
  释放 "<think>" 之前的内容（空），输出 MARKER_START
  buffer = "我"，in_think = True
  safe_len = 1 - 7 = -6 → 不释放
  output = "<<<THINK_START>>>"

feed("在想"):
  buffer = "我在想"
  in_think = True，检测 </think>？没有
  safe_len = 3 - 7 = -4 → 不释放
  output = ""

... 以此类推
```

> **核心理解**：`safe_len = len(buffer) - (len(tag) - 1)` 这个公式是说："buffer 末尾的 `len(tag)-1` 个字符可能是一个标签的开头，不能释放，要等后续 token 确认。" 这就是为什么总有字符被扣住。

#### 第二步：在 event_generator 中实现缓冲式去重

**文件：`app/routers/chat.py` → `event_generator()` 函数**

完整代码 + 逐行解读：

```python
async def event_generator():
    full_response = ""
    parser = ThinkStreamParser()
    result_meta: dict = {}

    # ===== 去重状态变量 =====
    _stream_stopped = False   # 确认重复后设为 True，停止 yield
    _think_ended = False      # 收到 <<<THINK_END>>> 后设为 True
    _PREFIX_LEN = 15          # 前缀指纹长度（太短误判多，太长延迟高）
    _prefix = ""              # 正文前缀指纹（前 15 个非空白字符开头的内容）
    _match_cursor = 0         # 当前匹配到指纹的第几个字符
    _pending = ""             # 疑似重复的缓冲区（未 yield）

    async with AsyncSessionLocal() as bg_session:
        try:
            async for raw_token in RagService.generate_chat_stream(...):
                if await request.is_disconnected():
                    break

                # ===== Parser 转换 =====
                parsed = parser.feed(raw_token)
                if parsed:
                    full_response += parsed

                    # ===== SOURCES 标记始终透传，不受去重影响 =====
                    if "<<<SOURCES>>>" in parsed:
                        yield parsed
                        continue

                    # ===== 已确认重复，后续全部吞掉 =====
                    if _stream_stopped:
                        continue

                    # ========================================
                    # 阶段 A：THINK_END 之前 → 直接 yield
                    # ========================================
                    if not _think_ended:
                        if ThinkStreamParser.MARKER_END in parsed:
                            # 本次 token 包含了 THINK_END 标记
                            _think_ended = True
                            marker = ThinkStreamParser.MARKER_END
                            idx = parsed.index(marker)

                            # 标记及之前的部分直接发送（思考内容，不需要去重）
                            yield parsed[:idx + len(marker)]

                            # ★ 关键：切换 parser 为直通模式 ★
                            # 释放 parser 缓冲区的残留，并入后续去重流程
                            buffered = parser.set_passthrough()

                            # THINK_END 之后的内容 + 缓冲区残留
                            # 都要经过去重流程，不能直接 yield
                            after = parsed[idx + len(marker):] + buffered
                            if after:
                                safe = ""
                                for ch in after:
                                    # 跳过正文开头的空白（换行符等）
                                    if not _prefix and ch.strip() == "":
                                        safe += ch
                                        continue
                                    # 收集前缀指纹
                                    if len(_prefix) < _PREFIX_LEN:
                                        _prefix += ch
                                        safe += ch
                                if safe:
                                    yield safe
                        else:
                            # 还没到 THINK_END，思考内容直接输出
                            yield parsed
                        await asyncio.sleep(0)
                        continue

                    # ========================================
                    # 阶段 B：THINK_END 之后 → 逐字符缓冲去重
                    # ========================================
                    safe_to_yield = ""
                    for ch in parsed:
                        if _stream_stopped:
                            break

                        # ----- B1: 还在收集前缀指纹（<15字符）-----
                        if len(_prefix) < _PREFIX_LEN:
                            if not _prefix and ch.strip() == "":
                                # 正文还没开始，空白字符安全输出
                                safe_to_yield += ch
                                continue
                            _prefix += ch
                            safe_to_yield += ch
                            continue

                        # ----- B2: 前缀已满（≥15字符），增量匹配 -----
                        if _match_cursor == 0 and ch.strip() == "":
                            # 空白字符在匹配开始前 → 可能是两段之间的换行
                            # 不能 yield（如果后面是重复，这些空白也要丢弃）
                            # 也不能丢弃（如果不是重复，这是正常的段落分隔）
                            # 所以放入 pending 缓冲
                            _pending += ch
                        elif ch == _prefix[_match_cursor]:
                            # 字符匹配指纹中的对应位置
                            _match_cursor += 1
                            _pending += ch
                            if _match_cursor >= _PREFIX_LEN:
                                # ★ 匹配满 15 个字符 → 确认是重复！★
                                _stream_stopped = True
                                logger.info(
                                    "流式去重：前缀重现确认 pending=%d",
                                    len(_pending),
                                )
                                break  # 丢弃 pending，停止输出
                        else:
                            # 不匹配 → 这不是重复，是正常的新内容
                            # 释放之前扣住的 pending + 当前字符
                            safe_to_yield += _pending + ch
                            _pending = ""
                            _match_cursor = 0

                    if safe_to_yield:
                        yield safe_to_yield

                await asyncio.sleep(0)

            # ===== 流结束后的清理 =====
            if not _stream_stopped:
                # 没检测到重复 → pending 里的内容是正常的，释放
                if _pending:
                    yield _pending
                remaining = parser.flush()
                if remaining:
                    full_response += remaining
                    yield remaining
            else:
                # 检测到重复 → pending 是重复的开头，丢弃
                # 但 parser 的残留仍需加入 full_response（给 DB 去重用）
                remaining = parser.flush()
                if remaining:
                    full_response += remaining
```

### 去重执行示例（完整 trace）

假设模型流式输出：

```
Token 流：
  "<think>" → "分析..." → "</think>" → "你好！" → "我是专业" → "的风电运维技术助手" → "。"
  → "\n\n" → "你" → "好！我" → "是专业的风电运维技术助手" → "。"
         ↑ 重复从这里开始
```

**执行过程**：

```
① feed("<think>") → parsed = "<<<THINK_START>>>"
   _think_ended = False → 直接 yield "<<<THINK_START>>>"

② feed("分析...") → parsed = "" (被 parser 缓冲，太短)
   → 继续等

③ feed("</think>") → parsed = "分析...<<<THINK_END>>>"
   检测到 MARKER_END！
   yield "分析...<<<THINK_END>>>"
   parser.set_passthrough() → 释放缓冲残留 ""
   _think_ended = True

④ feed("你好！") → parsed = "你好！" (直通模式，零延迟)
   _think_ended = True，进入阶段 B
   B1: _prefix = "" → 收集指纹
   _prefix = "你好！"，safe_to_yield = "你好！"
   yield "你好！"

⑤ feed("我是专业") → _prefix = "你好！我是专业" (8字符，< 15)
   yield "我是专业"

⑥ feed("的风电运维技术助手") → _prefix = "你好！我是专业的风电运维技术助手" (15字符，满了！)
   yield "的风电运维技术助手"

⑦ feed("。") →
   B2: _match_cursor = 0, ch = "。"
   "。" ≠ _prefix[0]("你") → 不匹配
   safe_to_yield = "。"
   yield "。"

⑧ feed("\n\n") →
   B2: _match_cursor = 0, "\n".strip() == "" → 空白
   _pending = "\n\n"
   （注意：不 yield！因为不确定后面是不是重复的开头）

⑨ feed("你") →
   B2: "你" == _prefix[0]("你") → 匹配！
   _match_cursor = 1, _pending = "\n\n你"

⑩ feed("好！我") →
   "好" == _prefix[1]("好") → _match_cursor = 2, _pending += "好"
   "！" == _prefix[2]("！") → _match_cursor = 3, _pending += "！"
   "我" == _prefix[3]("我") → _match_cursor = 4, _pending += "我"

⑪ feed("是专业的风电运维技术助手") →
   "是" == _prefix[4] → cursor = 5
   "专" == _prefix[5] → cursor = 6
   ...
   "助" == _prefix[13] → cursor = 14
   "手" == _prefix[14] → cursor = 15 → ★ 达到 _PREFIX_LEN！★

   _stream_stopped = True
   pending = "\n\n你好！我是专业的风电运维技术助手" → 全部丢弃！
   break

⑫ 后续 token → _stream_stopped = True → 全部 continue，不 yield

结果：前端只看到 "你好！我是专业的风电运维技术助手。" 一份，零重复
```

### 为什么是 15 个字符？

```
太短（5字符）：
  "你好！我是" — 太常见了！正文里可能多次出现 "我是" 这样的短语，导致误判

太长（50字符）：
  用户要等 50 个字符的延迟才能看到正文，体验差

15字符 是平衡点：
  - 中文 15 字符 ≈ 一个完整短句，误判概率极低
  - 延迟只有 15 字符 ≈ 流式输出不到 1 秒
```

### DB 层兜底去重（最后防线）

即使流式去重漏掉了（比如模型没有思考块的场景），`_deduplicate_content()` 在写入 DB 前会再检测一次：

```python
def _deduplicate_content(content: str) -> str:
    """去重模型重复生成的回答段落。

    算法：在文本的 1/3 到 2/3 位置尝试切割，
    如果前半段 == 后半段，说明内容重复了，只保留前半段。

    为什么从 1/3 开始？因为如果是完美重复，切割点应该在 1/2 处。
    但重复可能不完美（多了空白、少了标点），所以搜索范围扩大到 1/3 ~ 2/3。
    """
    text = content.strip()
    if not text:
        return text
    length = len(text)
    for split_pos in range(length // 3, length * 2 // 3):
        first_half = text[:split_pos].strip()
        second_half = text[split_pos:].strip()
        if first_half and second_half and first_half == second_half:
            return first_half
    return text
```

### 双保险架构

```
                  流式输出（前端体验）     DB 存储（数据质量）
                  ─────────────────     ─────────────────
第一道防线        前缀指纹去重            │
（实时拦截）      ↓ 重复被丢弃           │
                  ↓ 干净内容 yield        │
                                         │
第二道防线                                _deduplicate_content()
（兜底清理）                              ↓ 重复段被移除
                                         ↓ 干净内容写入 DB
```

---

## 六、知识点总结

### 1. 流式处理的三条铁律

```
铁律 1：yield 出去的东西收不回来
→ 如果不确定内容是否安全，先缓冲，确认后再 yield

铁律 2：缓冲区的内容不属于任何一方
→ 缓冲区在 parser 和业务逻辑之间，时序竞争是最容易出 bug 的地方
→ 明确谁拥有缓冲区、什么时候释放

铁律 3：流式处理必须用状态机
→ if/else 不够，因为同一个条件可能跨多个 token
→ bool 标记（thinking_started, thinking_ended, _stream_stopped）就是最简单的状态机
```

### 2. Parser 缓冲的本质

```
为什么要缓冲？
→ Token 到达的边界不一定和标签边界对齐
→ "<think>" 可能被拆成 "<thi" + "nk>" 两个 token
→ 必须攒够字符才能判断是不是标签

缓冲多少？
→ len(tag) - 1 个字符
→ "<think>" 有 7 个字符，所以缓冲 6 个
→ 这意味着输出总是延迟 6 个字符

什么时候不需要缓冲？
→ 当你确定不会再出现这个标签时
→ 思考结束后不会再有 <think>
→ 所以 set_passthrough() 关掉缓冲
```

### 3. "前缀指纹"去重技术

```
适用场景：
→ 模型重复生成整段内容（不是个别词重复）
→ 流式输出，不能等完整输出再处理
→ 第二份重复和第一份高度相似（前缀一定相同）

不适用场景：
→ 模型输出部分重复（如某句话说了两遍，但整体不重复）
→ 重复内容和原文差异很大（同义改写）
→ 非流式场景（直接用字符串比较就行）

关键设计：
→ _pending 缓冲区是核心——疑似重复但未确认的内容先存这里
→ 匹配满了 → 确认重复 → 丢弃 pending
→ 不匹配 → 误判 → 释放 pending，用户不感知任何延迟
→ 流结束 → 没匹配满 → 也释放 pending，不丢内容
```

### 4. 多层防御（Defense in Depth）

```
这次修复有三层：

层 1：_stream_chat()     → 正确提取思考内容，正确分离正文
层 2：event_generator()  → 前缀指纹实时拦截重复
层 3：_deduplicate_content() → DB 存储前兜底检查

为什么需要三层？
→ 层 1 解决的是"数据正确性"
→ 层 2 解决的是"用户体验"（流式不重复）
→ 层 3 解决的是"数据质量"（即使前两层漏了，DB 里也是干净的）

每一层独立工作，任何一层失效，其他层仍然能兜底。
这就是工程级代码和玩具代码的区别。
```

### 5. 调试流式系统的方法

```
1. 先用 curl 直接调 API，确认源头数据是否正确
   → 如果源头就有问题，改源头
   → 如果源头没问题，问题在处理链路

2. 在每一层加日志，记录 input → output
   → logger.info("parser input=%r output=%r", raw_token, parsed)
   → 流式系统最怕"看不见"，日志让每一步都可见

3. 不要一次改多层
   → 先修一层，验证，再修下一层
   → 多层同时改了，出了新 bug 不知道是哪层引入的

4. 写最小复现用例
   → 不要用完整 RAG 流程测试
   → 模拟一个简单的 token 流，喂给 parser，看输出对不对
```
