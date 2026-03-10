# Day 9 ~ Day 14 总体规划

> Day 1~8 完成了后端全部核心模块。Day 9~14 完成：Redis/Arq 异步任务队列 + 前端核心 + Docker 部署。
> 每个 Day 的详细模版代码会在你准备好时再展开写，这里先给出整体路线图和每天的核心目标。

---

## 总览

```
Day 9:  Redis + Arq 异步任务队列（替代 BackgroundTasks）
Day 10: 前端项目搭建 + 登录注册页
Day 11: 前端检测任务流（上传 + 结果展示）
Day 12: 前端 RAG 聊天（流式 + Think 展示）
Day 13: 前端知识库管理 + 管理后台
Day 14: Docker 部署 + 整体收尾
```

---

# Day 9：Redis + Arq 异步任务队列

> 目标：用 Redis + Arq 替代 BackgroundTasks，实现可靠的异步任务队列
> 预计文件数：3 个新建 + 3 个修改

## 为什么要替换 BackgroundTasks？

```
BackgroundTasks 的问题：
  1. 无持久化：API 进程重启 → 正在执行的任务丢失
  2. 无重试：任务失败就没了，没有自动重试机制
  3. 无可观测性：不知道队列里有多少任务、每个任务什么状态
  4. 无并发控制：所有任务在 API 进程内执行，高并发时互相抢资源
  5. 无优先级：所有任务先来先执行，不能区分紧急/普通

Arq（Async Redis Queue）的优势：
  1. Redis 持久化：进程重启不丢任务
  2. 自动重试：失败后按配置重试（指数退避）
  3. 任务状态查询：pending/running/completed/failed
  4. 独立 Worker 进程：和 API 进程分离，OOM 互不影响
  5. 定时任务（cron job）：如定期清理过期文件

面试话术：
  "用 Arq 替代 BackgroundTasks，实现了任务持久化和进程级隔离。
   API 进程只负责入队，Worker 进程独立执行推理，即使 Worker OOM 也不影响 API 服务。"
```

## 核心文件

```
1. app/core/redis.py           <- 新建：Redis 连接池
2. app/worker.py               <- 新建：Arq Worker 定义（任务函数注册）
3. app/tasks/yolo_task.py      <- 新建：YOLO 推理任务（从 router 迁移到这里）
4. app/routers/tasks.py        <- 改：上传接口改为 arq.enqueue_job 入队
5. app/core/config.py          <- 改：加 Redis 配置
6. app/main.py                 <- 改：lifespan 初始化 Redis 连接池
```

## 核心概念

### 9.1 Redis 连接池

```python
# app/core/redis.py
import redis.asyncio as redis
from app.core.config import settings

# 全局连接池（lifespan 中初始化）
redis_pool: redis.ConnectionPool | None = None

async def get_redis() -> redis.Redis:
    """获取 Redis 连接（从连接池）"""
    if redis_pool is None:
        raise RuntimeError("Redis 未初始化")
    return redis.Redis(connection_pool=redis_pool)

async def init_redis() -> None:
    global redis_pool
    redis_pool = redis.ConnectionPool.from_url(
        settings.REDIS_URL,
        max_connections=settings.REDIS_MAX_CONNECTIONS,
        decode_responses=True,
    )

async def close_redis() -> None:
    global redis_pool
    if redis_pool:
        await redis_pool.aclose()
        redis_pool = None
```

**面试点**：
- 为什么用连接池不用单连接？（复用 TCP 连接，避免频繁建连开销）
- `decode_responses=True` 做什么？（自动把 bytes 解码为 str，省得每次 `.decode()`）

### 9.2 Arq Worker

```python
# app/worker.py
"""
Arq Worker — 独立进程运行，执行异步任务。

启动命令：uv run arq app.worker.WorkerSettings
"""
from arq import cron
from arq.connections import RedisSettings

from app.core.config import settings
from app.tasks.yolo_task import run_yolo_detection

class WorkerSettings:
    functions = [run_yolo_detection]
    redis_settings = RedisSettings.from_dsn(settings.REDIS_URL)
    max_jobs = 2                  # 同时最多执行 2 个任务
    job_timeout = 300             # 单个任务超时 5 分钟
    retry_jobs = True             # 失败自动重试
    max_tries = 3                 # 最多重试 3 次
    # cron_jobs = [               # 定时任务（可选）
    #     cron(cleanup_expired_files, hour=3, minute=0),  # 每天凌晨 3 点清理
    # ]
```

