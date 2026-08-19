# Day 12：前端 RAG 流式聊天 + Think 折叠展示

> 目标：实现流式聊天界面——fetch + ReadableStream 读取 SSE、Think 标记实时解析、消息列表自动滚动、停止生成、聊天历史加载
> 这是前端**最核心、面试最高频**的模块
> 预计文件数：7 个新建 + 2 个修改
> 验证工具：浏览器 + 后端 API

---

## 前置准备

Day 12 开始之前确保：
- Day 10 完成（前端项目搭建、Axios 封装、登录注册、路由守卫）
- Day 11 完成（任务列表、上传检测、任务详情页基本结构）
- 后端 Day 5~6 API 正常（POST /api/chat/stream 能返回流式响应）
- 已安装必要前端依赖：

```bash
cd frontend

# Day 10 已安装的基础依赖
pnpm add react-router-dom zustand axios

# Day 12 需要的额外依赖
pnpm add react-markdown        # Markdown 渲染（助手回复经常包含 markdown）
pnpm add lucide-react           # 图标库（Day 10 shadcn/ui 已带）
# 不需要额外安装流式相关库 — 浏览器原生 fetch + ReadableStream 就够
```

---

## 整体架构（先画在纸上再写代码）

```
聊天页面组件树：

ChatPage / TaskDetailPage
├── MessageList                    <- 消息列表（可滚动区域）
│   ├── UserMessage                <- 用户消息（右对齐蓝色气泡）
│   └── AssistantMessage           <- 助手消息
│       ├── ThinkBlock             <- 思考过程（可折叠）
│       ├── Markdown Content       <- 正文（Markdown 渲染）
│       └── StreamingCursor        <- 流式输出光标（▊ 闪烁）
├── ChatInput                      <- 输入区域
│   ├── TextArea                   <- 输入框（Shift+Enter 换行，Enter 发送）
│   └── SendButton / StopButton    <- 发送/停止按钮
└── useStreamChat (Hook)           <- 核心逻辑：流式请求 + Think 解析 + 状态管理
```

```
数据流：

用户输入 question
    |
[1] useStreamChat.sendMessage(question)
    |
[2] 添加 user message 到 messages 数组
    |
[3] 创建空 assistant message 占位（isStreaming=true）
    |
[4] fetch POST /api/chat/stream（带 AbortController）
    |
[5] response.body.getReader() 获取 ReadableStream Reader
    |
[6] while loop: reader.read() 逐 chunk 读取
    |
[7] TextDecoder 解码 Uint8Array → 字符串
    |
[8] 解析 SSE 格式：提取 data: 行的内容
    |
[9] Think 标记解析：分离 thinkContent 和 content
    |
[10] setMessages 更新最后一条 assistant message
    |
[11] 流结束 → isStreaming=false
```

### 为什么不用 EventSource？

```
EventSource（SSE 原生 API）的限制：
  1. 只支持 GET 请求 — 聊天需要 POST + JSON Body
  2. 不能自定义 Header — 无法带 Authorization: Bearer token
  3. 不能手动关闭流 — 没有 AbortController 概念

fetch + ReadableStream 的优势：
  1. POST 请求 + JSON Body ✅
  2. 自定义 Header（Authorization）✅
  3. AbortController 手动中止 ✅
  4. 浏览器原生 API，不需要第三方库 ✅

面试话术：
  "EventSource 只支持 GET 请求，无法携带 JSON Body 和 Authorization Header。
   所以用 fetch + ReadableStream 手动读取 SSE 流，
   配合 AbortController 实现用户主动停止生成。"
```

---

## Step 1：`src/types/chat.ts` — 聊天相关类型定义

**完整代码**：

```typescript
// src/types/chat.ts

/** 参考文献来源 */
export interface Source {
  id: number;
  doc: string;                  // 来源文档名
  score: number | null;         // Reranker 相关性分数
  snippet: string;              // 内容摘要（前 100 字）
  page?: number;                // 页码（PDF 来源有）
}

/** 单条聊天消息 */
export interface ChatMessage {
  id?: number;                  // 数据库 ID（历史消息有，流式生成中的没有）
  role: "user" | "assistant";
  content: string;              // 正文内容
  image?: string;               // 上传的图片文件名（仅 user 消息，历史消息有）
  imagePreview?: string;        // 本地图片预览 URL（ObjectURL，仅当前会话中上传时有）
  thinkContent?: string;        // 思考过程（仅 assistant）
  sources?: Source[];            // 参考文献（仅 assistant，RAG 路由时有）
  isStreaming?: boolean;         // 是否正在流式输出中（仅 assistant）
  created_at?: string;          // ISO 时间戳（历史消息有）
}

/** 发送聊天的请求体 */
export interface ChatRequest {
  question: string;
  task_id?: number;             // 关联任务（可选）
}

/** 历史消息的分页响应（Cursor 分页） */
export interface ChatHistoryResponse {
  items: ChatMessage[];
  next_cursor: number | null;   // 下一页起始 ID，null 表示没有更多
}
```

**你需要回答自己的问题**：

1. **为什么 `id` 是可选的？**
   - 流式生成中的消息还没存入数据库，没有 ID
   - 流结束后后端会返回 `msg_id`，但前端不一定需要
   - 历史消息从后端加载时有 ID

2. **`isStreaming` 有什么用？**
   - 控制 UI 渲染：`isStreaming=true` 时显示闪烁光标 `▊`
   - 控制 ThinkBlock：流式中自动展开思考过程，完成后自动折叠
   - 防止用户在流式输出中重复发送消息

---

## Step 2：`src/utils/sseParser.ts` — SSE 流解析器

**完整代码**：

