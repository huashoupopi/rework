# Day 11：前端检测任务流（上传 + 任务列表 + Canvas 检测框）

> 目标：完成图片上传检测、任务列表展示、任务详情页（Canvas 绘制 YOLO 检测框）、任务状态轮询
> 预计文件数：7 个新建 + 2 个修改
> 验证工具：浏览器 + 后端 Day 4 的 Tasks API

---

## 前置准备

Day 11 开始之前确保：
- Day 10 完成（前端项目搭建、登录注册、路由守卫、Layout）
- 后端 Day 4 API 正常：
  - POST /api/tasks/upload（上传图片）
  - GET /api/tasks（任务列表）
  - GET /api/tasks/{id}（任务详情）
  - GET /api/tasks/{id}/download/original（下载原图）

---

## 整体架构

```
页面组件树：

DashboardPage（任务列表）
├── 状态筛选 Tabs（全部/处理中/已完成/失败）
├── 任务卡片网格
│   └── TaskCard × N
│       ├── 缩略图
│       ├── 状态标签（颜色区分）
│       ├── 上传时间
│       └── 点击 → 跳转 TaskDetailPage
└── 空状态提示

DetectPage（上传检测）
├── 拖拽上传区域
├── 文件预览 + 上传进度
└── 上传成功 → 跳转 TaskDetailPage

TaskDetailPage（任务详情）
├── 左侧
│   ├── 原始图片（<img>）
│   ├── 检测框叠加层（<canvas> absolute 定位）
│   └── 缺陷图例
├── 右侧
│   ├── 检测结果列表（缺陷类型 + 置信度 + 颜色）
│   └── 聊天面板（Day 12 的 ChatPanel）
└── useTaskPolling Hook（processing 时轮询，completed 停止）
```

---

## Step 1：`src/types/index.ts` — 类型定义

**完整代码**：

```typescript
// src/types/index.ts

/** 检测到的单个缺陷对象 */
export interface DetectObject {
  class: string;              // 缺陷类别名称（如 "crack", "erosion"）
  confidence: number;         // 置信度 0~1
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] 像素坐标
}

/** 检测结果 */
export interface DetectResult {
  total: number;              // 检测到的缺陷总数
  objects: DetectObject[];    // 缺陷列表
  image_width: number;        // 原始图片宽度
  image_height: number;       // 原始图片高度
}

/** 任务 */
export interface Task {
  id: number;
  user_id: number;
  original_image: string;     // 原始图片文件名
  status: "processing" | "completed" | "failed";
  detect_result: DetectResult | null;
  created_at: string;         // ISO 时间戳
  updated_at: string;
}

/** 任务列表分页响应 */
export interface TaskListResponse {
  items: Task[];
  total: number;
  page: number;
  page_size: number;
}

/**
 * 缺陷类型 → 颜色映射。
 *
 * 用于 Canvas 绘制检测框和结果列表的颜色标记。
 * 颜色选择原则：高对比度、色盲友好、和风电行业报告一致。
 */
export const DEFECT_COLORS: Record<string, string> = {
  crack: "#ef4444",           // 红色 — 裂纹（最严重）
  erosion: "#f97316",         // 橙色 — 腐蚀
  coating_damage: "#eab308",  // 黄色 — 涂层损伤
  lightning_damage: "#8b5cf6",// 紫色 — 雷击损伤
  contamination: "#06b6d4",   // 青色 — 污染
  delamination: "#22c55e",    // 绿色 — 分层
};

/** 获取缺陷颜色（未知类型用白色） */
export function getDefectColor(className: string): string {
  return DEFECT_COLORS[className] || "#ffffff";
}
```

**你需要回答自己的问题**：

1. **`bbox` 为什么是 `[x1, y1, x2, y2]` 而不是 `[x, y, width, height]`？**
   - YOLO 输出格式就是 `[x1, y1, x2, y2]`（左上角 + 右下角坐标）
   - Canvas 的 `strokeRect` 需要 `(x, y, width, height)` → 计算 `w = x2 - x1, h = y2 - y1`
   - 保持和后端一致，转换放在前端绘制时做

