# Day 10：前端项目搭建 + 登录注册

> 目标：React + Vite + TypeScript + Tailwind + shadcn/ui 搭建前端项目，完成 Axios 封装、Zustand 认证状态、登录注册页面、路由守卫
> 预计文件数：~15 个新建
> 验证工具：浏览器 + 后端 Day 2 的 Auth API

---

## 前置准备

Day 10 开始之前确保：
- 后端 Day 2 的 Auth API 正常（POST /api/auth/register、POST /api/auth/login）
- Node.js 20+、pnpm 已安装

```bash
# 检查 Node 版本
node -v   # >= 20

# 安装 pnpm（如果没有）
corepack enable
corepack prepare pnpm@latest --activate
```

---

## Step 1：创建 Vite + React + TypeScript 项目

```bash
# 在项目根目录（和 backend 同级）
cd /Users/liuchenxu/Documents/Documents/code/rework

# 用 Vite 创建项目
pnpm create vite frontend -- --template react-ts

cd frontend

# 安装依赖
pnpm install
```

**项目初始结构**：
```
frontend/
├── public/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```

**你需要回答自己的问题**：

1. **为什么用 Vite 不用 Create React App（CRA）？**
   - CRA 已停止维护（2023 年起不再更新）
   - Vite 基于 ESBuild + Rollup，开发启动 < 1 秒（CRA 用 Webpack，启动 5-10 秒）
   - HMR（热模块替换）< 50ms（CRA 1-3 秒）
   - **面试点**："Vite 用 ESBuild 做开发时编译（Go 语言写的，比 Babel 快 100 倍），Rollup 做生产构建。"

2. **为什么不用 Next.js？**
   - 毕设是纯 SPA（单页应用），不需要 SSR/SSG
   - Next.js 的 App Router、Server Components 增加学习成本
   - Vite + React 更轻量，面试解释也更清晰
   - **追问**：什么时候该用 Next.js？（需要 SEO、SSR、ISR 的场景，如博客、电商。后台管理系统不需要。）

---

## Step 2：安装核心依赖

```bash
cd frontend

# 路由
pnpm add react-router-dom

# 状态管理
pnpm add zustand

# HTTP 客户端
pnpm add axios

# 图标库
pnpm add lucide-react
```

**你需要回答自己的问题**：

1. **Zustand vs Redux，为什么选 Zustand？**
   - Redux：需要 actions、reducers、dispatch、Provider、connect/selector → 大量 boilerplate
   - Zustand：一个 `create()` 函数就搞定，不需要 Provider 包裹
   - Zustand 包大小 1KB（Redux Toolkit 11KB）
   - **面试话术**："Zustand 零 boilerplate、无 Provider、原生支持 selector 优化渲染。对中小项目 ROI 远高于 Redux。"
   - **追问**：Zustand 适合大型项目吗？（适合。Zustand 支持中间件、devtools、persist。Netflix、Discord 在用。）

2. **为什么用 Axios 而不是原生 fetch？**
   - Axios 支持请求/响应拦截器（自动注入 Token、统一处理 401）
   - 自动序列化 JSON、超时控制、取消请求
   - **注意**：流式聊天场景下用 fetch（Day 12），因为 Axios 不支持浏览器端的 ReadableStream
   - 两者不矛盾：常规 CRUD 用 Axios，流式用 fetch

---

## Step 3：配置 Tailwind CSS 4

```bash
# Tailwind CSS 4 + Vite 插件
pnpm add -D tailwindcss @tailwindcss/vite
```

