# LM Studio 推理模型聊天 Bug 修复记录

> 日期：2026-03-22
> 涉及文件：`rag_service.py`、`stream_parser.py`、`chat.py`
> 模型：qwen3.5-4b（通过 LM Studio 运行）

---

## 一、Bug 表现

用户使用 LM Studio 推理模型进行聊天时，出现三个问题：

1. **输出被截断** — 回答不完整
2. **没有思考框** — 前端看不到模型的推理过程
3. **没有参考文献框** — RAG 检索到的来源未展示

服务端日志还显示请求的是 `POST /v1/completions`（文本补全 API），而非 `POST /v1/chat/completions`（对话 API）。

---

## 二、根因分析（三个独立问题）

### 问题 1：API 端点错误 → 输出截断

```
根因：LlamaIndex 的 OpenAILike 类默认 is_chat_model=False
```

`OpenAILike` 是 LlamaIndex 提供的兼容 OpenAI API 的 LLM 适配器。它有一个关键参数 `is_chat_model`：

| `is_chat_model` 值 | 调用的端点 | 适用场景 |
|---|---|---|
| `False`（默认） | `/v1/completions` | 纯文本补全（GPT-3 风格） |
| `True` | `/v1/chat/completions` | 对话模型（ChatGPT 风格） |

LM Studio 的推理模型是**对话模型**，但 `OpenAILike` 默认值是 `False`，导致请求走了错误的端点。`/v1/completions` 不支持 system/user/assistant 角色结构，模型收到的提示格式不对，所以输出被截断或不完整。

### 问题 2：reasoning_content 字段未读取 → 没有思考框

```
根因：_stream_chat 没有处理 Chat API 特有的 reasoning_content 字段
```

LM Studio 的推理模型通过 Chat Completions API 返回思考过程时，**不是**把 `<think>...</think>` 标签嵌在 `content` 里，而是放在一个**独立字段** `reasoning_content` 中：

```json
// LM Studio Chat API 的流式响应 chunk
{
  "choices": [{
    "delta": {
      "reasoning_content": "让我分析一下这个问题...",  // ← 思考内容
      "content": ""                                      // ← 正文（思考阶段为空）
    }
  }]
}
```

LlamaIndex 的 `_astream_chat` 方法会把 `reasoning_content` 放到 `chunk.additional_kwargs["thinking_delta"]` 中。但我们原来的 `_stream_chat` 方法只读了 `chunk.delta`（正文），完全忽略了 `thinking_delta`，所以思考内容丢失。

### 问题 3：模型重复生成 → 连带影响 Sources 展示

```
根因：qwen3.5-4b 小模型在复杂提示词下的行为缺陷
```

经过深入调查，确认：

1. **LM Studio 对话模板**（Jinja2 + `enable_thinking=true`）✅ 标准 Qwen 模板，无问题
2. **LM Studio API** ✅ 直接调用（streaming / non-streaming）均无内容重复
3. **LlamaIndex 流式代码** ✅ `chunk.delta`（增量）和 `chunk.message.content`（累积）设计正确，不会重复
4. **模型行为** ⚠️ qwen3.5-4b（4B 参数）在 LlamaIndex 注入 RAG 上下文 + 系统指令 + 对话历史后，提示词变得复杂，触发了模型的**重复生成行为**

这是小参数模型在处理长/复杂提示时的已知局限。模型在生成完一段完整回答后，会紧接着重复生成一份几乎相同的回答。这导致：

- 流式输出中用户看到两份重复的答案
- 原来为了"截断重复"而做的粗暴处理，误伤了后面的 `<<<SOURCES>>>` 标记

> **验证方法**：用 `curl` 直接调用 LM Studio 的 `/v1/chat/completions`，设置 `max_tokens=8192`，发送相同问题，响应 `finish_reason: "stop"`，内容零重复。证明重复不是 API 或模板层面的问题。

---

## 三、修复方案

### 修复 1：设置 `is_chat_model=True`