**面试点**：
- `max_jobs=2`：和 RAG 的 Semaphore(2) 同理，限制 GPU/CPU 并发
- `max_tries=3`：YOLO 推理偶尔因显存不足失败，重试通常能成功
- Worker 是独立进程：`uv run arq app.worker.WorkerSettings`，和 `uvicorn` 分开启动

### 9.3 YOLO 任务函数

```python
# app/tasks/yolo_task.py
"""YOLO 推理任务 — 由 Arq Worker 执行"""
import logging
from sqlalchemy.ext.asyncio import AsyncSession
from app.core.database import AsyncSessionLocal
from app.services.yolo_service import YOLOService

logger = logging.getLogger(__name__)

async def run_yolo_detection(ctx: dict, task_id: int) -> dict:
    """
    Arq 任务函数。

    ctx 是 Arq 注入的上下文，包含 Redis 连接等信息。
    注意：这里必须用独立 Session（Worker 进程没有 FastAPI 的 Depends）。
    """
    async with AsyncSessionLocal() as db:
        task = await db.get(Task, task_id)
        if not task:
            logger.error("任务不存在 task_id=%d", task_id)
            return {"error": "task_not_found"}

        try:
            # YOLO 推理（和之前 BackgroundTasks 中的逻辑相同）
            result = await asyncio.to_thread(
                YOLOService.detect, task.original_image
            )
            task.detect_result = result
            task.status = "completed"
        except Exception:
            logger.exception("YOLO 推理失败 task_id=%d", task_id)
            task.status = "failed"

        await db.commit()
    return {"task_id": task_id, "status": task.status}
```

### 9.4 Router 改动

```python
# app/routers/tasks.py — 核心改动
# 之前：
#   background_tasks.add_task(run_yolo, task.id)
# 之后：
from arq import ArqRedis

@router.post("/tasks/upload")
async def upload(...):
    # ... 保存文件、创建 Task ...

    # 入队：Arq 会把任务序列化到 Redis，Worker 进程异步执行
    arq_redis = await get_arq_redis()
    job = await arq_redis.enqueue_job("run_yolo_detection", task.id)
    logger.info("YOLO 任务已入队 task_id=%d job_id=%s", task.id, job.job_id)

    return TaskResponse(id=task.id, status="processing")
```

### 9.5 Redis 额外用途（可选扩展）

```
除了任务队列，Redis 还可以用于：

1. 会话窗口缓存（替代每次查数据库）
   - key: "chat:window:{user_id}:{task_id}"
   - value: 最近 N 轮对话 JSON
   - TTL: 30 分钟
   - 减少 DB 查询压力

2. 任务状态缓存
   - 前端轮询 GET /tasks/{id} → 先查 Redis → 没有再查 DB
   - YOLO 完成后 Worker 同时写 DB 和 Redis

3. 接口限流（Rate Limiting）
   - key: "ratelimit:{user_id}:{endpoint}"
   - INCR + EXPIRE 实现滑动窗口限流
```

### 9.6 配置

```python
# config.py 新增
REDIS_URL: str = "redis://localhost:6379/0"
REDIS_MAX_CONNECTIONS: int = 10
```

### Day 9 验收

```bash
# 1. 启动 Redis
redis-server

# 2. 启动 API
uv run uvicorn app.main:app --reload --port 8000

# 3. 启动 Worker（新终端）
uv run arq app.worker.WorkerSettings

# 4. Apifox 测试：
#    上传图片 → 返回 processing → Worker 日志显示推理中
#    轮询 GET /tasks/{id} → 最终 completed + 检测结果

# 5. 验证重试：
#    故意让一个任务失败 → Worker 日志显示重试
```

### Day 9 面试话术

> 原先用 BackgroundTasks 执行 YOLO 推理，有三个问题：无持久化、无重试、和 API 共享进程。
> 改用 Arq + Redis 后：任务持久化到 Redis，进程重启不丢失；失败自动重试 3 次，指数退避；
> Worker 独立进程执行，OOM 不影响 API 服务。max_jobs=2 限制并发，防止 GPU 过载。

---

# Day 10：前端项目搭建 + 登录注册

> 目标：React + Vite + TypeScript + Tailwind + shadcn/ui 搭建前端，完成登录注册流程
> 预计文件数：~15 个新建

## 技术栈选择