**修改 `vite.config.ts`**：

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    // 开发环境代理（可选，解决跨域）
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
```

**修改 `src/index.css`**：

```css
/* src/index.css */
/* Tailwind 4 用 @import 代替 @tailwind 指令 */
@import "tailwindcss";
```

**修改 `tsconfig.json`**（添加路径别名）：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,

    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

**你需要回答自己的问题**：

1. **`@` 路径别名是什么？**
   - `import { useAuthStore } from "@/stores/authStore"` → 实际解析为 `./src/stores/authStore`
   - 避免 `../../../stores/authStore` 这样的相对路径地狱
   - 需要在 `vite.config.ts`（构建工具）和 `tsconfig.json`（TypeScript）中都配置

2. **`proxy` 代理做什么？**
   - 开发环境下前端 `localhost:5173`，后端 `localhost:8000`
   - 浏览器直接请求 `http://localhost:8000/api` → 跨域被浏览器拦截
   - 配置 proxy 后：前端请求 `/api/xxx` → Vite 开发服务器代理转发到 `http://localhost:8000/api/xxx`
   - 浏览器看到的是同源请求（`localhost:5173`），不触发 CORS
   - **面试点**："开发环境用 Vite proxy 解决跨域，生产环境用 Nginx 反向代理。"

3. **Tailwind 4 和 Tailwind 3 的区别？**
   - Tailwind 4 不需要 `tailwind.config.ts` 配置文件（零配置）
   - 用 `@import "tailwindcss"` 代替 `@tailwind base/components/utilities`
   - 用 CSS 变量代替 JS 配置主题
   - 性能更好：基于 Rust 的 Oxide 引擎

---

## Step 4：安装 shadcn/ui

```bash
# shadcn/ui 初始化
pnpm dlx shadcn@latest init

# 选择：
# Style: Default
# Base color: Slate
# CSS variables: Yes
```

```bash
# 安装常用组件
pnpm dlx shadcn@latest add button input label card
```

**你需要回答自己的问题**：

1. **shadcn/ui 和普通组件库（Ant Design、MUI）的区别？**
   - Ant Design/MUI：npm 安装后 import 使用，代码在 node_modules 里，不可修改
   - shadcn/ui：把组件源代码直接拷贝到你的 `src/components/ui/` 目录下
   - 好处：完全可定制，不受版本升级影响，按需添加（不会引入用不到的代码）
   - **面试点**："shadcn/ui 不是传统组件库，是组件代码集合。源代码在项目里，完全可控。"

2. **为什么选 shadcn/ui 而不是 Ant Design？**
   - Ant Design 体积大（全量引入 1MB+），中后台风格固定
   - shadcn/ui 基于 Radix UI（无样式原语组件） + Tailwind CSS，灵活度极高
   - 和 Tailwind 天然配合，不需要额外学 CSS-in-JS

---

## Step 5：`src/api/client.ts` — Axios 封装

**完整代码**：

```typescript
// src/api/client.ts
/**
 * Axios 实例封装。
 *
 * 职责：
 *   1. 统一 baseURL 和超时配置
 *   2. 请求拦截器：自动注入 JWT Token
 *   3. 响应拦截器：统一处理 401（Token 过期跳登录）
 *
 * 面试点："拦截器模式 — 请求拦截器统一注入认证信息，
 *          响应拦截器统一处理错误码，避免每个 API 调用写重复逻辑。"
 */

import axios from "axios";

const client = axios.create({
  // 如果配了 Vite proxy，baseURL 可以直接写 "/api"
  // 没配 proxy 就写完整地址
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  timeout: 15_000, // 15 秒超时
  headers: {
    "Content-Type": "application/json",
  },
});

/**
 * 请求拦截器 — 自动附加 JWT Token。
 *
 * 每个请求发出前，从 localStorage 读取 token，
 * 塞到 Authorization header 中。
 *
 * 为什么不存在内存（变量/Zustand）里？
 *   - 页面刷新后内存清空 → 用户要重新登录
 *   - localStorage 持久化 → 刷新后 token 还在
 *   - 安全风险（XSS）已知，生产环境应该用 httpOnly Cookie
 */
client.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("access_token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

/**
 * 响应拦截器 — 统一处理错误。
 *
 * 401：Token 过期或无效 → 清除 token → 跳转登录页
 * 其他错误：直接 reject，交给调用方处理
 */
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("access_token");
      // 避免在登录页死循环跳转
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  }
);

export default client;
```

**你需要回答自己的问题**：

1. **Token 存 localStorage 有什么安全风险？**
   - XSS 攻击可以通过 `document.cookie` 或 `localStorage.getItem()` 窃取 token
   - 更安全的方案：后端设置 `httpOnly Cookie`（JS 无法访问）+ CSRF Token
   - 毕设用 localStorage 是为了简化前后端分离的跨域处理
   - **面试话术**："我知道 localStorage 有 XSS 风险。生产环境应该用 httpOnly Cookie + SameSite + CSRF Token。毕设阶段用 localStorage 简化了跨域认证的复杂度。"

