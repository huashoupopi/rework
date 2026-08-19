# LM Studio 迁移指南

## 背景

由于 Ollama 暂不支持 Qwen3.5 视觉模型，可以临时切换到 LM Studio 来使用你下载的 `Qwen3.5-4B-Q4_K_M.gguf` 和 `mmproj-F16.gguf`。

---

## 一、LM Studio 配置

### 1. 下载并安装 LM Studio
- 官网：https://lmstudio.ai/
- 支持 macOS/Windows/Linux

### 2. 加载 Qwen3.5 视觉模型

#### 方法 A：通过 UI 加载（推荐）
1. 打开 LM Studio
2. 点击左侧 "Local Models"
3. 点击 "Load a model from disk"
4. 选择你的模型文件：
   - **Language Model**: `/Users/liuchenxu/Documents/Documents/code/rework/backend/models/unsloth/Qwen3___5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf`
   - **Vision Projector**: `/Users/liuchenxu/Documents/Documents/code/rework/backend/models/unsloth/Qwen3___5-4B-GGUF/mmproj-F16.gguf`

#### 方法 B：手动配置
1. 将模型文件复制到 LM Studio 的模型目录：
   - macOS: `~/.cache/lm-studio/models/`
   - Windows: `%USERPROFILE%\.cache\lm-studio\models\`
2. 在 LM Studio 中刷新模型列表

### 3. 启动本地服务器
1. 在 LM Studio 中点击 "Local Server" 标签
2. 选择加载的 Qwen3.5 模型
3. 配置参数：
   - **Port**: 1234（默认）
   - **Context Length**: 8192
   - **GPU Offload**: 根据你的硬件调整
4. 点击 "Start Server"
5. 确认服务运行在 `http://localhost:1234`

---

## 二、代码修改

### 1. 环境变量配置（`.env`）

```bash
# LM Studio 配置
LLM_PROVIDER=lmstudio  # 新增：标识使用 LM Studio
LM_STUDIO_BASE_URL=http://localhost:1234/v1  # LM Studio API 端点
LLM_MODEL_NAME=qwen3.5-4b-vision  # 模型名称（可自定义）
LLM_IS_VISION_MODEL=True  # 启用视觉功能

# 保留 Ollama 配置（备用）
# OLLAMA_BASE_URL=http://localhost:11434
# OLLAMA_KEEP_ALIVE=5m
```

### 2. 修改 `app/core/config.py`

在 `Settings` 类中添加：

```python
class Settings(BaseSettings):
    # ... 现有配置 ...

    # LLM 提供商配置
    LLM_PROVIDER: str = "ollama"  # 可选值: "ollama" | "lmstudio"
    LM_STUDIO_BASE_URL: str = "http://localhost:1234/v1"

    # Ollama 配置（保留）
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    OLLAMA_KEEP_ALIVE: str = "5m"
```

### 3. 修改 `app/services/rag_service.py`

#### 3.1 修改 `initialize()` 方法

```python
@classmethod
async def initialize(cls) -> None:
    if cls._initialized:
        return
    async with cls._init_lock:
        if cls._initialized:
            return

        logger.info("初始化RAG服务...")
        try:
            LlamaSettings.embed_model = HuggingFaceEmbedding(model_name="BAAI/bge-m3")

            # 根据 LLM_PROVIDER 选择不同的 LLM
            if settings.LLM_PROVIDER == "lmstudio":
                from llama_index.llms.openai_like import OpenAILike

                LlamaSettings.llm = OpenAILike(
                    model=settings.LLM_MODEL_NAME,
                    api_base=settings.LM_STUDIO_BASE_URL,
                    api_key="lm-studio",  # LM Studio 不需要真实 key
                    timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
                    additional_kwargs={"max_tokens": 8192},
                )
            else:
                # 原有 Ollama 配置
                LlamaSettings.llm = Ollama(
                    model=settings.LLM_MODEL_NAME,
                    base_url=settings.OLLAMA_BASE_URL,
                    request_timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
                    keep_alive=settings.OLLAMA_KEEP_ALIVE,
                    additional_kwargs={"num_ctx": 8192},
                )

            # ... 其余代码不变 ...
```

#### 3.2 修改 `_stream_vision()` 方法