```
React 19 + Vite        — 构建快、HMR 快、生态成熟
TypeScript             — 类型安全，面试加分
Tailwind CSS 4         — 原子化样式，不写 CSS 文件
shadcn/ui              — 基于 Radix 的组件库，可定制、不臃肿
Zustand                — 轻量状态管理（替代 Redux，面试 ROI 更高）
Axios                  — HTTP 客户端（拦截器 + 自动刷新 token）
React Router v7        — 路由管理
```

**为什么不用 Next.js？**
- 毕设项目是纯 SPA，不需要 SSR/SSG
- Next.js 引入了服务端复杂度（App Router、Server Components），增加学习成本
- Vite + React 更轻量，面试时解释也更清晰

## 项目结构

```
frontend/
├── public/
├── src/
│   ├── api/                    <- API 调用层（Axios 封装）
│   │   ├── client.ts           <- Axios 实例 + 拦截器
│   │   ├── auth.ts             <- 登录/注册 API
│   │   ├── tasks.ts            <- 任务相关 API
│   │   ├── chat.ts             <- 聊天 API（含流式）
│   │   └── knowledge.ts        <- 知识库 API
│   ├── components/             <- 通用组件
│   │   ├── ui/                 <- shadcn/ui 组件（自动生成）
│   │   ├── Layout.tsx          <- 全局布局（侧边栏 + 顶栏）
│   │   ├── ProtectedRoute.tsx  <- 路由守卫
│   │   └── ThinkBlock.tsx      <- Think 内容折叠展示
│   ├── pages/                  <- 页面组件
│   │   ├── LoginPage.tsx
│   │   ├── RegisterPage.tsx
│   │   ├── DashboardPage.tsx   <- 仪表盘（任务列表）
│   │   ├── DetectPage.tsx      <- 上传检测页
│   │   ├── TaskDetailPage.tsx  <- 任务详情（图片 + 结果 + 聊天）
│   │   ├── ChatPage.tsx        <- 独立聊天页（无 task_id）
│   │   └── KnowledgePage.tsx   <- 知识库管理（管理员）
│   ├── stores/                 <- Zustand 状态管理
│   │   ├── authStore.ts        <- 用户认证状态
│   │   └── chatStore.ts        <- 聊天消息状态
│   ├── hooks/                  <- 自定义 Hooks
│   │   ├── useStreamChat.ts    <- 流式聊天 Hook（核心）
│   │   └── useTaskPolling.ts   <- 任务状态轮询 Hook
│   ├── types/                  <- TypeScript 类型定义
│   │   └── index.ts
│   ├── utils/                  <- 工具函数
│   │   └── thinkParser.ts      <- 前端 Think 标记解析
│   ├── App.tsx                 <- 路由配置
│   └── main.tsx                <- 入口
├── index.html
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
└── package.json
```

## 核心模块

### 10.1 Axios 封装 + Token 管理

```typescript
// src/api/client.ts
import axios from "axios";

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:8000/api",
  timeout: 15000,
});

// 请求拦截器：自动附加 JWT
client.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截器：401 自动跳转登录
client.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("access_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default client;
```

### 10.2 Zustand 认证 Store

```typescript
// src/stores/authStore.ts
import { create } from "zustand";

interface User {
  id: number;
  username: string;
  is_superuser: boolean;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
  isLoggedIn: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem("access_token"),
  setAuth: (user, token) => {
    localStorage.setItem("access_token", token);
    set({ user, token });
  },
  logout: () => {
    localStorage.removeItem("access_token");
    set({ user: null, token: null });
  },
  isLoggedIn: () => !!get().token,
}));
```

### 10.3 路由守卫

```typescript
// src/components/ProtectedRoute.tsx
import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn());
  if (!isLoggedIn) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
```

### Day 10 面试点

- **Zustand vs Redux**："Zustand 零 boilerplate、无 Provider 包裹、支持 selector 自动优化渲染。对于中小项目 ROI 远高于 Redux。"
- **Token 存 localStorage 的安全性**："知道有 XSS 风险。生产环境应该用 httpOnly Cookie + CSRF Token。但毕设项目用 localStorage 是为了简化前后端分离的跨域处理。"
- **拦截器的职责**："请求拦截器统一注入 Token，响应拦截器统一处理 401。避免每个 API 调用都写重复的 Token 和错误处理逻辑。"

---

# Day 11：前端检测任务流

> 目标：完成图片上传 + 任务列表 + 任务详情（检测结果可视化）
> 预计文件数：~8 个新建/修改

## 核心页面

### 11.1 上传检测页

```
DetectPage.tsx
├── 拖拽上传区域（shadcn/ui Dropzone 或自定义）
├── 上传进度条
├── 上传成功后自动跳转到任务详情
└── 支持批量上传（循环调用 POST /tasks/upload）
```