2. **颜色映射为什么硬编码？**
   - 缺陷类型是 YOLO 模型固定的（训练时确定的类别）
   - 颜色需要和论文/报告中一致（答辩时截图要对得上）
   - 生产环境可以做成后端配置化

---

## Step 2：`src/api/tasks.ts` — 任务 API

**完整代码**：

```typescript
// src/api/tasks.ts

import client from "./client";
import type { Task, TaskListResponse } from "@/types";

/**
 * 上传图片进行检测。
 *
 * POST /api/tasks/upload
 * Content-Type: multipart/form-data
 *
 * 为什么用 FormData 而不是 JSON？
 *   - 文件上传必须用 multipart/form-data
 *   - JSON 传文件需要 Base64 编码 → 体积增大 33% → 浪费带宽
 */
export async function uploadTask(file: File): Promise<Task> {
  const formData = new FormData();
  formData.append("files", file);

  const resp = await client.post("/tasks/upload", formData, {
    headers: { "Content-Type": "multipart/form-data" },
    // 上传进度回调（可选，用于进度条）
    // onUploadProgress: (e) => {
    //   const percent = Math.round((e.loaded * 100) / (e.total || 1));
    //   console.log(`上传进度: ${percent}%`);
    // },
  });
  return resp.data;
}

/**
 * 获取任务列表。
 *
 * GET /api/tasks?page=1&page_size=12&status=completed
 */
export async function getTaskList(params: {
  page?: number;
  page_size?: number;
  status?: string;
}): Promise<TaskListResponse> {
  const resp = await client.get("/tasks", { params });
  return resp.data;
}

/**
 * 获取单个任务详情。
 *
 * GET /api/tasks/{id}
 */
export async function getTask(taskId: number): Promise<Task> {
  const resp = await client.get(`/tasks/${taskId}`);
  return resp.data;
}

/**
 * 获取原始图片 URL。
 *
 * 注意：图片需要 token 才能访问，所以不能直接用 <img src="...">。
 * 方案 1：后端返回带签名的临时 URL（推荐，但实现复杂）
 * 方案 2：用 Axios 下载 Blob → 转为 Object URL（当前方案）
 * 方案 3：后端图片接口不鉴权（简单但不安全）
 */
export async function getTaskImageUrl(taskId: number): Promise<string> {
  const resp = await client.get(`/tasks/${taskId}/download/original`, {
    responseType: "blob",
  });
  // Blob → Object URL（可直接赋给 <img src>）
  return URL.createObjectURL(resp.data);
}
```

**你需要回答自己的问题**：

1. **`URL.createObjectURL(blob)` 是什么？**
   - 把内存中的 Blob 对象创建一个临时 URL：`blob:http://localhost:5173/xxx-xxx`
   - 这个 URL 可以直接赋给 `<img src>`，浏览器从内存读取图片
   - **注意**：用完后需要 `URL.revokeObjectURL(url)` 释放内存，否则 Blob 不会被 GC
   - **面试点**："Object URL 是浏览器内存中的临时引用，不是网络请求。用完必须 revoke 防止内存泄漏。"

2. **为什么不直接 `<img src="/api/tasks/1/download/original">`？**
   - 图片接口需要 Authorization header
   - `<img>` 标签的请求不会带自定义 header（浏览器行为，不受 JS 控制）
   - 所以必须用 Axios 手动下载 → 转 Blob → Object URL

---

## Step 3：`src/hooks/useTaskPolling.ts` — 任务状态轮询

**完整代码**：