**文件**：`app/services/rag_service.py`（LLM 初始化处）

```python
LlamaSettings.llm = OpenAILike(
    model=settings.LLM_MODEL_NAME,
    api_base=settings.LM_STUDIO_BASE_URL,
    api_key="lm-studio",
    is_chat_model=True,  # ← 关键：使用 Chat Completions API
    timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
    additional_kwargs={"max_tokens": 8192},
)
```

**效果**：LlamaIndex 改为调用 `/v1/chat/completions`，正确传递 system/user/assistant 消息结构。

### 修复 2：读取 reasoning_content 并包装为 think 标签

**文件**：`app/services/rag_service.py`（`_stream_chat` 方法）

```python
@classmethod
async def _stream_chat(cls, messages, t0):
    thinking_started = False
    thinking_ended = False

    response_gen = await LlamaSettings.llm.astream_chat(messages)
    async for chunk in response_gen:
        # 读取 LlamaIndex 传递的 reasoning_content
        thinking_delta = (
            chunk.additional_kwargs.get("thinking_delta", "")
            if chunk.additional_kwargs else ""
        )
        if thinking_delta and not thinking_ended:
            if not thinking_started:
                thinking_started = True
                yield "<think>"       # ← 注入开始标签
            yield thinking_delta
            continue
        elif thinking_started and not thinking_ended:
            thinking_ended = True
            yield "</think>"          # ← 注入结束标签

        # 正文内容正常 yield
        token = getattr(chunk, "delta", None) or ""
        ...
        yield token
```

**数据流**：

```
LM Studio API → reasoning_content → LlamaIndex additional_kwargs["thinking_delta"]
    → _stream_chat yield "<think>..thinking..</think>"
    → ThinkStreamParser 转换为 <<<THINK_START>>>..<<<THINK_END>>>
    → 前端渲染为折叠思考框
```

### 修复 3：缓冲式前缀指纹去重（流式 + DB 双保险）

这是最复杂的修复，解决模型重复生成整段回答的问题。

#### 3.1 核心思路

在 `<<<THINK_END>>>` 之后，捕获正文开头 15 个字符作为**前缀指纹**。后续每个新字符到达时，与指纹进行**增量匹配**：

- 匹配上 → 放入缓冲区，不 yield 给前端
- 完整匹配满 15 字符 → 确认是重复，停止输出
- 不匹配 → 释放缓冲区，正常 yield

```
正文: "你好！我是专业的风电运维技术助手。...欢迎随时提问。"
前缀: "你好！我是专业的风电运维技术助手"  (15字符)

模型输出第二遍: "\n\n你好！我是专业的..."
                    ↑ 开始匹配前缀 → 缓冲
                                    ↑ 匹配满15字符 → 确认重复，停止
```

#### 3.2 Parser Passthrough 模式（消除尾部泄漏）

**文件**：`app/utils/stream_parser.py`

`ThinkStreamParser` 在非思考模式下会缓冲 6 个字符（`len("<think>") - 1 = 6`）来检测 `<think>` 标签。但思考块结束后，不会再出现 `<think>`，这个缓冲是多余的，反而会导致第一份回答的最后 6 个字符延迟释放——当第二份重复开始时才被推出，造成**尾部泄漏**。

修复：思考块结束后，切换 parser 为**直通模式**：

```python
def set_passthrough(self) -> str:
    """思考块结束后停止标签检测，释放缓冲区。"""
    remaining = self._buffer
    self._buffer = ""
    self._passthrough = True
    return remaining

def feed(self, token: str) -> str:
    if self._passthrough:
        return token  # ← 直通，零延迟
    # ... 正常标签检测逻辑
```

#### 3.3 完整去重流程（`event_generator` 中）

**文件**：`app/routers/chat.py`