### 11.2 任务列表页

```
DashboardPage.tsx
├── 任务卡片列表（图片缩略图 + 状态标签）
├── 状态筛选（全部/处理中/已完成/失败）
├── Offset 分页（后台管理场景，Offset 合适）
└── 点击卡片 → 跳转任务详情
```

### 11.3 任务详情页（重点）

```
TaskDetailPage.tsx
├── 左侧：原始图片 + YOLO 检测框叠加（Canvas 绘制）
├── 右侧：检测结果列表（缺陷类型 + 置信度 + 颜色标记）
├── 下方：该任务的聊天区域（task_id 绑定）
└── 状态轮询 Hook（processing 时每 2 秒轮询，completed 停止）
```

### 11.4 任务状态轮询 Hook

```typescript
// src/hooks/useTaskPolling.ts
import { useEffect, useRef, useState } from "react";
import { getTask } from "@/api/tasks";
import type { Task } from "@/types";

export function useTaskPolling(taskId: number) {
  const [task, setTask] = useState<Task | null>(null);
  const intervalRef = useRef<number>();

  useEffect(() => {
    const poll = async () => {
      const data = await getTask(taskId);
      setTask(data);
      if (data.status !== "processing") {
        clearInterval(intervalRef.current);
      }
    };

    poll(); // 立即查一次
    intervalRef.current = window.setInterval(poll, 2000);

    return () => clearInterval(intervalRef.current);
  }, [taskId]);

  return task;
}
```

### 11.5 YOLO 检测框绘制（Canvas）

```typescript
// 核心思路：在 <canvas> 上叠加绘制检测框
// 1. <img> 加载原图
// 2. <canvas> 覆盖在 <img> 上（absolute 定位）
// 3. 遍历 detect_result.objects，画矩形 + 标签

function drawDetections(
  ctx: CanvasRenderingContext2D,
  objects: DetectObject[],
  scaleX: number,  // 图片显示尺寸 / 原始尺寸
  scaleY: number,
) {
  for (const obj of objects) {
    const [x1, y1, x2, y2] = obj.bbox;
    ctx.strokeStyle = DEFECT_COLORS[obj.class] || "#ff0000";
    ctx.lineWidth = 2;
    ctx.strokeRect(x1 * scaleX, y1 * scaleY, (x2 - x1) * scaleX, (y2 - y1) * scaleY);
    ctx.fillText(`${obj.class} ${(obj.confidence * 100).toFixed(0)}%`, x1 * scaleX, y1 * scaleY - 4);
  }
}
```

### Day 11 面试点

- **轮询 vs WebSocket**："轮询实现简单，任务状态更新频率低（几秒一次），轮询足够。WebSocket 适合高频实时场景（如聊天消息推送），引入复杂度不值当。"
- **Canvas 检测框**："用 Canvas 覆盖层绘制检测框，不修改原图。缩放时根据显示比例动态调整坐标。"

---

# Day 12：前端 RAG 聊天（核心）

> 目标：实现流式聊天界面 + Think 折叠展示 + 聊天历史加载
> 这是前端最核心、面试最高频的模块
> 预计文件数：~6 个新建/修改

## 核心模块

### 12.1 流式聊天 Hook（最重要）