```typescript
// src/hooks/useTaskPolling.ts
/**
 * 任务状态轮询 Hook。
 *
 * processing 状态时每 2 秒轮询一次。
 * completed 或 failed 后自动停止轮询。
 *
 * 为什么用轮询不用 WebSocket？
 *   - 任务状态更新频率低（几秒一次），轮询完全足够
 *   - WebSocket 需要服务端维护连接、心跳保活、重连逻辑
 *   - 轮询实现简单，面试解释也清晰
 *   - "杀鸡不用牛刀"
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { getTask } from "@/api/tasks";
import type { Task } from "@/types";

const POLL_INTERVAL = 2000; // 2 秒

export function useTaskPolling(taskId: number) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<number | null>(null);

  /** 停止轮询 */
  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  /** 单次查询 */
  const fetchTask = useCallback(async () => {
    try {
      const data = await getTask(taskId);
      setTask(data);

      // 任务完成或失败 → 停止轮询
      if (data.status !== "processing") {
        stopPolling();
      }
    } catch (err) {
      console.error("查询任务状态失败:", err);
      stopPolling();
    } finally {
      setLoading(false);
    }
  }, [taskId, stopPolling]);

  useEffect(() => {
    // 立即查一次
    fetchTask();

    // 开始轮询
    intervalRef.current = window.setInterval(fetchTask, POLL_INTERVAL);

    // 组件卸载时清理
    return () => stopPolling();
  }, [fetchTask, stopPolling]);

  return { task, loading };
}
```

**你需要回答自己的问题**：

1. **为什么用 `window.setInterval` 而不是 `setInterval`？**
   - TypeScript 中，`setInterval` 在 Node.js 环境返回 `NodeJS.Timeout`，在浏览器返回 `number`
   - 显式写 `window.setInterval` 确保返回 `number` 类型
   - 避免类型错误

2. **`useEffect` 的 cleanup 函数为什么要 `stopPolling`？**
   - 组件卸载时（用户导航到其他页面），定时器还在跑
   - 不清理 → 请求一直发 → 后端日志里一堆无效请求 → 可能更新已卸载组件的 state → React 警告
   - cleanup 函数在组件卸载或 deps 变化时自动调用

3. **轮询有没有性能问题？**
   - 每 2 秒一个 GET 请求，payload < 1KB，对后端无压力
   - 任务完成后自动停止 → 不会无限轮询
   - **追问**：如果同时 100 个用户轮询呢？（QPS = 50，一个 API 实例轻松扛住。真到瓶颈可以加 Redis 缓存任务状态。）

---

## Step 4：`src/pages/DetectPage.tsx` — 上传检测页

**完整代码**：