```typescript
// src/utils/sseParser.ts
/**
 * SSE（Server-Sent Events）流解析器。
 *
 * 后端返回的是标准 SSE 格式：
 *   data: 这是第一个 chunk\n\n
 *   data: 这是第二个 chunk\n\n
 *   data: [DONE]\n\n
 *
 * 为什么需要解析器？
 *   - fetch 返回的是原始字节流，不是按 SSE 事件分割的
 *   - 一次 reader.read() 可能返回多个事件，也可能返回半个事件
 *   - 需要缓冲区来正确分割 SSE 事件
 *
 * 面试点："SSE 是基于 HTTP 的文本协议，每个事件以 \\n\\n 分隔。
 *          但 TCP 是流式传输，不保证按事件边界送达，
 *          所以需要缓冲区做断帧处理。"
 */

/**
 * 从 SSE 格式的原始文本中提取 data 内容。
 *
 * 输入示例：
 *   "data: hello\n\ndata: world\n\n"
 *
 * 输出：
 *   ["hello", "world"]
 *
 * 为什么不直接用 fullText.split？
 *   - SSE 事件可能跨越多次 read()
 *   - "data: hel" + "lo\n\ndata: world\n\n" 要正确处理
 *   - 用缓冲区累积，按 \n\n 分割
 */
export function extractSSEData(raw: string): string[] {
  const results: string[] = [];
  const events = raw.split("\n\n");

  for (const event of events) {
    const trimmed = event.trim();
    if (!trimmed) continue;

    for (const line of trimmed.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6); // "data: " 是 6 个字符
        if (data === "[DONE]") continue; // 流结束标记，跳过
        results.push(data);
      }
    }
  }

  return results;
}

/**
 * 增量式 SSE 解析器（处理跨 chunk 的事件）
 *
 * 用法：
 *   const parser = createSSEParser();
 *   // 每次 reader.read() 后
 *   const tokens = parser.feed(decodedChunk);
 *   // tokens 是这次解析出的完整 data 内容数组
 */
export function createSSEParser() {
  let buffer = "";

  return {
    feed(chunk: string): string[] {
      buffer += chunk;
      const results: string[] = [];

      // 按 \n\n 分割完整事件
      const parts = buffer.split("\n\n");

      // 最后一个可能是不完整的事件，保留在缓冲区
      buffer = parts.pop() || "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        for (const line of trimmed.split("\n")) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data !== "[DONE]") {
              results.push(data);
            }
          }
        }
      }

      return results;
    },

    /** 流结束时，处理缓冲区中剩余的数据 */
    flush(): string[] {
      if (!buffer.trim()) return [];
      const results = extractSSEData(buffer);
      buffer = "";
      return results;
    },
  };
}
```

**你需要回答自己的问题**：

1. **为什么需要缓冲区（buffer）？**
   - TCP 是字节流协议，不保证按应用层消息边界送达
   - 一次 `reader.read()` 可能返回：`"data: hel"`（半个事件）
   - 下次 `reader.read()` 返回：`"lo\n\ndata: world\n\n"`（一个半事件）
   - 缓冲区累积数据，按 `\n\n` 正确分割
   - **面试点**："这是经典的粘包/拆包问题。SSE 用 `\n\n` 做消息分隔符，解析器需要缓冲区处理消息边界不对齐的情况。"

2. **`[DONE]` 标记是什么？**
   - 后端流结束时发送 `data: [DONE]` 告诉前端"不会有更多数据了"
   - OpenAI 的 SSE 也用这个约定
   - 前端收到后可以做清理工作（设置 `isStreaming=false` 等）

3. **如果后端不用 SSE 格式，直接发纯文本呢？**
   - 那就不需要这个解析器，直接用 `decoder.decode(value)` 拿到文本
   - 但 SSE 格式的好处是：可以传事件类型（`event: error`）、重连 ID（`id:`）
   - 我们的后端用了 `StreamingResponse(media_type="text/event-stream")`，所以需要解析

---

## Step 3：`src/utils/thinkParser.ts` — Think 标记解析器

**完整代码**：

```typescript
// src/utils/thinkParser.ts
/**
 * Think 标记解析器。
 *
 * 后端流式输出的文本中混合了思考过程标记：
 *   <<<THINK_START>>>这是思考内容<<<THINK_END>>>这是正文回复
 *
 * 这个解析器在流式接收过程中实时分离 think 和 content。
 *
 * 为什么前端要解析？
 *   - 后端的 ThinkStreamParser 在流式推送 token 时已经做了标记替换
 *     （把 <think> 替换成 <<<THINK_START>>>）
 *   - 前端需要根据标记把文本分成两部分：
 *     · thinkContent → 渲染到折叠面板
 *     · content → 渲染为主要回复
 *   - 这样用户在流式输出过程中就能实时看到思考过程的变化
 */

const THINK_START = "<<<THINK_START>>>";
const THINK_END = "<<<THINK_END>>>";
const SOURCES_START = "<<<SOURCES>>>";
const SOURCES_END = "<<<SOURCES_END>>>";

export interface ParsedContent {
  thinkContent: string;
  content: string;
  sources: Source[];             // 参考文献（流结束时从 SOURCES 标记解析）
  /** 当前是否在 think 块内部（流式解析需要跟踪状态） */
  inThink: boolean;
}

import type { Source } from "@/types/chat";

/**
 * 一次性解析完整文本。
 *
 * 适用于：流式累积后一次性解析全文。
 *
 * 示例：
 *   parseThinkContent("<<<THINK_START>>>分析问题<<<THINK_END>>>答案是42")
 *   → { thinkContent: "分析问题", content: "答案是42", inThink: false }
 */
export function parseThinkContent(fullText: string): ParsedContent {
  let thinkContent = "";
  let content = "";
  let sources: Source[] = [];
  let inThink = false;

  // 先提取 <<<SOURCES>>>...<<<SOURCES_END>>> 块（如果有）
  // sources 标记在流末尾，只出现一次
  let textToParse = fullText;
  const srcStart = fullText.indexOf(SOURCES_START);
  if (srcStart !== -1) {
    const srcEnd = fullText.indexOf(SOURCES_END, srcStart);
    if (srcEnd !== -1) {
      const jsonStr = fullText.slice(
        srcStart + SOURCES_START.length,
        srcEnd
      );
      try {
        sources = JSON.parse(jsonStr);
      } catch {
        // JSON 解析失败（流式中可能还不完整），忽略
      }
      // 从待解析文本中移除 sources 块
      textToParse =
        fullText.slice(0, srcStart) +
        fullText.slice(srcEnd + SOURCES_END.length);
    }
  }

  // 解析 Think 标记
  let remaining = textToParse;
  while (remaining.length > 0) {
    if (!inThink) {
      const startIdx = remaining.indexOf(THINK_START);
      if (startIdx === -1) {
        content += remaining;
        break;
      }
      content += remaining.slice(0, startIdx);
      remaining = remaining.slice(startIdx + THINK_START.length);
      inThink = true;
    } else {
      const endIdx = remaining.indexOf(THINK_END);
      if (endIdx === -1) {
        thinkContent += remaining;
        break;
      }
      thinkContent += remaining.slice(0, endIdx);
      remaining = remaining.slice(endIdx + THINK_END.length);
      inThink = false;
    }
  }

  return { thinkContent, content, sources, inThink };
}

/**
 * 创建增量式 Think 解析器（有状态）。
 *
 * 适用于：每次 reader.read() 后增量解析。
 *
 * 用法：
 *   const parser = createThinkParser();
 *   // 每次拿到新文本时
 *   const { thinkContent, content } = parser.append(newText);
 *   // 返回的是截至目前的完整 thinkContent 和 content
 */
export function createThinkParser() {
  let fullText = "";

  return {
    append(newText: string): ParsedContent {
      fullText += newText;
      return parseThinkContent(fullText);
    },

    reset() {
      fullText = "";
    },
  };
}
```

