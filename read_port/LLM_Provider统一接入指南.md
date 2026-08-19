# LLM Provider 统一接入指南

> **日期**: 2026-03-23
> **目标**: 将硬编码的 LM Studio 提供商逻辑重构为通用 OpenAI 兼容协议，实现换提供商只改 `.env`、不动代码。

---

## 一、为什么要改？

### 旧架构的问题

旧代码按提供商名称做 `if/else`：

```python
# config.py（旧）
LLM_PROVIDER: str = "lmstudio"  # 可选值: "ollama" | "lmstudio"
LM_STUDIO_BASE_URL: str = "http://localhost:1234/v1"

# rag_service.py（旧）
if settings.LLM_PROVIDER == "lmstudio":
    LlamaSettings.llm = OpenAILike(
        api_base=settings.LM_STUDIO_BASE_URL,
        api_key="lm-studio",  # ← 硬编码，换提供商就废了
        ...
    )
```

**致命问题**：每换一个提供商（NVIDIA、DeepSeek、通义千问），都要：
1. 在 `config.py` 加一组新的配置字段
2. 在 `rag_service.py` 加一个新的 `elif` 分支
3. 在 `_stream_vision` 里再加一个分支

这是 **O(n) 复杂度的坏设计** —— 提供商越多，代码越乱。

### 核心洞察

NVIDIA NIM、DeepSeek、通义千问、LM Studio **全都实现了 OpenAI 的 `/v1/chat/completions` 协议**。它们之间的区别只有 3 个变量：

| 变量 | LM Studio | NVIDIA NIM | DeepSeek | 通义千问 |
|------|-----------|------------|----------|---------|
| `base_url` | `localhost:1234/v1` | `integrate.api.nvidia.com/v1` | `api.deepseek.com/v1` | `dashscope.aliyuncs.com/compatible-mode/v1` |
| `api_key` | `lm-studio`（任意值） | `nvapi-xxx` | `sk-xxx` | `sk-xxx` |
| `model` | `qwen3.5-4b` | `nvidia/llama-4-maverick-17b-128e-instruct` | `deepseek-chat` | `qwen-plus` |

**请求格式完全一样**，不需要按名称分支。

---

## 二、改了什么？（3 个文件）

### 2.1 `app/core/config.py` — 统一配置字段

**旧代码**（按提供商名称分，耦合严重）：

```python
# LLM 提供商配置
LLM_PROVIDER: str = "lmstudio"  # 可选值: "ollama" | "lmstudio"
LM_STUDIO_BASE_URL: str = "http://localhost:1234/v1"
```

**新代码**（按协议分，只有两种）：

```python
################################################# LLM 配置
LLM_MODEL_NAME: str = "qwen3.5:4b"
LLM_IS_VISION_MODEL: bool = False
UPLOAD_DIR: str = "static/uploads"

# LLM 提供商协议: "openai" (NVIDIA/DeepSeek/通义千问/LM Studio) | "ollama"
LLM_PROVIDER: str = "openai"
# OpenAI 兼容配置（所有 /v1/chat/completions 协议的提供商共用）
LLM_API_BASE: str = "http://localhost:1234/v1"
LLM_API_KEY: str = "no-key"
# Ollama 专有配置
OLLAMA_BASE_URL: str = "http://localhost:11434"
OLLAMA_KEEP_ALIVE: str = "1h"
```

**关键变化**：
- `LLM_PROVIDER` 从 `"lmstudio" | "ollama"` → `"openai" | "ollama"`（按协议分，不按产品名分）
- `LM_STUDIO_BASE_URL` → `LLM_API_BASE`（通用名称，任何 OpenAI 兼容提供商共用）
- 新增 `LLM_API_KEY`（旧代码硬编码 `"lm-studio"`，云端 API 需要真实 key）
- 删除 `LM_STUDIO_*` 前缀的所有字段

### 2.2 `app/services/rag_service.py` — LlamaIndex 初始化

**旧代码**：

```python
if settings.LLM_PROVIDER == "lmstudio":
    from llama_index.llms.openai_like import OpenAILike

    LlamaSettings.llm = OpenAILike(
        model=settings.LLM_MODEL_NAME,
        api_base=settings.LM_STUDIO_BASE_URL,
        api_key="lm-studio",              # ← 硬编码
        is_chat_model=True,
        timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
        additional_kwargs={"max_tokens": 8192},
    )
```

**新代码**：

```python
if settings.LLM_PROVIDER == "openai":
    from llama_index.llms.openai_like import OpenAILike

    LlamaSettings.llm = OpenAILike(
        model=settings.LLM_MODEL_NAME,
        api_base=settings.LLM_API_BASE,    # ← 从 .env 读
        api_key=settings.LLM_API_KEY,      # ← 从 .env 读
        is_chat_model=True,
        timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
        additional_kwargs={"max_tokens": 8192},
    )
```