2. **为什么 401 时跳转用 `window.location.href` 而不是 React Router 的 `navigate`？**
   - Axios 拦截器在 React 组件树外部，无法调用 `useNavigate()` Hook
   - `window.location.href` 是硬跳转（重新加载页面），能清除所有状态
   - 更优雅的方案：用事件总线通知 React 组件 → 组件内 `navigate("/login")`
   - 毕设阶段硬跳转足够

3. **`import.meta.env.VITE_API_BASE_URL` 是什么？**
   - Vite 的环境变量，从 `.env` 文件读取
   - 前缀必须是 `VITE_`（安全限制：只有 `VITE_` 开头的变量才会暴露给前端代码）
   - 开发环境：`.env` 写 `VITE_API_BASE_URL=/api`（走 proxy）
   - 生产环境：`.env.production` 写 `VITE_API_BASE_URL=https://api.example.com/api`

---

## Step 6：`src/api/auth.ts` — 认证 API

**完整代码**：

```typescript
// src/api/auth.ts
/**
 * 认证相关 API。
 *
 * 对应后端 Day 2 的 /api/auth/register 和 /api/auth/login。
 */

import client from "./client";

/** 注册请求 */
export interface RegisterRequest {
  username: string;
  password: string;
}

/** 登录请求（FastAPI OAuth2 要求 form-data 格式） */
export interface LoginRequest {
  username: string;
  password: string;
}

/** 登录响应 */
export interface LoginResponse {
  access_token: string;
  token_type: string;
}

/** 用户信息 */
export interface UserInfo {
  id: number;
  username: string;
  is_superuser: boolean;
}

/**
 * 注册。
 *
 * POST /api/auth/register
 * Body: JSON { username, password }
 */
export async function register(data: RegisterRequest): Promise<UserInfo> {
  const resp = await client.post("/auth/register", data);
  return resp.data;
}

/**
 * 登录。
 *
 * POST /api/auth/login
 * Body: application/x-www-form-urlencoded（FastAPI OAuth2PasswordRequestForm 要求）
 *
 * 为什么登录用 form-data 而不是 JSON？
 *   - FastAPI 的 OAuth2PasswordRequestForm 只接受表单格式
 *   - 这是 OAuth2 规范要求的（RFC 6749）
 *   - 所以登录接口要特殊处理 Content-Type
 */
export async function login(data: LoginRequest): Promise<LoginResponse> {
  const formData = new URLSearchParams();
  formData.append("username", data.username);
  formData.append("password", data.password);

  const resp = await client.post("/auth/login", formData, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return resp.data;
}

/**
 * 获取当前用户信息。
 *
 * GET /api/auth/me
 * 需要 Authorization header（拦截器自动注入）
 */
export async function getMe(): Promise<UserInfo> {
  const resp = await client.get("/auth/me");
  return resp.data;
}
```

**你需要回答自己的问题**：

1. **为什么登录用 `URLSearchParams` 而不是 JSON？**
   - 后端 FastAPI 的 `OAuth2PasswordRequestForm` 只接受 `application/x-www-form-urlencoded`
   - 这是 OAuth2 密码模式的规范要求
   - `new URLSearchParams()` → `username=xxx&password=xxx` 格式
   - **追问**：能不能改后端接受 JSON？（可以，但不符合 OAuth2 规范。面试时说"遵循 RFC 6749"更加分）

2. **`getMe()` 什么时候调用？**
   - 页面刷新后，localStorage 有 token 但内存中没有 user 信息
   - App 初始化时调用 `getMe()` → 拿回用户信息 → 存到 Zustand
   - 如果 token 过期 → `getMe()` 返回 401 → 拦截器跳登录页

---

## Step 7：`src/stores/authStore.ts` — 认证状态管理

**完整代码**：