```typescript
// src/hooks/useStreamChat.ts
import { useCallback, useRef, useState } from "react";
import { useAuthStore } from "@/stores/authStore";

const THINK_START = "<<<THINK_START>>>";
const THINK_END = "<<<THINK_END>>>";

interface StreamMessage {
  role: "user" | "assistant";
  content: string;         // 正文
  thinkContent?: string;   // 思考过程
  isStreaming?: boolean;    // 是否正在流式输出
}

export function useStreamChat(taskId?: number) {
  const [messages, setMessages] = useState<StreamMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const token = useAuthStore((s) => s.token);

  const sendMessage = useCallback(async (question: string) => {
    // 1. 添加用户消息到列表
    const userMsg: StreamMessage = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    // 2. 创建空的 assistant 消息占位
    const assistantMsg: StreamMessage = {
      role: "assistant",
      content: "",
      thinkContent: "",
      isStreaming: true,
    };
    setMessages((prev) => [...prev, assistantMsg]);

    // 3. 发起流式请求
    abortRef.current = new AbortController();
    try {
      const resp = await fetch(
        `${import.meta.env.VITE_API_BASE_URL}/chat/stream`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ question, task_id: taskId }),
          signal: abortRef.current.signal,
        }
      );

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      // 4. 逐 chunk 读取流式响应
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let inThink = false;
      let thinkBuf = "";
      let contentBuf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fullText += decoder.decode(value, { stream: true });

        // 5. 解析 THINK 标记
        // 实时分离 think 和 content
        thinkBuf = "";
        contentBuf = "";
        let remaining = fullText;
        while (remaining.length > 0) {
          if (!inThink) {
            const startIdx = remaining.indexOf(THINK_START);
            if (startIdx === -1) {
              contentBuf += remaining;
              break;
            }
            contentBuf += remaining.slice(0, startIdx);
            remaining = remaining.slice(startIdx + THINK_START.length);
            inThink = true;
          } else {
            const endIdx = remaining.indexOf(THINK_END);
            if (endIdx === -1) {
              thinkBuf += remaining;
              break;
            }
            thinkBuf += remaining.slice(0, endIdx);
            remaining = remaining.slice(endIdx + THINK_END.length);
            inThink = false;
          }
        }

        // 6. 更新最后一条 assistant 消息
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: contentBuf,
              thinkContent: thinkBuf,
              isStreaming: true,
            };
          }
          return next;
        });
      }

      // 7. 流结束，标记完成
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { ...last, isStreaming: false };
        }
        return next;
      });

    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error("流式聊天失败:", err);
      }
    } finally {
      setIsLoading(false);
    }
  }, [token, taskId]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, setMessages, isLoading, sendMessage, stopGeneration };
}
```

### 12.2 Think 折叠组件

```typescript
// src/components/ThinkBlock.tsx
import { useState } from "react";
import { ChevronDown, ChevronRight, Brain } from "lucide-react";

interface Props {
  content: string;
  isStreaming?: boolean;
}

export function ThinkBlock({ content, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!content) return null;

  return (
    <div className="mb-2 rounded-lg border border-gray-200 bg-gray-50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-500"
      >
        <Brain className="h-4 w-4" />
        <span>思考过程 {isStreaming && "..."}</span>
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-sm text-gray-600 whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}
```

### 12.3 聊天页面

```
ChatPage.tsx / TaskDetailPage 内嵌聊天区
├── 消息列表（滚动区域，自动滚到底部）
│   ├── 用户消息（右对齐，蓝色气泡）
│   └── 助手消息
│       ├── ThinkBlock（折叠的思考过程）
│       ├── 正文内容（Markdown 渲染）
│       └── 流式光标（正在生成时闪烁 ▊）
├── 输入区域
│   ├── TextArea（Shift+Enter 换行，Enter 发送）
│   └── 发送按钮 / 停止按钮（生成中）
└── 加载历史（上拉加载更多，Cursor 分页）
```

### Day 12 面试点

- **fetch vs EventSource**："EventSource 只支持 GET 请求，聊天是 POST + JSON Body，所以用 fetch + ReadableStream 手动读取流式响应。"
- **为什么前端也要解析 THINK 标记？**："后端流式推送的是带标记的纯文本流。前端按标记实时分离思考过程和正文，分别渲染到不同区域。这样用户在流式输出过程中就能看到思考过程的折叠/展开。"
- **AbortController**："用户点'停止生成'时，前端调用 abort() 取消 fetch 请求。后端 `request.is_disconnected()` 检测到断开后停止 LLM 生成，释放资源。"

---

# Day 13：前端知识库管理 + 整体优化

> 目标：管理员知识库管理页 + 全局错误处理 + UI 打磨
> 预计文件数：~5 个新建/修改

## 核心页面

### 13.1 知识库管理页（管理员专属）

```
KnowledgePage.tsx
├── 文档列表（表格：文件名 + 大小 + 操作）
├── 上传区域（拖拽上传，支持多文件）
├── 删除按钮（确认弹窗）
├── 重建按钮（显示进度/结果）
└── 权限控制（非管理员显示"无权限"）
```

### 13.2 全局优化

```
1. 错误边界（ErrorBoundary）
   - 组件崩溃不白屏，显示友好错误页

2. 加载状态
   - 页面级骨架屏（Skeleton）
   - 按钮级 Loading 状态
   - 全局 Toast 通知（成功/错误消息）

3. 响应式布局
   - 移动端适配（Tailwind 的 sm/md/lg 断点）
   - 侧边栏收缩

4. 主题色
   - 配置 Tailwind 主题色（和风电行业相关的蓝绿色调）
```

---