**你需要回答自己的问题**：

1. **为什么每次 `append` 都重新解析全文，而不是增量解析？**
   - 因为 THINK 标记可能跨 chunk：
     - 第 1 次 read: `"<<<THINK_STA"`
     - 第 2 次 read: `"RT>>>思考内容"`
   - 如果增量解析，第 1 次会把 `"<<<THINK_STA"` 当正文
   - 全文重新解析避免了这个问题
   - 性能影响？聊天回复通常 < 10KB 文本，全文解析 < 0.1ms，可以忽略
   - **面试点**："标记可能跨越 TCP 分片，增量解析需要复杂的状态机。对于 < 10KB 的文本，全量重解析更简单可靠，性能完全可以接受。"

2. **`inThink` 状态有什么用？**
   - 流式输出过程中，可能还在 think 块内部（THINK_END 还没到）
   - 前端可以用这个状态显示 "正在思考..." 动画
   - 当 `inThink=false` 且 `thinkContent` 不为空时，表示思考已完成，可以自动折叠

3. **后端的标记是 `<<<THINK_START>>>` 而不是 `<think>`，为什么？**
   - `<think>` 是模型原始输出的标记，后端的 ThinkStreamParser 替换成了 `<<<THINK_START>>>`
   - 目的是避免和 HTML/Markdown 中的 `<` `>` 冲突
   - 三重尖括号 `<<<>>>` 几乎不可能出现在正常文本中，是安全的分隔符

---

## Step 4：`src/hooks/useStreamChat.ts` — 流式聊天 Hook（最核心）

**完整代码**：