```typescript
// src/stores/authStore.ts
/**
 * 认证状态管理（Zustand）。
 *
 * 管理：用户信息、Token、登录/登出操作。
 *
 * 为什么用 Zustand 而不是 React Context？
 *   - Context 更新时，所有消费者组件都会重新渲染（即使只用了 user.name）
 *   - Zustand 支持 selector：`useAuthStore(s => s.user)` → 只有 user 变化时渲染
 *   - 面试点："Zustand 的 selector 机制避免了 Context 的 over-rendering 问题。"
 */

import { create } from "zustand";
import { getMe, type UserInfo } from "@/api/auth";

interface AuthState {
  /** 当前用户信息（null = 未登录或未加载） */
  user: UserInfo | null;

  /** JWT Token */
  token: string | null;

  /** 是否正在初始化（getMe 加载中） */
  isInitializing: boolean;

  /** 设置认证信息（登录成功后调用） */
  setAuth: (user: UserInfo, token: string) => void;

  /** 登出 */
  logout: () => void;

  /** 是否已登录 */
  isLoggedIn: () => boolean;

  /**
   * 初始化：从 localStorage 恢复登录状态。
   *
   * App 启动时调用一次。
   * 如果 localStorage 有 token → 调 getMe() 拿用户信息。
   * 如果 token 过期 → getMe() 401 → 拦截器清除 token 跳登录。
   */
  initialize: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem("access_token"),
  isInitializing: true,

  setAuth: (user, token) => {
    localStorage.setItem("access_token", token);
    set({ user, token });
  },

  logout: () => {
    localStorage.removeItem("access_token");
    set({ user: null, token: null });
  },

  isLoggedIn: () => !!get().token,

  initialize: async () => {
    const token = localStorage.getItem("access_token");
    if (!token) {
      set({ isInitializing: false });
      return;
    }

    try {
      const user = await getMe();
      set({ user, token, isInitializing: false });
    } catch {
      // Token 过期或无效 → 清除
      localStorage.removeItem("access_token");
      set({ user: null, token: null, isInitializing: false });
    }
  },
}));
```

**你需要回答自己的问题**：

1. **`isInitializing` 有什么用？**
   - App 启动时调用 `getMe()` 验证 token → 是一个异步操作
   - 在 `getMe()` 完成之前，不知道用户是否已登录
   - 如果不等 → 路由守卫看到 `token=null` → 强制跳登录 → 用户体验差
   - `isInitializing=true` 时 → 显示全局 Loading → `getMe()` 完成后再判断路由

2. **Zustand 的 `create` 函数为什么不需要 Provider？**
   - Zustand 用模块级别的全局 store（闭包），不依赖 React 树
   - `create()` 返回一个 Hook，任何组件直接 `useAuthStore()` 就能用
   - 不像 Context 需要 `<Provider value={...}>` 包裹整个应用
   - **面试点**："Zustand 是外部 store 模式，通过 `useSyncExternalStore` 和 React 同步。不依赖组件树，不需要 Provider。"

---

## Step 8：`src/components/ProtectedRoute.tsx` — 路由守卫

**完整代码**：

```tsx
// src/components/ProtectedRoute.tsx
/**
 * 路由守卫组件。
 *
 * 未登录 → 重定向到登录页
 * 正在初始化 → 显示 Loading
 * 已登录 → 渲染子组件
 *
 * 用法：
 *   <Route path="/dashboard" element={
 *     <ProtectedRoute>
 *       <DashboardPage />
 *     </ProtectedRoute>
 *   } />
 */

import { Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";

interface Props {
  children: React.ReactNode;
  /** 是否需要管理员权限 */
  requireAdmin?: boolean;
}

export function ProtectedRoute({ children, requireAdmin }: Props) {
  const { user, isInitializing, isLoggedIn } = useAuthStore();

  // 初始化中 → 显示 Loading（防止闪烁跳转）
  if (isInitializing) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  // 未登录 → 跳转登录页
  if (!isLoggedIn()) {
    return <Navigate to="/login" replace />;
  }

  // 需要管理员但不是管理员 → 跳转首页
  if (requireAdmin && !user?.is_superuser) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
```

**你需要回答自己的问题**：