# Day 14：Docker 部署 + 整体收尾

> 目标：Docker Compose 一键部署 + Nginx 反向代理 + 最终测试
> 预计文件数：~5 个新建

## 部署架构

```
                    Nginx(:80)
                   /         \
          前端静态文件    反向代理 /api
              |                |
          React Build      Uvicorn(:8000)
                               |
                    ┌──────────┼──────────┐
                    │          │          │
               PostgreSQL  Redis     Ollama
               (:5432)    (:6379)   (:11434)
                    │
              Arq Worker
              (独立进程)
```

## 核心文件

### 14.1 docker-compose.yml

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: wind_db
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    environment:
      DB_HOST: db
      REDIS_URL: redis://redis:6379/0
      OLLAMA_BASE_URL: http://host.docker.internal:11434
    ports:
      - "8000:8000"
    depends_on:
      - db
      - redis

  worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["uv", "run", "arq", "app.worker.WorkerSettings"]
    environment:
      DB_HOST: db
      REDIS_URL: redis://redis:6379/0
    depends_on:
      - db
      - redis

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "80:80"
    depends_on:
      - backend

volumes:
  pgdata:
```

### 14.2 后端 Dockerfile

```dockerfile
FROM python:3.12-slim AS base

WORKDIR /app
COPY pyproject.toml uv.lock ./

RUN pip install uv && uv sync --frozen --no-dev

COPY . .

# Alembic 迁移 + 启动
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"]
```

### 14.3 前端 Dockerfile（多阶段构建）

```dockerfile
# 构建阶段
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# 运行阶段
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

### 14.4 Nginx 配置

```nginx
server {
    listen 80;

    # 前端静态文件
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;  # SPA 路由兜底
    }

    # API 反向代理
    location /api/ {
        proxy_pass http://backend:8000;
        proxy_set_header Host $host;
        proxy_buffering off;              # 流式响应必须关闭缓冲
        proxy_cache off;
    }
}
```

### Day 14 收尾清单

```bash
# 1. 一键启动
docker compose up -d

# 2. 验证所有链路
#    - 注册 → 登录 → 获取 Token
#    - 上传图片 → YOLO 检测 → 结果展示
#    - RAG 聊天 → 流式输出 → Think 折叠
#    - 知识库上传 → 重建 → 聊天能检索到
#    - 注入测试 → 被阻断

# 3. 清理
#    - 删除 .env 中的敏感信息
#    - 确保 .gitignore 包含 .env、models/、knowledge_base/
#    - README.md 写部署说明
```

---

# 全项目时间线总览

```
Day 1:  项目初始化 + 配置 + 数据库              [已完成]
Day 2:  用户认证（注册/登录/JWT）               [已完成]
Day 3:  任务模型 + CRUD + 文件上传              [已完成]
Day 4:  YOLO 推理 + BackgroundTasks            [已完成]
Day 5:  聊天模型 + Think 解析 + 流式路由         [进行中 ←]
Day 6:  RAG 核心（检索+重排+路由+生成）          [待做]
Day 7:  知识库管理（上传+分块+入库）             [待做]
Day 8:  安全防护（Prompt Injection）+ 收尾      [待做]
─────────────── 后端完成线 ───────────────
Day 9:  Redis + Arq 异步任务队列               [待做]
Day 10: 前端搭建 + 登录注册                    [待做]
Day 11: 前端检测任务流                          [待做]
Day 12: 前端 RAG 聊天（流式 + Think）           [待做]
Day 13: 前端知识库管理 + UI 打磨               [待做]
Day 14: Docker 部署 + 整体收尾                 [待做]
```

## 面试加分项优先级（如果时间不够砍哪些）

```
必须有（没有就没法答辩）：
  ✅ Day 5-6: RAG 聊天流式输出
  ✅ Day 10-12: 前端能跑起来（登录 + 检测 + 聊天）

高 ROI（面试加分最多）：
  ✅ Day 8: 安全检测（双重检测 + 评分机制 = 独特亮点）
  ✅ Day 9: Arq 替代 BackgroundTasks（架构升级 = 加分）

可以简化（有时间再做）：
  ⚡ Day 7: 知识库管理（先手动放文件 + 手动运行 build_knowledge.py）
  ⚡ Day 13: 前端知识库管理页（Apifox 代替）
  ⚡ Day 14: Docker（本地运行即可答辩，Docker 是锦上添花）
```

---

## 每天需要我展开写详细模版代码时，直接告诉我"写 Day X 详细版"即可。