**变化**：`api_base` 和 `api_key` 全部从配置读取，不再硬编码。

### 2.3 `app/services/rag_service.py` — `_stream_vision` 视觉流式请求

这是直接用 `httpx` 调 LLM API 的地方（不走 LlamaIndex，因为 LlamaIndex 不支持 vision 流式）。

**旧代码**：

```python
if settings.LLM_PROVIDER == "lmstudio":
    payload = { ... }
    api_url = f"{settings.LM_STUDIO_BASE_URL}/chat/completions"
# ...
async with httpx.AsyncClient() as client:
    client.stream("POST", api_url, json=payload, timeout=...)
# ...
if settings.LLM_PROVIDER == "lmstudio":
    # 解析 SSE
```

**新代码**（3 处改动）：

```python
# 1. 构建请求 — 加 Authorization header
if settings.LLM_PROVIDER == "openai":
    payload = { ... }
    headers = {"Authorization": f"Bearer {settings.LLM_API_KEY}"}
    api_url = f"{settings.LLM_API_BASE}/chat/completions"

# 2. 发送请求 — 带上 headers
stream_headers = headers if settings.LLM_PROVIDER == "openai" else None
async with httpx.AsyncClient() as client:
    client.stream("POST", api_url, json=payload, headers=stream_headers, timeout=...)

# 3. 解析响应 — 条件判断统一改名
if settings.LLM_PROVIDER == "openai":
    # SSE 格式: data: {"choices": [{"delta": {"content": "..."}}]}
```

**为什么 vision 不走 LlamaIndex？**

LlamaIndex 的 `OpenAILike` 不原生支持 multimodal（图片 + 文本）的流式请求。vision 需要构造 `content: [{type: "text"}, {type: "image_url"}]` 这种多模态 payload，所以直接用 `httpx` 调 OpenAI 兼容 API。

---

## 三、`.env` 配置示例

改完后的 `.env` 只需改 3 行就能切换提供商：

```bash
################################################# LLM 配置
# LLM_PROVIDER: "openai" (NVIDIA/DeepSeek/通义千问/LM Studio 等 OpenAI 兼容) | "ollama"
LLM_PROVIDER="openai"
LLM_API_BASE="https://integrate.api.nvidia.com/v1"
LLM_API_KEY="nvapi-xxxxxxxxxx"
LLM_MODEL_NAME="nvidia/llama-4-maverick-17b-128e-instruct"
LLM_IS_VISION_MODEL=True
```

### 各提供商切换速查

```bash
# ============ NVIDIA NIM ============
LLM_API_BASE="https://integrate.api.nvidia.com/v1"
LLM_API_KEY="nvapi-xxxxxxxxxx"
LLM_MODEL_NAME="nvidia/llama-4-maverick-17b-128e-instruct"

# ============ DeepSeek ============
LLM_API_BASE="https://api.deepseek.com/v1"
LLM_API_KEY="sk-xxxxxxxxxx"
LLM_MODEL_NAME="deepseek-chat"

# ============ 通义千问 ============
LLM_API_BASE="https://dashscope.aliyuncs.com/compatible-mode/v1"
LLM_API_KEY="sk-xxxxxxxxxx"
LLM_MODEL_NAME="qwen-plus"

# ============ LM Studio（本地）============
LLM_API_BASE="http://localhost:1234/v1"
LLM_API_KEY="lm-studio"
LLM_MODEL_NAME="qwen3.5-4b"

# ============ Ollama（私有协议，不是 OpenAI 兼容）============
LLM_PROVIDER="ollama"                    # ← 注意这里要改成 ollama
LLM_MODEL_NAME="qwen3.5:4b"
OLLAMA_BASE_URL="http://localhost:11434"
OLLAMA_KEEP_ALIVE="1h"
```

> **注意**：只有 Ollama 需要改 `LLM_PROVIDER="ollama"`。其他所有提供商都用 `LLM_PROVIDER="openai"`，因为它们都走 OpenAI 兼容协议。

---

## 四、两种协议的本质区别

理解为什么代码里只有 `openai` 和 `ollama` 两个分支：

### OpenAI 兼容协议（`/v1/chat/completions`）

```
请求:
POST https://xxx/v1/chat/completions
Authorization: Bearer sk-xxx
{
  "model": "模型名",
  "messages": [{"role": "user", "content": "你好"}],
  "stream": true
}

流式响应（SSE 格式）:
data: {"choices": [{"delta": {"content": "你"}}]}
data: {"choices": [{"delta": {"content": "好"}}]}
data: [DONE]
```