1. **`replace` 属性做什么？**
   - `<Navigate to="/login" replace />` → 替换当前历史记录
   - 不加 `replace`：用户登录后按浏览器"后退" → 回到被拦截的页面 → 又被重定向 → 死循环
   - 加了 `replace`：登录后按"后退" → 回到登录前的上一个有效页面

2. **为什么要检查 `isInitializing`？**
   - 页面刷新时，Zustand 状态重置为初始值（user=null, token=从localStorage读）
   - `getMe()` 还没完成 → user=null → 路由守卫判定"未登录" → 跳转登录页
   - 但其实用户是登录的（token 有效）→ 这个跳转是错误的
   - 等 `isInitializing=false` 后再判断 → 避免错误跳转

---

## Step 9：`src/pages/LoginPage.tsx` — 登录页

**完整代码**：

```tsx
// src/pages/LoginPage.tsx
/**
 * 登录页面。
 *
 * 表单：用户名 + 密码 + 登录按钮
 * 登录成功 → 存储 token → 跳转首页
 * 登录失败 → 显示错误信息
 */

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { login, getMe } from "@/api/auth";
import { useAuthStore } from "@/stores/authStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // 1. 登录获取 token
      const { access_token } = await login({ username, password });

      // 2. 临时存储 token（让后续 getMe 请求能带上 token）
      localStorage.setItem("access_token", access_token);

      // 3. 获取用户信息
      const user = await getMe();

      // 4. 更新全局状态
      setAuth(user, access_token);

      // 5. 跳转首页
      navigate("/", { replace: true });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        setError(axiosErr.response?.data?.detail || "登录失败");
      } else {
        setError("网络错误，请检查后端是否运行");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">WindSlice</CardTitle>
          <p className="text-sm text-slate-500">风电叶片缺陷检测系统</p>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                required
              />
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "登录中..." : "登录"}
            </Button>

            <p className="text-center text-sm text-slate-500">
              没有账号？{" "}
              <Link to="/register" className="text-blue-500 hover:underline">
                立即注册
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **`e.preventDefault()` 为什么要调用？**
   - `<form>` 的默认 submit 行为是刷新页面（HTTP 表单提交）
   - 我们是 SPA，要用 JS 发 AJAX 请求，不能刷新页面
   - `preventDefault()` 阻止默认行为

2. **为什么登录后还要调 `getMe()`？**
   - 登录接口只返回 `access_token`，不返回用户信息
   - 需要单独调 `getMe()` 拿 `id`、`username`、`is_superuser`
   - **追问**：能不能让登录接口直接返回用户信息？（可以，但 OAuth2 标准的 token endpoint 只返回 token。保持标准更规范。）

3. **错误处理为什么这么复杂？**
   - Axios 错误对象结构是 `{ response: { data: { detail: "..." } } }`
   - 后端 FastAPI 的 HTTPException 返回 `{"detail": "错误信息"}`
   - 网络断开时没有 `response` 对象，只有原生 Error
   - 必须分类处理，否则显示 `[object Object]` 给用户

---

## Step 10：`src/pages/RegisterPage.tsx` — 注册页

**完整代码**：

```tsx
// src/pages/RegisterPage.tsx