```typescript
// src/hooks/useStreamChat.ts
/**
 * 流式聊天 Hook — 前端最核心的模块。
 *
 * 职责：
 *   1. 管理聊天消息列表（messages）
 *   2. 发送流式请求（fetch + ReadableStream）
 *   3. 实时解析 SSE + Think 标记
 *   4. 提供停止生成功能（AbortController）
 *   5. 加载历史消息（Cursor 分页）
 *
 * 面试核心问答：
 *   Q: "前端怎么实现流式聊天？"
 *   A: "用 fetch 发 POST 请求，通过 response.body.getReader() 获取 ReadableStream，
 *       while 循环逐 chunk 读取，TextDecoder 解码后实时更新 React state。
 *       配合 AbortController 实现停止生成。"
 */

import { useCallback, useRef, useState } from "react";
import { useAuthStore } from "@/stores/authStore";
import { createSSEParser } from "@/utils/sseParser";
import { createThinkParser } from "@/utils/thinkParser";
import type { ChatMessage } from "@/types/chat";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000/api";

export function useStreamChat(taskId?: number, imageFile?: File | null) {
  /** 消息列表 */
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  /** 是否正在等待/接收流式响应 */
  const [isLoading, setIsLoading] = useState(false);

  /** AbortController 引用（用于停止生成） */
  const abortRef = useRef<AbortController | null>(null);

  /** 当前 token */
  const token = useAuthStore((s) => s.token);

  /**
   * 发送消息并开始接收流式响应。
   *
   * 完整流程：
   *   1. 添加 user message 到列表
   *   2. 创建空 assistant message 占位
   *   3. fetch POST 请求
   *   4. getReader + while 循环读取
   *   5. SSE 解析 → Think 解析 → 更新 state
   *   6. 流结束 → isStreaming=false
   */
  /**
   * 发送消息。
   * @param question 用户问题
   * @param image 可选：直接上传的图片文件（视觉模型用）
   */
  const sendMessage = useCallback(
    async (question: string, image?: File | null) => {
      if (!question.trim() || isLoading) return;

      // [1] 添加用户消息（如有图片，生成本地预览 URL）
      const userMsg: ChatMessage = {
        role: "user",
        content: question,
        imagePreview: image ? URL.createObjectURL(image) : undefined,
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsLoading(true);

      // [2] 创建空 assistant 消息占位
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        thinkContent: "",
        isStreaming: true,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // [3] 创建 AbortController（停止生成用）
      const controller = new AbortController();
      abortRef.current = controller;

      // [4] SSE 解析器 + Think 解析器
      const sseParser = createSSEParser();
      const thinkParser = createThinkParser();

      try {
        // [5] 构建 FormData（支持可选图片上传）
        // 为什么用 FormData 而不是 JSON？
        //   后端用 Form + File 接收参数（支持图片上传）
        //   FormData 自动设置 Content-Type: multipart/form-data + boundary
        //   注意：不要手动设置 Content-Type，让浏览器自动生成 boundary
        const formData = new FormData();
        formData.append("question", question);
        if (taskId) formData.append("task_id", String(taskId));
        if (image) formData.append("image", image);

        const resp = await fetch(`${API_BASE}/chat/stream`, {
          method: "POST",
          headers: {
            // 不设 Content-Type！FormData 会自动设置 multipart/form-data + boundary
            Authorization: `Bearer ${token}`,
          },
          body: formData,
          signal: controller.signal,
        });

        if (!resp.ok) {
          // HTTP 错误（401、422、500 等）
          const errorText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errorText}`);
        }

        // [6] 获取 ReadableStream Reader
        const reader = resp.body!.getReader();
        const decoder = new TextDecoder();

        // [7] 逐 chunk 读取流式响应
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 解码 Uint8Array → 字符串
          // stream: true 告诉 TextDecoder 这不是最后一个 chunk
          // 避免多字节字符（如中文）被截断后乱码
          const chunk = decoder.decode(value, { stream: true });

          // [8] SSE 解析：提取 data: 行的内容
          const tokens = sseParser.feed(chunk);

          if (tokens.length > 0) {
            // [9] Think + Sources 解析
            const combined = tokens.join("");
            const { thinkContent, content, sources } =
              thinkParser.append(combined);

            // [10] 更新最后一条 assistant 消息
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = {
                  ...last,
                  content,
                  thinkContent,
                  sources: sources.length > 0 ? sources : last.sources,
                  isStreaming: true,
                };
              }
              return next;
            });
          }
        }

        // [11] 处理缓冲区中剩余的数据
        const remaining = sseParser.flush();
        if (remaining.length > 0) {
          const { thinkContent, content, sources } = thinkParser.append(
            remaining.join("")
          );
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                content,
                thinkContent,
                sources: sources.length > 0 ? sources : last.sources,
              };
            }
            return next;
          });
        }

        // [12] 流结束，标记完成
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, isStreaming: false };
          }
          return next;
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 用户主动停止生成 → 正常行为，不算错误
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                isStreaming: false,
                content: last.content + "\n\n*[已停止生成]*",
              };
            }
            return next;
          });
        } else {
          // 真正的错误（网络断开、后端 500 等）
          console.error("流式聊天失败:", err);
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                isStreaming: false,
                content: `请求失败：${(err as Error).message}`,
              };
            }
            return next;
          });
        }
      } finally {
        setIsLoading(false);
        abortRef.current = null;
      }
    },
    [token, taskId, isLoading, imageFile]
  );

  /**
   * 停止生成。
   *
   * 前端：AbortController.abort() 取消 fetch 请求
   * 后端：FastAPI 检测到 request.is_disconnected() → 停止 LLM 生成 → 释放资源
   *
   * 这是一个前后端协作的中止链：
   *   用户点击 → abort() → TCP RST → Uvicorn 感知 → FastAPI middleware →
   *   request.is_disconnected()=true → rag_service 停止 yield → LLM 停止推理
   */
  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 加载历史消息（Cursor 分页，上拉加载更多）。
   *
   * cursor: 上一页最后一条消息的 ID
   * 第一次加载传 undefined → 获取最新的 N 条
   */
  const loadHistory = useCallback(
    async (cursor?: number) => {
      const params = new URLSearchParams();
      if (taskId) params.set("task_id", String(taskId));
      if (cursor) params.set("cursor", String(cursor));
      params.set("limit", "20");

      try {
        const resp = await fetch(
          `${API_BASE}/chat/history?${params.toString()}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const data = await resp.json();
        // 历史消息插到列表前面（旧消息在上，新消息在下）
        setMessages((prev) => [...data.items.reverse(), ...prev]);
        return data.next_cursor;
      } catch (err) {
        console.error("加载历史失败:", err);
        return null;
      }
    },
    [token, taskId]
  );

  return {
    messages,
    setMessages,
    isLoading,
    sendMessage,
    stopGeneration,
    loadHistory,
  };
}
```

**你需要回答自己的问题**：

1. **为什么用 `fetch` 而不是 `axios`？**
   - `axios` 不原生支持 ReadableStream（它会等完整响应再返回）
   - `fetch` 的 `response.body` 就是 ReadableStream，可以逐 chunk 读取
   - 流式场景下 `fetch` 是唯一正确的选择
   - **追问**：axios 有流式的方案吗？（有 `responseType: 'stream'`，但只在 Node.js 环境有效，浏览器中不行）
   - **面试点**："流式场景下 fetch 不可替代，因为浏览器中只有 fetch 能访问 ReadableStream API。"

2. **`decoder.decode(value, { stream: true })` 的 `stream: true` 是什么？**
   - TextDecoder 处理多字节字符（如 UTF-8 中文 = 3 字节）
   - 如果一个中文字符被拆成两个 chunk：`[0xe4, 0xb8]` + `[0xad]`（"中"字）
   - 不加 `stream: true` → 第一个 chunk 解码失败 → 出现 `�` 乱码
   - 加了 `stream: true` → TextDecoder 保留未完成的字节，等下一个 chunk 再解码
   - **面试点**："UTF-8 是变长编码，中文占 3 字节。TCP 可能在字符中间切割，`stream: true` 让 TextDecoder 缓冲不完整的字节，避免乱码。"

3. **为什么用 `useRef` 存 AbortController 而不是 `useState`？**
   - `useState` 更新会触发重新渲染
   - AbortController 只是一个引用，不需要渲染，用 `useRef` 不触发渲染
   - 在 `sendMessage` 闭包中需要访问最新的 controller → `useRef` 的 `.current` 始终是最新值
   - **追问**：如果用 `useState`，会有什么问题？（每次更新 controller 触发重渲染 → 性能浪费。且闭包可能捕获旧值。）

4. **`setMessages` 用函数式更新 `(prev) => ...` 而不是直接赋值？**
   - 流式更新频率很高（几十毫秒一次）
   - 如果用 `setMessages(newMessages)` → 可能因为闭包捕获的是旧的 messages → 丢失中间更新
   - 函数式更新 `(prev) => [...prev, msg]` → React 保证 `prev` 是最新状态
   - **面试点**："React 的 setState 是异步批量的，高频更新场景必须用函数式更新，避免闭包捕获过期状态。"

5. **AbortError 和普通错误分开处理？**
   - `AbortError`：用户主动点了"停止生成" → 正常行为，显示"已停止"
   - 其他错误：网络断开、后端 500 → 非正常行为，显示错误信息
   - 不区分的话，用户点停止会看到"请求失败"的错误提示 → 体验差

6. **`isLoading` 是在 `sendMessage` 开始时就设为 true，在 finally 中设为 false？**
   - 开始时 → 禁用发送按钮，防止重复发送
   - `finally` 中 → 无论成功/失败/中止，都恢复为 false
   - 为什么不用 `isStreaming`？→ `isStreaming` 是每条消息的属性，`isLoading` 是全局状态

---

## Step 5：`src/components/ThinkBlock.tsx` — 思考过程折叠组件

**完整代码**：

```tsx
// src/components/ThinkBlock.tsx
/**
 * 思考过程折叠展示组件。
 *
 * 展示 AI 的推理过程（RAG 检索 → 分析 → 组织回答）。
 * 默认折叠，用户可以展开查看。
 * 流式输出中，Think 内容实时更新，显示 "思考中..." 动画。
 *
 * 面试点："Think 展示让用户理解 AI 的推理过程，增强可信度。
 *          类似 ChatGPT 的 'Thinking...' 折叠面板。"
 */

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";

interface ThinkBlockProps {
  content: string;
  isStreaming?: boolean;
}

export function ThinkBlock({ content, isStreaming }: ThinkBlockProps) {
  const [expanded, setExpanded] = useState(false);

  // 流式输出中自动展开，完成后自动折叠
  useEffect(() => {
    if (isStreaming && content) {
      setExpanded(true);
    }
    if (!isStreaming && content) {
      // 流结束后 500ms 自动折叠（给用户一个看完的缓冲时间）
      const timer = setTimeout(() => setExpanded(false), 500);
      return () => clearTimeout(timer);
    }
  }, [isStreaming, content]);

  if (!content) return null;

  return (
    <div className="mb-2 rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
      {/* 折叠/展开按钮 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-slate-500 hover:text-slate-700 transition-colors"
      >
        <Brain className="h-4 w-4 flex-shrink-0" />
        <span className="flex-1 text-left">
          思考过程
          {isStreaming && (
            <span className="ml-1 inline-block animate-pulse">思考中...</span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        )}
      </button>

      {/* 思考内容 */}
      {expanded && (
        <div className="border-t border-slate-200 px-3 py-2 text-sm text-slate-600 dark:text-slate-400 whitespace-pre-wrap leading-relaxed">
          {content}
        </div>
      )}
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **为什么流式中自动展开、完成后自动折叠？**
   - 流式中：用户好奇 AI 在想什么 → 自动展开让用户看到实时思考过程
   - 完成后：思考过程不是最终回答 → 自动折叠，避免遮挡正文
   - 延迟 500ms 折叠 → 给用户一个"看完最后几句"的缓冲

2. **`animate-pulse` 是什么？**
   - Tailwind 内置的脉冲动画类（opacity 0→1→0 循环）
   - 用在 "思考中..." 文字上 → 表示正在进行中
   - 比自己写 `@keyframes` 简洁得多

3. **组件什么时候不渲染？**
   - `if (!content) return null;` → 没有思考内容时完全不渲染
   - 有些回答没有思考过程（后端 `no_think` 模式）→ ThinkBlock 直接消失
   - 避免显示一个空的折叠面板

---

## Step 5.5：`src/components/SourcesBlock.tsx` — 参考文献展示组件

**完整代码**：

```tsx
// src/components/SourcesBlock.tsx
/**
 * 参考文献展示组件。
 *
 * 展示 RAG 检索到的参考来源：文档名、相关性分数、内容摘要。
 * 让用户知道 AI 的回答基于哪些文档，增强可信度。
 *
 * 面试点："RAG 不是黑盒。展示参考来源让用户可以验证回答的准确性，
 *          这是 RAG 相比纯 LLM 的核心优势——可追溯性。"
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import type { Source } from "@/types/chat";

interface SourcesBlockProps {
  sources: Source[];
}

export function SourcesBlock({ sources }: SourcesBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:text-blue-700 transition-colors"
      >
        <FileText className="h-4 w-4 flex-shrink-0" />
        <span className="flex-1 text-left">
          参考来源（{sources.length} 篇文档）
        </span>
        {expanded ? (
          <ChevronDown className="h-4 w-4 flex-shrink-0" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-blue-100 px-3 py-2 space-y-2">
          {sources.map((src) => (
            <div
              key={src.id}
              className="rounded-md bg-white px-3 py-2 text-sm border border-blue-50"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-slate-700 truncate">
                  {src.doc}
                  {src.page != null && (
                    <span className="ml-1 text-slate-400">
                      (第 {src.page} 页)
                    </span>
                  )}
                </span>
                {src.score != null && (
                  <span
                    className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                      src.score >= -1
                        ? "bg-green-100 text-green-700"
                        : src.score >= -3
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {src.score.toFixed(2)}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-500 line-clamp-2">
                {src.snippet}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **分数颜色为什么分三档？**
   - `>= -1`（绿色）：高相关性，非常可信
   - `>= -3`（黄色）：中等相关性，仅供参考
   - `< -3`（灰色）：低相关性，可能不太相关
   - 颜色帮助用户快速判断参考来源的可信程度

2. **为什么要展示 score？**
   - 让用户判断回答的可信度：高分 → 回答很可能正确；低分 → 需要人工验证
   - 答辩时评委会问"怎么知道 RAG 回答是否可靠" → 展示 Reranker 分数是直接证据

3. **`line-clamp-2` 是什么？**
   - Tailwind 的多行文本截断：最多显示 2 行，超出部分用 `...` 省略
   - 避免长摘要撑开布局

---

## Step 6：`src/components/ChatMessage.tsx` — 消息气泡组件

**完整代码**：

```tsx
// src/components/ChatMessage.tsx
/**
 * 单条聊天消息组件。
 *
 * 用户消息：右对齐，蓝色气泡
 * 助手消息：左对齐，灰色背景 + ThinkBlock + Markdown 渲染
 */

import ReactMarkdown from "react-markdown";
import { Bot, User } from "lucide-react";
import { ThinkBlock } from "./ThinkBlock";
import { SourcesBlock } from "./SourcesBlock";
import type { ChatMessage as ChatMessageType } from "@/types/chat";

interface Props {
  message: ChatMessageType;
}

export function ChatMessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  // 图片 URL：本地预览优先，其次拼后端静态路径
  const imageUrl =
    message.imagePreview ||
    (message.image ? `/api/uploads/${message.image}` : null);

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="flex items-start gap-2 max-w-[80%]">
          <div className="rounded-2xl rounded-tr-sm bg-blue-500 px-4 py-2 text-white">
            {/* 如有图片，显示缩略图 */}
            {imageUrl && (
              <img
                src={imageUrl}
                alt="上传图片"
                className="mb-2 max-h-40 rounded-lg object-contain"
              />
            )}
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {message.content}
            </p>
          </div>
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-100">
            <User className="h-4 w-4 text-blue-600" />
          </div>
        </div>
      </div>
    );
  }

  // === 助手消息 ===
  return (
    <div className="flex justify-start mb-4">
      <div className="flex items-start gap-2 max-w-[80%]">
        {/* AI 头像 */}
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-slate-100">
          <Bot className="h-4 w-4 text-slate-600" />
        </div>

        <div className="flex-1 min-w-0">
          {/* 思考过程折叠 */}
          {message.thinkContent && (
            <ThinkBlock
              content={message.thinkContent}
              isStreaming={message.isStreaming}
            />
          )}

          {/* 正文内容（Markdown 渲染） */}
          <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-4 py-2 dark:bg-slate-800">
            {message.content ? (
              <div className="prose prose-sm prose-slate max-w-none dark:prose-invert">
                <ReactMarkdown>{message.content}</ReactMarkdown>
              </div>
            ) : message.isStreaming ? (
              // 正文还没开始（可能还在 Think 阶段），显示占位
              <span className="text-sm text-slate-400">正在生成...</span>
            ) : null}

            {/* 流式输出光标 */}
            {message.isStreaming && message.content && (
              <span className="inline-block w-2 h-4 bg-slate-400 animate-pulse ml-0.5 align-text-bottom" />
            )}
          </div>

          {/* 参考文献（流结束后显示） */}
          {!message.isStreaming && message.sources && (
            <SourcesBlock sources={message.sources} />
          )}
        </div>
      </div>
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **为什么用 `react-markdown` 渲染正文？**
   - RAG 回复经常包含 Markdown：标题、列表、代码块、加粗
   - 纯文本展示 → `## 标题` 显示为原始文本，体验差
   - Markdown 渲染 → 格式清晰，和 ChatGPT 的体验一致
   - **追问**：安全性？（react-markdown 默认不渲染 HTML，防 XSS。不要用 `dangerouslySetInnerHTML`）

2. **`max-w-[80%]` 是什么？**
   - Tailwind 的任意值语法：最大宽度 80%
   - 消息气泡不占满整行 → 视觉上像聊天应用
   - 很长的消息会自动换行，不会撑破布局

3. **流式光标 `▊` 怎么实现的？**
   - 不是真的 `▊` 字符，是一个小矩形 `<span>`
   - `w-2 h-4` 宽 8px 高 16px → 模拟光标大小
   - `animate-pulse` → 闪烁效果
   - `isStreaming && content` → 只有正在生成且有内容时显示

---

## Step 7：`src/pages/ChatPage.tsx` — 聊天页面（完整组合）

**完整代码**：

```tsx
// src/pages/ChatPage.tsx
/**
 * 聊天页面 — 组合所有组件。
 *
 * 可以独立使用（无 task_id），也可以嵌入 TaskDetailPage（有 task_id）。
 * 有 task_id 时，RAG 会关联该任务的检测结果做上下文。
 *
 * 核心交互：
 *   - 消息列表自动滚动到底部
 *   - Enter 发送，Shift+Enter 换行
 *   - 生成中显示"停止"按钮
 *   - 上拉加载历史消息（可选）
 */

import { useEffect, useRef, useState } from "react";
import { Send, Square, ImagePlus, X } from "lucide-react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { ChatMessageBubble } from "@/components/ChatMessage";
import { useParams } from "react-router-dom";

export default function ChatPage() {
  // 从 URL 参数获取 task_id（如 /chat/:taskId）
  const { taskId } = useParams<{ taskId?: string }>();
  const numericTaskId = taskId ? Number(taskId) : undefined;

  const { messages, isLoading, sendMessage, stopGeneration, loadHistory } =
    useStreamChat(numericTaskId);

  // 输入框内容
  const [input, setInput] = useState("");

  // 图片上传状态（直传图片给视觉模型）
  const [selectedImage, setSelectedImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // 消息列表容器引用（用于自动滚动）
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // === 自动滚动到底部 ===
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // === 页面加载时获取历史消息 ===
  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === 选择图片 ===
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedImage(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  // === 发送消息 ===
  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    sendMessage(trimmed, selectedImage);
    setInput("");
    clearImage(); // 发送后清除图片

    // 重置 textarea 高度
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  // === 键盘事件：Enter 发送，Shift+Enter 换行 ===
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault(); // 阻止默认换行行为
      handleSend();
    }
    // Shift+Enter → 不阻止默认行为 → 正常换行
  };

  // === Textarea 自动调整高度 ===
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);

    // 自适应高度：根据内容动态调整，最大 5 行
    const target = e.target;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 120)}px`; // 120px ≈ 5行
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-slate-900">
      {/* 顶部标题栏 */}
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-700">
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
          {numericTaskId ? `任务 #${numericTaskId} 智能问答` : "RAG 智能问答"}
        </h1>
        <p className="text-sm text-slate-500">
          基于风电叶片缺陷检测知识库的智能问答助手
        </p>
      </div>

      {/* 消息列表（可滚动区域） */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          // 空状态提示
          <div className="flex h-full items-center justify-center">
            <div className="text-center text-slate-400">
              <p className="text-lg mb-2">开始对话</p>
              <p className="text-sm">
                {numericTaskId
                  ? "可以询问关于检测结果的问题"
                  : "可以询问风电叶片缺陷相关知识"}
              </p>
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => (
            <ChatMessageBubble key={idx} message={msg} />
          ))
        )}

        {/* 滚动锚点（用于自动滚动到底部） */}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="border-t border-slate-200 px-4 py-3 dark:border-slate-700">
        {/* 图片预览（选择图片后显示） */}
        {imagePreview && (
          <div className="mb-2 flex items-center gap-2">
            <img
              src={imagePreview}
              alt="预览"
              className="h-16 w-16 rounded-lg object-cover border"
            />
            <span className="text-xs text-slate-500">
              {selectedImage?.name}
            </span>
            <button
              onClick={clearImage}
              className="rounded-full p-1 hover:bg-slate-100"
            >
              <X className="h-4 w-4 text-slate-400" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* 图片上传按钮 */}
          <button
            onClick={() => imageInputRef.current?.click()}
            disabled={isLoading}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg
                       text-slate-400 hover:bg-slate-100 hover:text-slate-600
                       disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="上传图片（视觉模型）"
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleImageSelect}
            className="hidden"
          />

          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={
              isLoading
                ? "AI 正在回答..."
                : "输入问题，Enter 发送，Shift+Enter 换行"
            }
            disabled={isLoading}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm
                       focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500
                       disabled:bg-slate-100 disabled:cursor-not-allowed
                       dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          />

          {/* 发送 / 停止按钮 */}
          {isLoading ? (
            <button
              onClick={stopGeneration}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg
                         bg-red-500 text-white hover:bg-red-600 transition-colors"
              title="停止生成"
            >
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg
                         bg-blue-500 text-white hover:bg-blue-600 transition-colors
                         disabled:bg-slate-300 disabled:cursor-not-allowed"
              title="发送"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **消息列表的 `key` 用 `idx` 而不是 `id`，有问题吗？**
   - 流式生成中的消息没有 `id`，只能用 `idx`
   - 用 `idx` 作为 key 的风险：列表插入/删除时可能导致错误复用
   - 但聊天场景只在尾部追加消息，不会中间插入 → 用 `idx` 是安全的
   - **追问**：什么时候必须用唯一 ID？（列表可排序/可删除/可插入时。聊天只追加，idx 足够）

2. **自动滚动的实现原理？**
   - `messagesEndRef` 是一个空 `<div>` 放在消息列表最底部
   - 每次 `messages` 变化 → `useEffect` 触发 → `scrollIntoView({ behavior: "smooth" })`
   - `behavior: "smooth"` → 平滑滚动动画
   - **潜在问题**：用户正在往上滚动看历史消息时，新消息到来会强制滚到底部 → 体验差
   - **优化**：加一个判断"用户是否在底部附近"，只有在底部时才自动滚动

3. **Textarea 自动高度调整是怎么做的？**
   - 先设 `height = "auto"` → 让 textarea 缩回最小高度
   - 再设 `height = scrollHeight` → 让 textarea 撑开到内容高度
   - `Math.min(scrollHeight, 120)` → 最大 5 行高度，超出后出滚动条
   - **面试点**：这是一个常见的 UX 优化，避免输入框高度固定导致长文本不可见

4. **`e.preventDefault()` 为什么在 Enter 时调用？**
   - Textarea 的默认 Enter 行为是换行
   - 我们要改为"发送消息"
   - `preventDefault()` 阻止换行，然后手动调用 `handleSend()`
   - Shift+Enter 不调用 `preventDefault()` → 保留默认换行行为

5. **`eslint-disable-next-line react-hooks/exhaustive-deps` 是什么？**
   - `loadHistory` 在 deps 里会导致每次渲染都调用（因为 useCallback 的 deps 变化）
   - 我们只想在组件挂载时加载一次历史消息 → deps 写 `[]`
   - ESLint 会警告 "缺少 loadHistory 依赖" → 用注释禁用这条警告
   - **面试点**：这是 React Hooks 的常见权衡。严格遵循 exhaustive-deps 规则有时和业务意图冲突。

---

## Step 8：`src/pages/ChatPage.tsx` 嵌入 `TaskDetailPage.tsx`

如果聊天区域嵌在任务详情页内部（不是独立页面），只需要提取聊天部分为子组件：

```tsx
// src/components/ChatPanel.tsx
/**
 * 聊天面板（嵌入式）。
 *
 * 和 ChatPage 的区别：
 *   - 没有顶部标题栏
 *   - 通过 props 传入 taskId
 *   - 高度由父组件控制
 */

import { useEffect, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { ChatMessageBubble } from "@/components/ChatMessage";

interface ChatPanelProps {
  taskId: number;
}

export function ChatPanel({ taskId }: ChatPanelProps) {
  const { messages, isLoading, sendMessage, stopGeneration, loadHistory } =
    useStreamChat(taskId);

  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    sendMessage(trimmed);
    setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-3">
        {messages.map((msg, idx) => (
          <ChatMessageBubble key={idx} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* 输入区域 */}
      <div className="border-t p-3">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={isLoading ? "AI 正在回答..." : "输入问题..."}
            disabled={isLoading}
            className="flex-1 rounded-lg border px-3 py-2 text-sm"
          />
          {isLoading ? (
            <button onClick={stopGeneration} className="rounded-lg bg-red-500 px-3 py-2 text-white">
              <Square className="h-4 w-4" />
            </button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim()} className="rounded-lg bg-blue-500 px-3 py-2 text-white disabled:opacity-50">
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
```

在 TaskDetailPage 中使用：

```tsx
// src/pages/TaskDetailPage.tsx 中
import { ChatPanel } from "@/components/ChatPanel";

// 在任务详情页的布局中：
<div className="grid grid-cols-2 h-full">
  {/* 左侧：检测结果 */}
  <div className="border-r">
    {/* 图片 + Canvas 叠加 + 检测结果列表 */}
  </div>

  {/* 右侧：聊天区域 */}
  <div className="h-full">
    <ChatPanel taskId={task.id} />
  </div>
</div>
```

---

## Step 9：路由配置

```tsx
// src/App.tsx 中添加聊天路由
import ChatPage from "@/pages/ChatPage";
import { ProtectedRoute } from "@/components/ProtectedRoute";

// 在 Routes 中添加：
<Route
  path="/chat"
  element={
    <ProtectedRoute>
      <ChatPage />
    </ProtectedRoute>
  }
/>
<Route
  path="/chat/:taskId"
  element={
    <ProtectedRoute>
      <ChatPage />
    </ProtectedRoute>
  }
/>
```

---

## Day 12 验收清单

```bash
# 1. 确保后端运行（Day 5~6 的 API）
# 终端 1：
cd backend && uv run uvicorn app.main:app --reload --port 8000

# 2. 确保 Ollama 运行
ollama serve  # 另一个终端

# 3. 启动前端
cd frontend && pnpm dev

# 4. 浏览器验证：

# a) 登录后访问 /chat
#    - 页面显示空状态提示 "开始对话"
#    - 输入框可用，发送按钮灰色（无内容时禁用）

# b) 输入问题，点发送（或按 Enter）
#    - 用户消息出现在右侧蓝色气泡
#    - 助手消息区域出现 "正在生成..."
#    - ThinkBlock 自动展开，显示 "思考中..." + 实时思考内容
#    - 思考完成后 ThinkBlock 自动折叠
#    - 正文逐字流式输出，尾部有闪烁光标
#    - 输出完成后光标消失

# c) 流式输出中点 "停止" 按钮（红色方块）
#    - 输出立即停止
#    - 显示 "*[已停止生成]*"
#    - 输入框恢复可用

# d) 输入 Shift+Enter
#    - 输入框换行，不发送

# e) 打开浏览器 DevTools → Network
#    - 找到 /chat/stream 请求
#    - 类型应该是 fetch
#    - Response 标签页应该能看到流式数据

# f) 访问 /chat/123（带 task_id）
#    - 标题显示 "任务 #123 智能问答"

# g) 发送多条消息
#    - 消息列表正确累积
#    - 自动滚动到最新消息

# 5. 中文流式输出验证
#    - 发送中文问题，确认回复中没有乱码
#    - 特别注意中文字符的 UTF-8 多字节边界
```

---

## 文件写作顺序

```
1. src/types/chat.ts                <- 新建（类型定义，含 Source 接口）
2. src/utils/sseParser.ts           <- 新建（SSE 解析器）
3. src/utils/thinkParser.ts         <- 新建（Think + Sources 标记解析器）
4. src/hooks/useStreamChat.ts       <- 新建（核心 Hook，FormData + 图片上传）
5. src/components/ThinkBlock.tsx    <- 新建（思考折叠组件）
6. src/components/SourcesBlock.tsx  <- 新建（参考文献展示组件）
7. src/components/ChatMessage.tsx   <- 新建（消息气泡组件，含 ThinkBlock + SourcesBlock）
8. src/pages/ChatPage.tsx           <- 新建（聊天页面，含图片上传）
9. src/components/ChatPanel.tsx     <- 新建（嵌入式聊天面板，可选）
10. src/App.tsx                     <- 改（添加 /chat 路由）
11. pnpm add react-markdown         <- 安装依赖
```

---

## 面试话术（120 秒）

> 前端流式聊天是项目中前端最复杂的模块。
>
> **流式传输**：用 fetch 发 POST 请求（FormData 格式，支持可选图片上传），
> 通过 `response.body.getReader()` 获取 ReadableStream。
> 不用 EventSource 是因为它只支持 GET，无法携带 Authorization Header。
> while 循环逐 chunk 读取，TextDecoder 解码时设置 `stream: true` 防止 UTF-8 多字节中文被截断导致乱码。
>
> **图片上传**：聊天接口用 multipart/form-data 而不是 JSON body，
> 因为需要支持可选的图片上传给视觉模型。图片来源有两个优先级：
> 用户直接上传 > 任务关联的原始图片。后端统一处理为 image_path 传给 service 层。
>
> **Think 展示**：后端流式输出的文本中混合了 `<<<THINK_START>>>` 和 `<<<THINK_END>>>` 标记。
> 前端实时解析，将思考过程和正文分离到不同 UI 区域。
> 流式中 ThinkBlock 自动展开，完成后自动折叠，类似 ChatGPT 的 Thinking 面板。
>
> **参考文献**：后端在流末尾 yield `<<<SOURCES>>>json<<<SOURCES_END>>>` 标记。
> 前端解析后展示为可折叠的 SourcesBlock，显示来源文档名、Reranker 分数、内容摘要。
> 同时 sources 通过 result_meta 共享字典存入数据库 meta.sources 字段，
> 历史消息加载时也能展示参考来源。这是 RAG 相比纯 LLM 的核心优势——可追溯性。
>
> **停止生成**：通过 AbortController 实现。用户点停止 → `abort()` 取消 fetch →
> 后端 `request.is_disconnected()` 检测到断开 → 停止 LLM 推理释放资源。
> 是一个前后端协作的中止链。
>
> **状态管理**：用 React 的函数式 setState `(prev) => ...` 更新消息列表，
> 避免高频流式更新下闭包捕获过期状态的 bug。
> AbortController 用 useRef 而不是 useState，因为它不需要触发渲染。

---

## 面试 Q&A 精选

### Q1：为什么不用 WebSocket 做流式聊天？

> **A**：WebSocket 适合双向实时通信（如多人聊天室、协同编辑）。
> 但 RAG 聊天是单向流式（用户发一条 → 服务器流式回一条），SSE 语义更匹配。
> SSE 基于 HTTP，天然支持认证 Header、自动重连、断点续传。
> WebSocket 需要自己实现认证握手、心跳保活、重连逻辑，引入不必要的复杂度。
> 面试核心结论：**选择协议要看通信模式，单向流 → SSE，双向实时 → WebSocket。**

### Q2：流式输出中页面卡顿怎么办？

> **A**：高频 `setMessages` 导致 React 频繁 re-render 是卡顿主因。优化方向：
> 1. **降低更新频率**：收到 chunk 先存到 ref 中，用 `requestAnimationFrame` 每帧只更新一次 state
> 2. **消息列表虚拟化**：消息很多时用 `react-virtuoso` 只渲染可见区域
> 3. **memo 优化**：用 `React.memo` 包裹 `ChatMessageBubble`，已完成的消息不重新渲染
> 当前方案对于 < 100 条消息 + < 10KB 回复完全够用，不需要过早优化。

### Q3：AbortController 的兼容性？

> **A**：所有现代浏览器（Chrome 66+、Firefox 57+、Safari 12.1+）都支持。
> 项目目标是现代浏览器，不需要 polyfill。
> 如果要支持老浏览器 → 可以用 `abortcontroller-polyfill` 库。

### Q4：如果后端不返回 SSE 格式，直接返回纯文本流呢？

> **A**：那就不需要 SSE 解析器，直接用 `decoder.decode(value, { stream: true })` 拿到文本。
> 但建议用 SSE 格式，因为：
> 1. 可以传事件类型（如 `event: error` 传错误信息）
> 2. 有标准的流结束标记（`data: [DONE]`）
> 3. 浏览器 DevTools 对 SSE 有专门的展示（EventStream 标签页）
> 4. 符合行业惯例（OpenAI、Claude 的 API 都用 SSE）

### Q5：前端怎么展示参考文献？

> **A**：后端在流末尾 yield 一个 `<<<SOURCES>>>json<<<SOURCES_END>>>` 标记块。
> 前端的 thinkParser 在全文解析时提取 SOURCES 标记，JSON.parse 得到 sources 数组。
> 渲染为可折叠的 SourcesBlock 组件，展示文档名、Reranker 分数、内容摘要。
> 分数用颜色分三档（绿/黄/灰），帮助用户快速判断来源可信度。
> 只在流结束后显示（`!isStreaming`），避免流式中频繁解析不完整的 JSON。

### Q6：为什么参考文献走两条路径（result_meta + 流标记）？

> **A**：两个消费者不同：
> - `result_meta` → router 层读取 → 存入数据库 `meta.sources` → 历史消息也能展示来源
> - `<<<SOURCES>>>` 标记 → 前端实时解析 → 当前流式对话立即展示
> 只有流标记 → 历史消息加载时没有 sources（只有 meta.think 有）。
> 只有 result_meta → 前端流式对话中看不到 sources，需要额外 API 查询。
> 两者结合 → 实时和历史都能展示。

### Q7：消息持久化在哪里？前端有本地存储吗？

> **A**：消息只持久化在后端数据库（Day 5 的 ChatMessage 表）。
> 前端不做本地存储，原因：
> 1. localStorage 容量有限（5MB），长对话可能超限
> 2. 多设备同步 → 必须以数据库为准
> 3. 页面刷新后通过 `loadHistory` 从后端重新加载
> 如果要做离线缓存 → 用 IndexedDB，但毕设不需要。

### Q8：聊天接口为什么用 FormData 而不是 JSON？

> **A**：因为需要支持可选的图片上传。HTTP 协议限制：JSON body 和文件上传不能混用。
> 文件上传必须用 `multipart/form-data`。FastAPI 的 `Form(...)` + `File(None)` 对应 multipart。
> 前端用 `new FormData()` 构建请求，不手动设置 Content-Type（让浏览器自动生成 boundary）。
> 如果不需要传图片，FormData 也能只传 question 和 task_id，兼容纯文本场景。

### Q9：useStreamChat 可以复用吗？

> **A**：可以。通过 `taskId` 参数区分：
> - `useStreamChat()` → 通用聊天（无 task_id）
> - `useStreamChat(123)` → 任务绑定聊天（传 task_id 给后端）
> 后端根据 task_id 有无决定是否拼接检测结果到 prompt。
> 这就是 React Hooks 的复用优势 — 把有状态逻辑封装成 Hook，不同组件共享相同逻辑。