```
Token 到达
  │
  ├─ THINK_END 之前？ → 直接 yield（含思考标记）
  │
  ├─ 包含 THINK_END？ → yield 标记，调用 parser.set_passthrough()
  │                       释放缓冲区，开始收集前缀指纹
  │
  ├─ THINK_END 之后：逐字符处理
  │   ├─ 前缀未满（<15字符）？ → 加入前缀，yield
  │   ├─ 空白字符且未开始匹配？ → 放入 pending（可能是段落分隔符）
  │   ├─ 字符 == prefix[cursor]？ → pending++，cursor++
  │   │   └─ cursor == 15？ → 确认重复！丢弃 pending，停止输出
  │   └─ 不匹配？ → 释放 pending，重置 cursor，正常 yield
  │
  ├─ <<<SOURCES>>> 标记？ → 始终 yield（不受去重影响）
  │
  └─ _stream_stopped？ → 继续消费但不 yield
```

#### 3.4 DB 层去重（兜底）

即使流式去重未生效（如无思考块的场景），`_deduplicate_content()` 在存入数据库前仍会检测并移除重复：

```python
def _deduplicate_content(content: str) -> str:
    text = content.strip()
    length = len(text)
    for split_pos in range(length // 3, length * 2 // 3):
        if text[:split_pos].strip() == text[split_pos:].strip():
            return text[:split_pos].strip()  # 保留第一份
    return text
```

---

## 四、验证结果

### 测试 1：普通问候

```bash
curl -X POST /api/chat/stream -F "question=你好，请简单介绍一下你自己"
```

| 检查项 | 修复前 | 修复后 |
|--------|--------|--------|
| 思考框 | ❌ 无 | ✅ `<<<THINK_START>>>...<<<THINK_END>>>` |
| 内容重复 | ❌ 完整回答出现两遍 | ✅ 零重复 |
| DB 存储 | ❌ 含重复 | ✅ 干净 |

### 测试 2：RAG 问题（surface_oil是什么？）

| 检查项 | 修复前 | 修复后 |
|--------|--------|--------|
| 思考框 | ❌ 无 | ✅ 完整推理过程 |
| 参考文献 | ❌ 被截断 | ✅ 4个来源完整展示 |
| 内容重复 | ❌ 两遍 | ✅ 零重复 |
| DB 存储 | ❌ 含重复 | ✅ 179字符，干净 |

---

## 五、经验总结

### 关键教训

1. **`is_chat_model` 默认值陷阱**：LlamaIndex 的 `OpenAILike` 默认 `is_chat_model=False`，这对 LM Studio 等兼容 OpenAI API 的本地推理服务来说是**错误的默认值**。务必显式设置为 `True`。

2. **reasoning_content 是独立字段**：推理模型的思考过程不在 `content` 里，而是在 `reasoning_content`（API 层）→ `additional_kwargs["thinking_delta"]`（LlamaIndex 层）。这和 Ollama 的 `<think>` 标签方案完全不同。

3. **流式去重不能"先 yield 再检查"**：重复内容一旦 yield 就无法收回。必须**先缓冲、确认安全后再 yield**。代价只是 15 字符的微小延迟。

4. **Parser 缓冲区在思考结束后应清空**：`ThinkStreamParser` 为检测 `<think>` 标签保留 6 字符缓冲。思考结束后这个缓冲是多余的，会导致内容延迟释放，与去重逻辑产生竞争条件。`set_passthrough()` 方法彻底解决了这个问题。

### 架构图

```
用户提问
  ↓
RagService.generate_chat_stream()
  ↓
_stream_chat() ─── astream_chat() ──→ LM Studio /v1/chat/completions
  │                                          │
  │  ← reasoning_content (thinking_delta)  ←─┘
  │  → yield "<think>..思考内容..</think>"
  │  ← content (delta)                    ←─┘
  │  → yield "正文内容"
  ↓
ThinkStreamParser.feed()
  │  "<think>"  → "<<<THINK_START>>>"
  │  "</think>" → "<<<THINK_END>>>"
  │  set_passthrough() → 之后直通
  ↓
event_generator() 去重逻辑
  │  捕获前缀指纹（15字符）
  │  增量匹配 → 检测重复 → 停止输出
  ↓
StreamingResponse → 前端
  │  思考框 ✅
  │  干净内容 ✅
  │  参考文献 ✅
  ↓
DB 存储（_deduplicate_content 兜底）
```