import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { register } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function RegisterPage() {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // 前端校验
    if (password !== confirmPassword) {
      setError("两次密码不一致");
      return;
    }
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }

    setLoading(true);
    try {
      await register({ username, password });
      // 注册成功 → 跳转登录页
      navigate("/login", { replace: true });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { detail?: string } } };
        setError(axiosErr.response?.data?.detail || "注册失败");
      } else {
        setError("网络错误");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">注册账号</CardTitle>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="至少 6 位"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">确认密码</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入密码"
                required
              />
            </div>

            {error && (
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </div>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "注册中..." : "注册"}
            </Button>

            <p className="text-center text-sm text-slate-500">
              已有账号？{" "}
              <Link to="/login" className="text-blue-500 hover:underline">
                返回登录
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Step 11：`src/components/Layout.tsx` — 全局布局

**完整代码**：

```tsx
// src/components/Layout.tsx
/**
 * 全局布局组件。
 *
 * 侧边栏导航 + 顶栏用户信息 + 内容区域。
 * 所有需要登录的页面都嵌套在这个布局里。
 */

import { Outlet, NavLink, useNavigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import {
  LayoutDashboard,
  Upload,
  MessageSquare,
  BookOpen,
  LogOut,
} from "lucide-react";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "任务列表" },
  { to: "/detect", icon: Upload, label: "上传检测" },
  { to: "/chat", icon: MessageSquare, label: "智能问答" },
];

const adminNavItems = [
  { to: "/knowledge", icon: BookOpen, label: "知识库管理" },
];

export function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="flex h-screen bg-slate-50">
      {/* 侧边栏 */}
      <aside className="flex w-56 flex-col border-r border-slate-200 bg-white">
        {/* Logo */}
        <div className="flex h-14 items-center border-b px-4">
          <h1 className="text-lg font-bold text-slate-800">WindSlice</h1>
        </div>

        {/* 导航菜单 */}
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-blue-50 text-blue-600 font-medium"
                    : "text-slate-600 hover:bg-slate-100"
                }`
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}

          {/* 管理员菜单 */}
          {user?.is_superuser &&
            adminNavItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-blue-50 text-blue-600 font-medium"
                      : "text-slate-600 hover:bg-slate-100"
                  }`
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
        </nav>

        {/* 用户信息 + 登出 */}
        <div className="border-t p-3">
          <div className="flex items-center justify-between">
            <div className="text-sm">
              <p className="font-medium text-slate-800">{user?.username}</p>
              <p className="text-xs text-slate-400">
                {user?.is_superuser ? "管理员" : "普通用户"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* 内容区域 */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
```

**你需要回答自己的问题**：

1. **`NavLink` 和 `Link` 的区别？**
   - `NavLink` 自动添加 `isActive` 状态 → 当前页面对应的导航项高亮
   - `Link` 只做跳转，没有 active 状态
   - **面试点**："`NavLink` 的 `className` 接收函数参数 `({ isActive }) => ...`，根据当前路由自动判断是否激活。"

2. **`<Outlet />` 是什么？**
   - React Router v6 的嵌套路由出口
   - 子路由的组件渲染在 `<Outlet />` 的位置
   - 类似 Vue 的 `<router-view />`

3. **`end` 属性为什么只在 `/` 路由上加？**
   - `NavLink to="/"` 默认用前缀匹配：`/detect`、`/chat` 都以 `/` 开头 → 首页导航永远高亮
   - `end` 要求精确匹配：只有路径是 `/` 时才高亮
   - 其他路由（`/detect`、`/chat`）不需要 `end`，因为它们不是其他路由的前缀

---

## Step 12：`src/App.tsx` — 路由配置

**完整代码**：

```tsx
// src/App.tsx
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { Layout } from "@/components/Layout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";

// 懒加载页面组件（减少首屏加载体积）
// Day 11 和 Day 12 的页面后续添加
// import DashboardPage from "@/pages/DashboardPage";
// import DetectPage from "@/pages/DetectPage";
// import TaskDetailPage from "@/pages/TaskDetailPage";
// import ChatPage from "@/pages/ChatPage";
// import KnowledgePage from "@/pages/KnowledgePage";

// Day 10 先用占位页面
function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-lg text-slate-400">{title} — 待实现</p>
    </div>
  );
}

export default function App() {
  const initialize = useAuthStore((s) => s.initialize);

  // App 启动时初始化认证状态
  useEffect(() => {
    initialize();
  }, [initialize]);

  return (
    <BrowserRouter>
      <Routes>
        {/* 公开路由（不需要登录） */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* 需要登录的路由（嵌套在 Layout 内） */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<PlaceholderPage title="任务列表" />} />
          <Route path="detect" element={<PlaceholderPage title="上传检测" />} />
          <Route path="tasks/:taskId" element={<PlaceholderPage title="任务详情" />} />
          <Route path="chat" element={<PlaceholderPage title="智能问答" />} />
          <Route path="chat/:taskId" element={<PlaceholderPage title="任务问答" />} />
          <Route
            path="knowledge"
            element={
              <ProtectedRoute requireAdmin>
                <PlaceholderPage title="知识库管理" />
              </ProtectedRoute>
            }
          />
        </Route>

        {/* 404 兜底 → 跳转首页 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
```

---

## Step 13：`src/main.tsx` — 入口文件

```tsx
// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

---

## Step 14：`.env` 环境变量

```bash
# frontend/.env（开发环境）
VITE_API_BASE_URL=/api
```

```bash
# frontend/.env.production（生产环境，构建时自动使用）
VITE_API_BASE_URL=http://your-server:8000/api
```

---

## Day 10 验收清单

```bash
cd /Users/liuchenxu/Documents/Documents/code/rework/frontend

# 1. 启动后端（确保 Auth API 可用）
# 终端 1：
cd ../backend && uv run uvicorn app.main:app --reload --port 8000

# 2. 启动前端
# 终端 2：
cd ../frontend && pnpm dev

# 3. 浏览器验证：

# a) 访问 http://localhost:5173
#    → 被路由守卫重定向到 /login
#    → 登录页显示：WindSlice 标题 + 用户名密码表单

# b) 点 "立即注册" → 跳转注册页
#    → 输入用户名 + 密码 + 确认密码 → 点注册
#    → 注册成功跳转登录页

# c) 登录页输入刚注册的账号 → 点登录
#    → 登录成功跳转首页
#    → 左侧侧边栏显示导航菜单
#    → 底部显示用户名

# d) 点击侧边栏各导航项
#    → 当前项高亮（蓝色）
#    → 内容区显示占位文字

# e) 点退出登录
#    → 跳回登录页
#    → 手动访问 / → 被重定向到 /login

# f) 登录后刷新页面
#    → 不应该跳登录页（token 从 localStorage 恢复）
#    → 用户信息正常显示

# g) 打开 DevTools → Application → Local Storage
#    → 能看到 access_token
#    → 退出登录后 token 被清除

# h) 错误场景：输入错误密码
#    → 显示 "用户名或密码错误"（后端返回的 detail）
```

---

## 文件写作顺序

```
1. 创建项目：pnpm create vite frontend -- --template react-ts
2. 安装依赖：pnpm add react-router-dom zustand axios lucide-react
3. 配置 Tailwind：pnpm add -D tailwindcss @tailwindcss/vite
4. 配置 shadcn：pnpm dlx shadcn@latest init && pnpm dlx shadcn@latest add button input label card
5. vite.config.ts          <- 改（proxy + alias）
6. tsconfig.json           <- 改（paths alias）
7. src/index.css           <- 改（Tailwind import）
8. .env                    <- 新建
9. src/api/client.ts       <- 新建
10. src/api/auth.ts        <- 新建
11. src/types/chat.ts      <- 新建（Day 12 用，先建好）
12. src/stores/authStore.ts <- 新建
13. src/components/ProtectedRoute.tsx <- 新建
14. src/components/Layout.tsx         <- 新建
15. src/pages/LoginPage.tsx           <- 新建
16. src/pages/RegisterPage.tsx        <- 新建
17. src/App.tsx             <- 改（路由配置）
18. src/main.tsx            <- 改（确认 import index.css）
```

---

## 面试话术（90 秒）

> 前端用 React + Vite + TypeScript + Tailwind CSS + shadcn/ui 技术栈。
>
> **为什么这套组合？** Vite 基于 ESBuild，开发启动 < 1 秒，HMR < 50ms。
> Tailwind 原子化 CSS 不写 CSS 文件。shadcn/ui 把组件源代码拷贝到项目里，完全可定制。
>
> **状态管理用 Zustand**，零 boilerplate、不需要 Provider 包裹。
> 原生支持 selector 自动优化渲染，避免 Context 的 over-rendering 问题。
>
> **认证流程**：登录获取 JWT → 存 localStorage → Axios 请求拦截器自动注入 Authorization Header。
> 响应拦截器统一处理 401 → 清除 token → 跳转登录页。
> 路由守卫组件包裹需要认证的页面，支持管理员权限控制。
>
> **我知道 localStorage 存 Token 有 XSS 风险**，生产环境应该用 httpOnly Cookie + CSRF Token。
> 毕设用 localStorage 是为了简化前后端分离的跨域认证。