NVIDIA、DeepSeek、通义千问、LM Studio、OpenAI 本身 **全部用这个格式**。

### Ollama 私有协议（`/api/chat`）

```
请求:
POST http://localhost:11434/api/chat
{
  "model": "qwen3.5:4b",
  "messages": [{"role": "user", "content": "你好"}],
  "stream": true,
  "keep_alive": "1h"
}

流式响应（NDJSON 格式，不是 SSE）:
{"message": {"content": "你"}, "done": false}
{"message": {"content": "好"}, "done": false}
{"message": {"content": ""}, "done": true}
```

Ollama 用自己的格式，所以需要单独一个分支。

### Vision（多模态）请求差异

```
OpenAI 兼容:
"content": [
  {"type": "text", "text": "图中有什么？"},
  {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/..."}}
]

Ollama:
"content": "图中有什么？",
"images": ["/9j/..."]                    # ← 单独字段，不在 content 里
```

---

## 五、代码执行流全链路

```
用户发送消息
    ↓
chat.py → rag_service.py
    ↓
判断 LLM_PROVIDER
    ├── "openai" ─────────────────────────────────────┐
    │   ├── LlamaIndex: OpenAILike(api_base, api_key) │ ← 文本 RAG 对话
    │   └── httpx: POST {LLM_API_BASE}/chat/completions │ ← Vision 多模态
    │       ├── Authorization: Bearer {LLM_API_KEY}      │
    │       ├── 解析 SSE: data: {choices[0].delta}       │
    │       └── 处理 reasoning_content（思考链）          │
    │                                                     │
    └── "ollama" ─────────────────────────────────────┐
        ├── LlamaIndex: Ollama(base_url)              │ ← 文本 RAG 对话
        └── httpx: POST {OLLAMA_BASE_URL}/api/chat    │ ← Vision 多模态
            ├── 无需 Authorization                     │
            ├── 解析 NDJSON: {message.content}         │
            └── 检查 {done: true} 结束                 │
```

---

## 六、LM Studio 到 NVIDIA 的完整迁移步骤

### 步骤 1：注册并获取 API Key

访问 [build.nvidia.com](https://build.nvidia.com)，登录后点击 "Manage API Keys"，生成一个以 `nvapi-` 开头的 key。

### 步骤 2：修改 `.env`

```bash
LLM_PROVIDER="openai"
LLM_API_BASE="https://integrate.api.nvidia.com/v1"
LLM_API_KEY="nvapi-你的key"
LLM_MODEL_NAME="nvidia/llama-4-maverick-17b-128e-instruct"
LLM_IS_VISION_MODEL=true
```

### 步骤 3：重启后端

```bash
# 终止旧进程
# 重新启动 FastAPI
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# 如果用了 arq worker，也要重启
python -m arq app.worker.WorkerSettings
```

### 步骤 4：验证

打开前端对话页面，发一条消息。查看后端日志应该看到：

```
LLM 初始化完成: provider=openai api_base=https://integrate.api.nvidia.com/v1 model=nvidia/llama-4-maverick-17b-128e-instruct
```

### 注意事项

- NVIDIA NIM API 有速率限制（免费层约 40 req/min），生产环境需要付费计划
- 云端 API 的延迟比本地 LM Studio 高（网络往返），`RAG_OLLAMA_REQUEST_TIMEOUT_S` 可能需要调大
- 不是所有 NVIDIA 模型都支持 vision（多模态），确认模型支持 `image_url` 输入
- `.env` 中的 `LLM_API_KEY` 是敏感信息，确保 `.gitignore` 包含 `.env`

---

## 七、设计原则总结

| 原则 | 体现 |
|------|------|
| **按协议分，不按产品名分** | `"openai" \| "ollama"` 而不是 `"lmstudio" \| "nvidia" \| "deepseek" \| ...` |
| **配置驱动，代码不变** | 换提供商只改 `.env` 的 3 个变量 |
| **O(1) 扩展** | 新增 OpenAI 兼容提供商 = 0 行代码改动 |
| **敏感信息外置** | API Key 走环境变量，不硬编码 |


curl -s https://integrate.api.nvidia.com/v1/chat/completions \
    -H "Authorization: Bearer api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "qwen/qwen3.5-122b-a10b",
      "messages": [{"role": "user", "content": "你好"}],
      "max_tokens": 50
    }'

curl -s https://integrate.api.nvidia.com/v1/chat/completions \
    -H "Authorization: Bearer api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "qwen/qwen3.5-122b-a10b",
      "messages": [{"role": "user", "content": "1+1等于几？请详细推理"}],
      "max_tokens": 4096,
      "stream": false,
      "temperature": 0.6,
      "chat_template_kwargs": {"enable_thinking": true}
    }'