```tsx
// src/pages/DetectPage.tsx
/**
 * 上传检测页面。
 *
 * 拖拽或点击上传图片 → 调用后端 API → 跳转任务详情页。
 */

import { useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Upload, ImagePlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadTask } from "@/api/tasks";

/** 允许的图片格式 */
const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_MB = 10;

export default function DetectPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  /** 校验文件 */
  const validateFile = (file: File): string | null => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return "仅支持 JPG、PNG、WebP 格式";
    }
    if (file.size > MAX_SIZE_MB * 1024 * 1024) {
      return `文件大小不能超过 ${MAX_SIZE_MB}MB`;
    }
    return null;
  };

  /** 选择文件后的处理 */
  const handleFileSelect = useCallback((file: File) => {
    const err = validateFile(file);
    if (err) {
      setError(err);
      return;
    }

    setError("");
    setSelectedFile(file);

    // 生成预览
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  /** 拖拽事件 */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  /** 点击选择文件 */
  const handleClick = () => fileInputRef.current?.click();

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  /** 上传 */
  const handleUpload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setError("");

    try {
      const task = await uploadTask(selectedFile);
      // 上传成功 → 跳转任务详情页
      navigate(`/tasks/${task.id}`);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        setError(axiosErr.response?.data?.detail || "上传失败");
      } else {
        setError("网络错误");
      }
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-6 text-2xl font-bold text-slate-800">上传检测</h1>

      {/* 拖拽上传区域 */}
      <div
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 transition-colors ${
          dragOver
            ? "border-blue-500 bg-blue-50"
            : "border-slate-300 bg-slate-50 hover:border-slate-400"
        }`}
      >
        {preview ? (
          // 已选择文件 → 显示预览
          <div className="text-center">
            <img
              src={preview}
              alt="预览"
              className="mx-auto mb-4 max-h-64 rounded-lg object-contain"
            />
            <p className="text-sm text-slate-600">{selectedFile?.name}</p>
            <p className="text-xs text-slate-400">
              {((selectedFile?.size || 0) / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        ) : (
          // 未选择文件 → 显示提示
          <>
            <ImagePlus className="mb-4 h-12 w-12 text-slate-400" />
            <p className="mb-1 text-sm font-medium text-slate-600">
              拖拽图片到这里，或点击选择
            </p>
            <p className="text-xs text-slate-400">
              支持 JPG、PNG、WebP，最大 {MAX_SIZE_MB}MB
            </p>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          onChange={handleInputChange}
          className="hidden"
        />
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* 上传按钮 */}
      {selectedFile && (
        <div className="mt-4 flex gap-3">
          <Button
            onClick={handleUpload}
            disabled={uploading}
            className="flex-1"
          >
            {uploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                上传中...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                开始检测
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSelectedFile(null);
              setPreview(null);
              setError("");
            }}
          >
            重新选择
          </Button>
        </div>
      )}
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **`FileReader.readAsDataURL` 做什么？**
   - 把文件读取为 Data URL 格式：`data:image/jpeg;base64,/9j/4AAQ...`
   - 可以直接赋给 `<img src>` 显示预览
   - **注意**：只用于预览，上传时用原始 File 对象（不需要 base64 转换）

2. **拖拽上传的事件为什么要 `preventDefault`？**
   - 浏览器默认行为：拖拽文件到页面 → 打开/下载文件
   - `preventDefault()` 阻止默认行为 → 让我们自己处理文件

3. **`<input type="file">` 为什么隐藏？**
   - 原生文件选择框样式丑，无法自定义
   - 隐藏后，用 `ref.current.click()` 编程式触发
   - 用自定义的拖拽区域替代原生 UI

---

## Step 5：`src/pages/DashboardPage.tsx` — 任务列表

**完整代码**：

```tsx
// src/pages/DashboardPage.tsx

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { getTaskList } from "@/api/tasks";
import type { Task } from "@/types";

/** 状态筛选标签 */
const STATUS_TABS = [
  { key: "all", label: "全部" },
  { key: "processing", label: "处理中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "失败" },
] as const;

/** 状态图标和颜色 */
const STATUS_CONFIG = {
  processing: {
    icon: Loader2,
    color: "text-blue-500",
    bg: "bg-blue-50",
    label: "处理中",
    animate: "animate-spin",
  },
  completed: {
    icon: CheckCircle2,
    color: "text-green-500",
    bg: "bg-green-50",
    label: "已完成",
    animate: "",
  },
  failed: {
    icon: XCircle,
    color: "text-red-500",
    bg: "bg-red-50",
    label: "失败",
    animate: "",
  },
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 12;

  /** 加载任务列表 */
  useEffect(() => {
    const fetchTasks = async () => {
      setLoading(true);
      try {
        const data = await getTaskList({
          page,
          page_size: pageSize,
          status: activeTab === "all" ? undefined : activeTab,
        });
        setTasks(data.items);
        setTotal(data.total);
      } catch (err) {
        console.error("获取任务列表失败:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchTasks();
  }, [page, activeTab]);

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6">
      <h1 className="mb-6 text-2xl font-bold text-slate-800">检测任务</h1>

      {/* 状态筛选 Tabs */}
      <div className="mb-6 flex gap-2">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => {
              setActiveTab(tab.key);
              setPage(1); // 切换筛选时回到第一页
            }}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-blue-500 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 任务卡片网格 */}
      {loading ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="py-20 text-center text-slate-400">
          暂无任务，去上传检测吧
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
            {tasks.map((task) => {
              const statusConf = STATUS_CONFIG[task.status];
              const StatusIcon = statusConf.icon;

              return (
                <div
                  key={task.id}
                  onClick={() => navigate(`/tasks/${task.id}`)}
                  className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-shadow hover:shadow-md"
                >
                  {/* 缩略图占位 */}
                  <div className="mb-3 flex h-32 items-center justify-center rounded-lg bg-slate-100">
                    <img
                      src={`/api/tasks/${task.id}/download/original`}
                      alt={`任务 #${task.id}`}
                      className="h-full w-full rounded-lg object-cover"
                      loading="lazy"
                      onError={(e) => {
                        // 图片加载失败（可能需要认证），显示占位
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  </div>

                  {/* 任务信息 */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-700">
                      #{task.id}
                    </span>
                    <span
                      className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${statusConf.bg} ${statusConf.color}`}
                    >
                      <StatusIcon
                        className={`h-3 w-3 ${statusConf.animate}`}
                      />
                      {statusConf.label}
                    </span>
                  </div>

                  {/* 时间 + 检测结果数量 */}
                  <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                    <Clock className="h-3 w-3" />
                    {new Date(task.created_at).toLocaleDateString()}
                    {task.detect_result && (
                      <span className="ml-auto">
                        检测到 {task.detect_result.total} 个缺陷
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="mt-6 flex justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                上一页
              </button>
              <span className="px-3 py-1 text-sm text-slate-500">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="rounded-lg px-3 py-1 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **为什么任务列表用 Offset 分页而不是 Cursor 分页？**
   - 任务列表需要"跳到第 N 页"功能 → Offset 分页支持，Cursor 不支持
   - 聊天历史用 Cursor 分页（上拉加载更多，不需要跳页）
   - **面试点**："Offset 适合后台管理（需要跳页），Cursor 适合信息流/聊天（连续加载）。"

2. **`loading="lazy"` 做什么？**
   - 图片懒加载：只有滚动到可视区域时才开始加载
   - 12 张缩略图不全部同时加载 → 减少首屏加载时间
   - **面试点**：浏览器原生属性，不需要第三方库

---

## Step 6：`src/hooks/useCanvasDetections.ts` — Canvas 检测框绘制 Hook

**完整代码**：

```typescript
// src/hooks/useCanvasDetections.ts
/**
 * Canvas 检测框绘制 Hook。
 *
 * 在 <canvas> 上叠加绘制 YOLO 检测框。
 * Canvas 覆盖在 <img> 上面（absolute 定位），不修改原图。
 *
 * 核心算法：
 *   1. 图片显示尺寸 / 原始尺寸 = 缩放比例
 *   2. 检测框坐标 × 缩放比例 = Canvas 上的坐标
 *   3. 绘制矩形框 + 缺陷标签
 */

import { useEffect, useRef, useCallback } from "react";
import type { DetectObject } from "@/types";
import { getDefectColor } from "@/types";

interface UseCanvasDetectionsOptions {
  /** 检测到的缺陷列表 */
  objects: DetectObject[];
  /** 原始图片宽度 */
  imageWidth: number;
  /** 原始图片高度 */
  imageHeight: number;
}

export function useCanvasDetections({
  objects,
  imageWidth,
  imageHeight,
}: UseCanvasDetectionsOptions) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  /**
   * 绘制检测框。
   *
   * 流程：
   *   1. 获取容器（图片显示区域）的实际尺寸
   *   2. 计算缩放比例 = 显示尺寸 / 原始尺寸
   *   3. 遍历缺陷列表，绘制矩形 + 标签
   */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || objects.length === 0) return;

    // 获取容器实际尺寸（图片的显示尺寸）
    const displayWidth = container.clientWidth;
    const displayHeight = container.clientHeight;

    // 设置 Canvas 尺寸 = 容器尺寸（像素级对齐）
    canvas.width = displayWidth;
    canvas.height = displayHeight;

    // 缩放比例
    const scaleX = displayWidth / imageWidth;
    const scaleY = displayHeight / imageHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 清空画布
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    for (const obj of objects) {
      const [x1, y1, x2, y2] = obj.bbox;
      const color = getDefectColor(obj.class);

      // 矩形框坐标转换
      const rx = x1 * scaleX;
      const ry = y1 * scaleY;
      const rw = (x2 - x1) * scaleX;
      const rh = (y2 - y1) * scaleY;

      // 绘制矩形框
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);

      // 绘制标签背景
      const label = `${obj.class} ${(obj.confidence * 100).toFixed(0)}%`;
      ctx.font = "12px sans-serif";
      const textWidth = ctx.measureText(label).width;
      const labelHeight = 18;

      ctx.fillStyle = color;
      ctx.fillRect(rx, ry - labelHeight, textWidth + 8, labelHeight);

      // 绘制标签文字
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, rx + 4, ry - 4);
    }
  }, [objects, imageWidth, imageHeight]);

  // 图片加载完成后绘制
  useEffect(() => {
    draw();

    // 窗口大小变化时重新绘制（响应式）
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  return { canvasRef, containerRef, redraw: draw };
}
```

**你需要回答自己的问题**：

1. **为什么用 Canvas 叠加而不是直接在图片上画？**
   - 不修改原图 → 原图可以下载、放大
   - Canvas 是透明层，覆盖在 `<img>` 上面
   - 缩放窗口时 Canvas 自动重绘 → 检测框始终对齐
   - **面试点**："Canvas 叠加层模式：数据（检测框坐标）和展示（画布绘制）分离。窗口缩放时只需根据新比例重绘。"

2. **`canvas.width = displayWidth` 为什么不用 CSS 设置？**
   - CSS 的 `width/height` 设置的是 Canvas 元素的显示大小
   - `canvas.width/height` 属性设置的是 Canvas 画布的分辨率
   - 如果不设置 → Canvas 默认 300×150 → 绘制后拉伸到 CSS 大小 → 模糊
   - 两者必须一致才能像素级清晰
   - **追问**：高 DPI 屏幕怎么办？（乘以 `window.devicePixelRatio`，但毕设不需要这个精度）

3. **`resize` 事件重绘的性能问题？**
   - `resize` 事件高频触发（拖拽窗口时几十次/秒）
   - 每次触发都完整重绘 Canvas → 可能卡顿
   - 优化：用 `requestAnimationFrame` 或 `debounce(draw, 100)` 限制重绘频率
   - 当前缺陷数通常 < 20 个，重绘开销极小，不需要优化

---

## Step 7：`src/pages/TaskDetailPage.tsx` — 任务详情页

**完整代码**：

```tsx
// src/pages/TaskDetailPage.tsx
/**
 * 任务详情页。
 *
 * 左侧：原图 + Canvas 检测框叠加 + 缺陷图例
 * 右侧：检测结果列表 + 聊天面板（Day 12）
 * 处理中状态：自动轮询，检测框区域显示加载动画
 */

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTaskPolling } from "@/hooks/useTaskPolling";
import { useCanvasDetections } from "@/hooks/useCanvasDetections";
import { getTaskImageUrl } from "@/api/tasks";
import { getDefectColor } from "@/types";
// import { ChatPanel } from "@/components/ChatPanel"; // Day 12 后取消注释