---

## 六、深入根因调查：内容重复从哪来？

### 调查过程

为排查重复生成的根因，逐层验证了整个数据链路：

#### 1. LM Studio 对话模板 → ✅ 无问题

项目使用的是标准 Qwen Jinja2 模板，`enable_thinking = true`。模板结构完全正确：
- 正确处理 system / user / assistant 角色
- `<|im_start|>assistant\n<think>\n` 的生成提示符正确
- 不存在会导致重复的模板逻辑

#### 2. LM Studio API 直接调用 → ✅ 无重复

```bash
# 非流式测试
curl -s http://localhost:1234/v1/chat/completions \
  -d '{"model":"qwen3.5-4b","messages":[{"role":"user","content":"1+1=?"}],"max_tokens":8192}'

# 结果：finish_reason: "stop"，content: "1+1=2"，零重复

# 流式测试
curl -N http://localhost:1234/v1/chat/completions \
  -d '{"model":"qwen3.5-4b","messages":[...],"stream":true,"max_tokens":8192}'

# 结果：所有 content chunk 干净，无重复
```

即使加入 system prompt，直接 API 调用也完全不重复。

#### 3. LlamaIndex `_astream_chat` 源码 → ✅ 无 Bug

深入阅读了 LlamaIndex 的流式实现（`llama_index/llms/openai/base.py`）：

```python
# 每个 yield 的 ChatResponse 结构：
ChatResponse(
    message=ChatMessage(blocks=[
        ThinkingBlock(content=reasoning_content),  # 累积的完整思考
        TextBlock(text=content),                    # 累积的完整内容
    ]),
    delta=content_delta,  # ← 仅当前 chunk 的增量，不是累积值
)
```

关键发现：
- `chunk.delta` = **仅当前 chunk 的增量**（用于流式输出）
- `chunk.message.content` = **累积的完整内容**（用于状态快照）
- 两者设计上就不会产生重复
- `reasoning_content` 和 `content` 完全分离在不同的 Block 中

#### 4. 我们的 `_stream_chat` → ✅ 无 Bug

```python
token = getattr(chunk, "delta", None) or ""      # 优先读增量
if not token:
    # 回退：从累积内容中提取新增部分
    current = getattr(msg, "content", "") or ""
    if len(current) > last_content_len:
        token = current[last_content_len:]        # 只取新增的部分
        last_content_len = len(current)
```

回退逻辑通过 `last_content_len` 跟踪已处理长度，只提取真正的增量，不会重复。

### 最终结论

| 层级 | 是否有 Bug | 说明 |
|------|-----------|------|
| LM Studio 对话模板 | ✅ 正确 | 标准 Qwen 模板 |
| LM Studio API | ✅ 正常 | 直接调用零重复 |
| LlamaIndex 流式代码 | ✅ 正常 | delta/content 设计正确 |
| 我们的 `_stream_chat` | ✅ 正常 | 回退逻辑安全 |
| **qwen3.5-4b 模型** | ⚠️ 条件触发 | 在复杂提示下重复 |

**根因**：qwen3.5-4b 是 4B 参数的小模型。当 LlamaIndex 注入 RAG 检索上下文 + 系统指令 + 对话历史后，提示词变得冗长复杂，超出了小模型的稳定处理能力，触发了重复生成行为。这不是任何代码层面的 bug，而是**小模型 + 复杂提示**的组合导致的模型行为退化。

**应对策略**：
1. ✅ 流式前缀指纹去重（已实现）— 实时拦截重复
2. ✅ DB 层 `_deduplicate_content()` 兜底 — 确保存储干净
3. 📌 未来可考虑升级到更大参数的模型（如 7B+）以从根本上减少重复倾向