```python
@classmethod
async def _stream_vision(
    cls, prompt: str, image_paths: list[str], t0: float
) -> AsyncGenerator[str, None]:
    images_b64: list[str] = []
    for image_path in image_paths:
        image_bytes = Path(image_path).read_bytes()
        images_b64.append(base64.b64encode(image_bytes).decode("utf-8"))
        logger.info(
            "vision 图片已编码 path=%s size_kb=%.1f", image_path, len(image_bytes) / 1024
        )

    # 根据 LLM_PROVIDER 选择不同的 API 格式
    if settings.LLM_PROVIDER == "lmstudio":
        # LM Studio 使用 OpenAI 兼容格式
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
        api_url = f"{settings.LM_STUDIO_BASE_URL}/chat/completions"
    else:
        # Ollama 格式（原有代码）
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

    async with (
        httpx.AsyncClient() as client,
        client.stream(
            "POST",
            api_url,
            json=payload,
            timeout=settings.RAG_OLLAMA_REQUEST_TIMEOUT_S,
        ) as resp,
    ):
        async for line in resp.aiter_lines():
            if not line:
                continue

            # LM Studio 返回格式：data: {...}
            if settings.LLM_PROVIDER == "lmstudio":
                if line.startswith("data: "):
                    line = line[len("data: "):]  # 去掉 "data: " 前缀
                if line == "[DONE]":
                    break
                if not line:  # 跳过空行，避免 json.loads("") 报错
                    continue

                data = json.loads(line)
                token = data.get("choices", [{}])[0].get("delta", {}).get("content", "")
            else:
                # Ollama 格式（原有代码）
                data = json.loads(line)
                token = data.get("message", {}).get("content", "")

            if token:
                if first_token:
                    ttfb_ms = (time.perf_counter() - t0) * 1000
                    logger.info("rag stage=ttfb ms=%.1f mode=vision", ttfb_ms)
                    first_token = False
                yield token

            # Ollama 的 done 检查
            if settings.LLM_PROVIDER == "ollama" and data.get("done"):
                break
```

---

## 三、验证步骤

### 1. 确认 LM Studio 服务运行
```bash
curl http://localhost:1234/v1/models
```

预期输出：
```json
{
  "data": [
    {
      "id": "qwen3.5-4b-vision",
      "object": "model",
      ...
    }
  ]
}
```

### 2. 测试视觉能力
```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.5-4b-vision",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "描述这张图片"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<base64_string>"}}
        ]
      }
    ]
  }'
```

### 3. 修改配置并重启服务
```bash
cd backend

# 修改 .env
cat >> .env << 'EOF'
LLM_PROVIDER=lmstudio
LM_STUDIO_BASE_URL=http://localhost:1234/v1
LLM_MODEL_NAME=qwen3.5:4b
LLM_IS_VISION_MODEL=True
EOF

# 重启
source venv/bin/activate
uvicorn app.main:app --reload
```

### 4. Apifox 测试
- 上传图片 + 提问
- 检查日志中的 `vision 图片已编码` 和 `rag stage=ttfb mode=vision`
- 确认返回结果包含图片描述

---

## 四、常见问题

### Q1: LM Studio 不支持 mmproj 文件？
**A**: 检查 LM Studio 版本（需要 0.2.9+），或者尝试：
1. 在 LM Studio UI 中手动选择 projector 文件
2. 查看 LM Studio 日志确认是否加载成功

### Q2: 视觉功能不工作？
**A**: 检查：
1. LM Studio 是否正确加载了 mmproj 文件
2. API 请求格式是否正确（OpenAI 兼容格式）
3. 图片 base64 编码是否正确

### Q3: 性能比 Ollama 慢？
**A**: 调整 LM Studio 参数：
- 增加 GPU Offload 层数
- 减少 Context Length（如果不需要长上下文）
- 使用更小的量化版本（Q4_K_M 已经是较小的）

### Q4: 想切换回 Ollama？
**A**: 修改 `.env`：
```bash
LLM_PROVIDER=ollama
LLM_MODEL_NAME=qwen2.5vl:7b  # 或其他 Ollama 支持的模型
LLM_IS_VISION_MODEL=True
```

---

## 五、性能对比

| 指标 | Ollama | LM Studio |
|------|--------|-----------|
| 启动速度 | 快 | 中等 |
| API 兼容性 | Ollama 专有 | OpenAI 兼容 |
| 视觉模型支持 | Qwen2.5-VL | Qwen3.5-VL（需验证） |
| GPU 加速 | 自动 | 手动配置 |
| 社区支持 | 活跃 | 活跃 |

---

## 六、回滚方案

如果 LM Studio 不满足需求，可以快速回滚到 Ollama + Qwen2.5-VL：

```bash
# 1. 拉取 Qwen2.5-VL
ollama pull qwen2.5vl:7b

# 2. 修改 .env
cat > backend/.env << 'EOF'
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
LLM_MODEL_NAME=qwen2.5vl:7b
LLM_IS_VISION_MODEL=True
EOF

# 3. 重启服务
cd backend
source venv/bin/activate
uvicorn app.main:app --reload
```

---

## 七、总结

**优势**：
- ✅ 可以使用你下载的 Qwen3.5-4B 视觉模型
- ✅ OpenAI 兼容 API，便于后续迁移
- ✅ UI 友好，便于调试

**劣势**：
- ❌ 需要手动配置 GPU 加速
- ❌ 需要修改代码（但改动不大）
- ❌ LM Studio 对 Qwen3.5 视觉模型的支持需要验证

**建议**：
1. 先在 LM Studio 中测试 Qwen3.5 视觉模型是否能正常加载
2. 如果不行，回滚到 Ollama + Qwen2.5-VL（最稳定）
3. 等待 Ollama 官方支持 Qwen3.5-VL（长期方案）