export default function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const numericId = Number(taskId);

  // 轮询任务状态
  const { task, loading } = useTaskPolling(numericId);

  // Canvas 检测框
  const { canvasRef, containerRef, redraw } = useCanvasDetections({
    objects: task?.detect_result?.objects || [],
    imageWidth: task?.detect_result?.image_width || 1,
    imageHeight: task?.detect_result?.image_height || 1,
  });

  // 图片 URL（Blob Object URL）
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // 加载图片
  useEffect(() => {
    let url: string | null = null;

    const loadImage = async () => {
      try {
        url = await getTaskImageUrl(numericId);
        setImageUrl(url);
      } catch (err) {
        console.error("加载图片失败:", err);
      }
    };
    loadImage();

    // 清理 Object URL 防止内存泄漏
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [numericId]);

  // 图片加载完成后绘制检测框
  const handleImageLoad = () => {
    redraw();
  };

  if (loading && !task) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        任务不存在
      </div>
    );
  }

  const detectResult = task.detect_result;

  return (
    <div className="flex h-full flex-col">
      {/* 顶栏 */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <button
          onClick={() => navigate(-1)}
          className="rounded-lg p-1 hover:bg-slate-100"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">任务 #{task.id}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            task.status === "completed"
              ? "bg-green-50 text-green-600"
              : task.status === "processing"
                ? "bg-blue-50 text-blue-600"
                : "bg-red-50 text-red-600"
          }`}
        >
          {task.status === "completed"
            ? "已完成"
            : task.status === "processing"
              ? "处理中"
              : "失败"}
        </span>
      </div>

      {/* 内容区域 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：图片 + 检测框 */}
        <div className="flex-1 overflow-auto border-r p-4">
          <div
            ref={containerRef}
            className="relative mx-auto"
            style={{ maxWidth: 800 }}
          >
            {imageUrl && (
              <img
                src={imageUrl}
                alt={`任务 #${task.id}`}
                className="w-full rounded-lg"
                onLoad={handleImageLoad}
              />
            )}

            {/* Canvas 叠加层（absolute 定位，覆盖在 img 上） */}
            <canvas
              ref={canvasRef}
              className="absolute left-0 top-0 h-full w-full pointer-events-none"
            />

            {/* 处理中状态 */}
            {task.status === "processing" && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30">
                <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">正在检测...</span>
                </div>
              </div>
            )}
          </div>

          {/* 缺陷图例 */}
          {detectResult && detectResult.objects.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3">
              {/* 去重后的缺陷类型 */}
              {[...new Set(detectResult.objects.map((o) => o.class))].map(
                (cls) => (
                  <div key={cls} className="flex items-center gap-1.5 text-xs">
                    <div
                      className="h-3 w-3 rounded-sm"
                      style={{ backgroundColor: getDefectColor(cls) }}
                    />
                    <span className="text-slate-600">{cls}</span>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* 右侧：检测结果 + 聊天 */}
        <div className="flex w-96 flex-col">
          {/* 检测结果列表 */}
          <div className="border-b p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">
              检测结果
              {detectResult && (
                <span className="ml-2 text-slate-400">
                  共 {detectResult.total} 个缺陷
                </span>
              )}
            </h2>

            {task.status === "processing" ? (
              <p className="text-sm text-slate-400">等待检测完成...</p>
            ) : !detectResult || detectResult.objects.length === 0 ? (
              <p className="text-sm text-slate-400">未检测到缺陷</p>
            ) : (
              <div className="max-h-60 space-y-2 overflow-auto">
                {detectResult.objects.map((obj, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: getDefectColor(obj.class) }}
                      />
                      <span className="text-slate-700">{obj.class}</span>
                    </div>
                    <span className="text-slate-400">
                      {(obj.confidence * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 聊天区域（Day 12 后替换） */}
          <div className="flex-1 flex items-center justify-center text-sm text-slate-400">
            聊天面板 — Day 12 实现
            {/* <ChatPanel taskId={task.id} /> */}
          </div>
        </div>
      </div>
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **Canvas 的 `pointer-events-none` 做什么？**
   - Canvas 覆盖在图片上方 → 挡住了图片的鼠标事件
   - `pointer-events-none` → 鼠标事件穿透 Canvas → 可以右键保存原图
   - 如果需要点击检测框交互 → 去掉这个属性

2. **`URL.revokeObjectURL` 为什么在 cleanup 中调用？**
   - `getTaskImageUrl` 返回的是 Blob Object URL
   - 组件卸载或 taskId 变化时，旧的 Object URL 不再需要
   - 不 revoke → Blob 留在内存 → 内存泄漏
   - **面试点**："Object URL 引用 Blob 对象，不 revoke 则 Blob 不会被 GC。"

3. **检测结果列表和 Canvas 怎么联动？**
   - 当前没做联动（hover 高亮）
   - 扩展思路：hover 结果列表项 → Canvas 对应检测框高亮（改颜色/加粗）
   - 需要维护一个 `hoveredIndex` 状态，传给 Canvas 绘制函数

---

## Step 8：更新 App.tsx 路由

用实际页面替换 Day 10 的占位组件：

```tsx
// src/App.tsx 中修改

import DashboardPage from "@/pages/DashboardPage";
import DetectPage from "@/pages/DetectPage";
import TaskDetailPage from "@/pages/TaskDetailPage";
// Day 12 后：
// import ChatPage from "@/pages/ChatPage";

// 在 Routes 中替换：
<Route index element={<DashboardPage />} />
<Route path="detect" element={<DetectPage />} />
<Route path="tasks/:taskId" element={<TaskDetailPage />} />
```

---

## Day 11 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/frontend

# 1. 启动后端（Day 4 Tasks API + YOLO）
# 终端 1：
cd ../backend && uv run uvicorn app.main:app --reload --port 8000

# 2. 启动前端
# 终端 2：
pnpm dev

# 3. 浏览器验证：

# a) 首页 (/)
#    → 显示任务列表（如果已有任务）或空状态
#    → 状态筛选 Tabs 可以切换

# b) 上传检测 (/detect)
#    → 拖拽图片到上传区域 → 显示预览
#    → 点 "开始检测" → 上传成功 → 跳转任务详情页

# c) 任务详情 (/tasks/:id)
#    → 左侧显示原图
#    → 处理中 → 图片上有 "正在检测..." 遮罩
#    → 2秒轮询 → 检测完成后：
#      · 遮罩消失
#      · Canvas 上绘制出彩色检测框 + 标签
#      · 右侧显示检测结果列表（缺陷类型 + 置信度）
#      · 底部显示缺陷图例

# d) 缩放浏览器窗口
#    → 图片和检测框自动缩放，检测框位置始终正确

# e) DevTools → Network
#    → 处理中时每 2 秒一个 GET /api/tasks/{id}
#    → 完成后轮询停止

# f) 返回首页
#    → 任务列表中该任务状态更新为"已完成"
```

---

## 文件写作顺序

```
1. src/types/index.ts                  <- 新建（类型 + 颜色映射）
2. src/api/tasks.ts                    <- 新建（任务 API）
3. src/hooks/useTaskPolling.ts         <- 新建（轮询 Hook）
4. src/hooks/useCanvasDetections.ts    <- 新建（Canvas 绘制 Hook）
5. src/pages/DetectPage.tsx            <- 新建（上传检测页）
6. src/pages/DashboardPage.tsx         <- 新建（任务列表页）
7. src/pages/TaskDetailPage.tsx        <- 新建（任务详情页）
8. src/App.tsx                         <- 改（替换占位组件为实际页面）
```

---

## 面试话术（90 秒）

> 前端检测任务流包含三个核心页面：上传检测、任务列表、任务详情。
>
> **上传检测**：拖拽上传实现了自定义 Dropzone，调用后端 multipart/form-data 上传接口。
> 上传成功后自动跳转到任务详情页。
>
> **任务状态轮询**：封装了 `useTaskPolling` Hook，processing 状态每 2 秒轮询一次，
> completed 或 failed 后自动停止。用轮询不用 WebSocket，因为任务状态更新频率低，
> 轮询实现简单、面试解释清晰。
>
> **Canvas 检测框绘制**：用 Canvas 叠加层模式，不修改原图。
> 核心算法是坐标缩放：原始图片坐标 × (显示尺寸 / 原始尺寸) = Canvas 坐标。
> 窗口 resize 时自动重绘，检测框始终和图片对齐。
> Canvas 设置 `pointer-events-none` 让鼠标事件穿透到底层图片。
>
> **图片鉴权**：图片接口需要 Token，但 `<img>` 标签无法携带 Authorization Header。
> 解决方案是用 Axios 下载 Blob，通过 `URL.createObjectURL` 转为临时 URL 赋给 src。
> 组件卸载时 `revokeObjectURL` 防止内存泄漏。
