# 前端架构与 React —— 面试深度知识文档

> 本文档基于 REWORK 智能检测平台的真实前端项目（React 19 + Vite 8 + Zustand 5 + React Router v7），面向面试准备，涵盖理论原理与项目实战。
>
> **审校状态（2026-04-03）**
> - 当前仓库真实流式实现：`fetch + ReadableStream + text/plain`
> - 本文中的 SSE 内容保留为**对比知识**，不能讲成当前前端用了 `EventSource` 或标准 `text/event-stream`

---

## 一、React 核心概念

### 1.1 虚拟 DOM 的原理

**是什么：**
虚拟 DOM（Virtual DOM）是 React 对真实 DOM 的一层 JavaScript 对象抽象。每次组件 render 时，React 不直接操作浏览器 DOM，而是先在内存中构建一棵由普通 JS 对象组成的虚拟 DOM 树，然后将新旧两棵虚拟 DOM 树进行对比（Diff），找出最小变更集合，最后批量更新到真实 DOM。

**为什么需要：**
直接操作真实 DOM 的代价非常高——每次 DOM 操作都可能触发浏览器的 Reflow（回流/重排）和 Repaint（重绘）。Reflow 会重新计算元素的几何属性（位置、大小），Repaint 会重新绘制像素。如果你在一个循环中对 DOM 做 100 次修改，浏览器可能触发 100 次回流，性能灾难性地下降。

虚拟 DOM 的核心价值：
1. **批量更新**：将多次状态变更合并为一次 DOM 操作
2. **跨平台抽象**：虚拟 DOM 是纯 JS 对象，可以渲染到浏览器 DOM、React Native、Canvas 等任何目标
3. **声明式编程模型**：开发者只描述"界面应该长什么样"，React 负责计算"怎么从当前状态变到目标状态"

**原理细节：**

```
JSX 代码:
<div className="card">
  <h1>标题</h1>
</div>

编译后 (Babel/SWC 转换):
React.createElement("div", { className: "card" },
  React.createElement("h1", null, "标题")
)

生成的虚拟 DOM 对象:
{
  type: "div",
  props: {
    className: "card",
    children: {
      type: "h1",
      props: { children: "标题" }
    }
  }
}
```

React 的更新流程：
1. 状态变更 → 触发组件重新 render → 生成新的虚拟 DOM 树
2. Diff 算法对比新旧两棵树，生成补丁（Patch）列表
3. 将补丁批量应用到真实 DOM

### 1.2 Reconciliation（协调算法）

**是什么：**
Reconciliation 是 React 对比新旧虚拟 DOM 树、决定哪些真实 DOM 节点需要更新的算法。这是 React 性能的核心。

**算法复杂度优化：**
理论上，两棵树的完整 Diff 是 O(n³) 的时间复杂度。React 基于两个启发式假设将其优化到 O(n)：

1. **不同类型的元素会产生不同的树**：如果根节点类型从 `<div>` 变为 `<span>`，React 直接销毁旧树、构建新树，不做逐节点对比
2. **通过 key 属性标识同层级子元素的稳定身份**：React 只在同一层级做横向对比，不跨层级

**key 的关键作用——面试重点：**

```jsx
// 错误示范：用 index 作为 key
{tasks.map((task, index) => (
  <TaskRow key={index} task={task} />
))}

// 正确做法：用唯一业务 ID 作为 key
{tasks.map((task) => (
  <TaskRow key={task.id} task={task} />
))}
```

为什么 index 作为 key 是危险的？当列表项发生增删或重排时，index 会变化，导致 React 错误地复用 DOM 节点。例如列表头部插入一项，所有后续项的 index 都会 +1，React 会认为每一项都变了，触发不必要的重渲染。更严重的是，如果子组件有内部状态（如输入框的值），状态会错误地"漂移"到其他项。

**项目实战：**
项目中 `TaskCenterPage.jsx` 的缺陷列表和 `ChatMessageList.jsx` 的消息列表都使用了业务唯一 ID 作为 key：

```jsx
// TaskCenterPage.jsx - 缺陷统计列表
{defectStats.ranked.map(({ cls, count, avgConf, pct }) => (
  <li className="defect-rank-item" key={cls}>
    ...
  </li>
))}

// ChatMessageList.jsx - 消息列表
{messages.map((message) => (
  <ChatMessageCard key={message.id} message={message} />
))}
```

### 1.3 React Hooks 详解

#### useState：状态管理的基石

**是什么：** `useState` 让函数组件拥有状态。返回 `[当前值, setter函数]`。

**原理：** React 内部维护一个 Hook 链表（Fiber 节点上的 memoizedState 链表），每次渲染按调用顺序遍历。这就是为什么 Hooks 不能写在条件语句或循环中——顺序必须稳定。

**关键细节——setter 的两种调用方式：**

```jsx
// 方式 1: 直接传值（用旧值覆盖）
setCount(5)

// 方式 2: 传函数（基于前一个状态计算——在异步场景中更安全）
setCount((prev) => prev + 1)
```

**项目实战——useChatSession.js 中的函数式更新：**
项目中 `useChatSession.js` 大量使用函数式更新，因为流式通信场景下 `setMessages` 的调用频率极高，且每次更新都依赖前一个状态：

```jsx
// 流式接收 chunk 时，每次都基于当前 messages 做追加/替换
setMessages((currentMessages) =>
  appendAssistantMessage(
    currentMessages,
    getDraftMessage(parsed.content, parsed, assistantCreatedAt, assistantDraftId),
    assistantDraftId,
  ),
)
```

如果这里用 `setMessages(newMessages)` 直接传值，在高频更新场景下，前面的更新可能还没反映到 state 中，新的更新就覆盖了旧的，导致消息丢失。函数式更新保证每次都读到最新的 state。

#### useEffect：副作用管理

**是什么：** `useEffect` 用于处理副作用：API 调用、订阅、定时器、DOM 操作等。

**执行时机：**
- 组件挂载后执行（类似 componentDidMount）
- 依赖变化时执行（类似 componentDidUpdate）
- 返回的清理函数在组件卸载或重新执行 effect 前执行（类似 componentWillUnmount）

**依赖数组的三种形态：**

```jsx
useEffect(() => { ... })          // 每次渲染后都执行（几乎不该这么用）
useEffect(() => { ... }, [])      // 仅挂载时执行一次
useEffect(() => { ... }, [dep])   // dep 变化时执行
```

**项目实战——AuthBootstrap.jsx 的启动引导：**

```jsx
// AuthBootstrap.jsx
React.useEffect(() => {
  let active = true  // 防止组件卸载后设置状态

  async function bootstrap() {
    if (!token) {
      if (active) {
        setHydrated(true)
      }
      return
    }

    try {
      const currentUser = await getCurrentUser()
      if (active) {
        setUserInfo(currentUser)
        setHydrated(true)
      }
    } catch {
      if (active) {
        clearAuth()
      }
    }
  }

  bootstrap()

  return () => {
    active = false  // 清理：标记组件已卸载
  }
}, [clearAuth, setHydrated, setUserInfo, token])
```

这里的 `active` 标志是一个**经典的防止内存泄漏模式**：如果 API 请求还在进行中但组件已经卸载了，`active = false` 会阻止在已卸载组件上调用 setState，避免 React 报 warning。

**项目实战——useTaskList.js 的轮询清理：**

```jsx
// useTaskList.js
React.useEffect(() => {
  mountedRef.current = true

  return () => {
    mountedRef.current = false
    clearPollingTimer()  // 组件卸载时清除轮询定时器，防止内存泄漏
  }
}, [clearPollingTimer])
```

#### useRef：跨渲染周期的可变容器

**是什么：** `useRef` 返回一个 `{ current: value }` 的可变对象，这个对象在组件的整个生命周期内保持不变（同一个引用）。修改 `ref.current` 不会触发重渲染。

**与 useState 的本质区别：**
- `useState`：值变化 → 触发重渲染 → 组件函数重新执行
- `useRef`：值变化 → 不触发重渲染 → 组件函数不重新执行

**使用场景：**
1. 访问 DOM 元素
2. 存储不需要触发重渲染的可变值（定时器 ID、请求 ID、上一次值等）
3. 在异步回调中读取最新值（闭包陷阱的解决方案）

**项目实战——竞态条件处理（loadRequestIdRef）：**

这是本项目中 useRef 最精彩的用法。在 `useChatSession.js` 和 `useTaskList.js` 中，`requestIdRef` 用于解决**竞态条件（Race Condition）**：

```jsx
// useChatSession.js
const loadRequestIdRef = useRef(0)

const loadHistory = useCallback(async () => {
  // 每次发起请求前，递增 requestId
  const requestId = loadRequestIdRef.current + 1
  loadRequestIdRef.current = requestId

  try {
    const history = await getChatHistory({ taskId })

    // 请求返回后，检查当前 requestId 是否还是自己
    // 如果不是，说明有更新的请求已经发出，丢弃本次结果
    if (loadRequestIdRef.current !== requestId) {
      return
    }

    setMessages(historyMessages)
  } catch (loadError) {
    if (loadRequestIdRef.current !== requestId) {
      return  // 同样丢弃过期请求的错误
    }
    setError(loadError)
  }
}, [taskId])
```

**竞态条件场景解释：**
用户快速切换 taskId（比如从任务 A 切到任务 B），触发两次 `loadHistory`。请求 A 先发出但后返回，请求 B 后发出但先返回。如果没有 `requestIdRef` 守卫，请求 A 的结果会覆盖请求 B 的结果，用户看到的是任务 A 的数据，但实际已经切到了任务 B。

**项目实战——mutationVersionRef 防止轮询覆盖用户操作：**

```jsx
// useChatSession.js
const mutationVersionRef = useRef(0)

// 发送消息时递增 mutationVersion
const sendMessage = useCallback(async ({ question, images }) => {
  mutationVersionRef.current += 1
  // ...
}, [taskId])

// 加载历史时检查 mutationVersion
const loadHistory = useCallback(async () => {
  const mutationVersion = mutationVersionRef.current

  const history = await getChatHistory({ taskId })

  setMessages((currentMessages) => {
    // 如果加载期间用户发送了新消息，需要合并而不是覆盖
    if (sendingRef.current || mutationVersionRef.current !== mutationVersion) {
      return mergeHistoryWithLocalMessages(historyMessages, currentMessages)
    }
    return historyMessages
  })
}, [taskId])
```

**项目实战——sendingRef 避免重复发送：**

```jsx
// useChatSession.js
const sendingRef = useRef(false)

const sendMessage = useCallback(async ({ question, images }) => {
  // 用 ref 而不是 state 做防重入检查，因为不需要触发重渲染
  if (sendingRef.current) {
    return
  }
  sendingRef.current = true
  // ...
  sendingRef.current = false
}, [taskId])
```

为什么不用 `sending` state 做防重入？因为 React state 更新是异步的，在极短时间内连续调用 `sendMessage`，两次调用可能读到同一个 `sending = false`，导致重复发送。`ref.current` 的修改是同步的、立即生效的。

**项目实战——isNearBottomRef 智能滚动：**

```jsx
// ChatMessageList.jsx
const isNearBottomRef = React.useRef(true)

const handleScroll = React.useCallback(() => {
  const el = containerRef.current
  if (!el) return
  // 距离底部 100px 以内视为"在底部"
  isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}, [])

React.useEffect(() => {
  // 只有用户在底部附近时才自动滚动
  if (isNearBottomRef.current) {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }
}, [messages])
```

这是一个优秀的 UX 细节：如果用户正在回看历史消息（不在底部），新消息到来时不强制滚到底部打断用户阅读。用 ref 而不是 state，因为滚动位置的变化不需要触发重渲染。

#### useMemo：避免昂贵计算的重复执行

**是什么：** `useMemo` 缓存一个计算结果，只在依赖变化时重新计算。

**原理：** React 存储上一次的依赖和结果。每次渲染时比较依赖（浅比较），相同则返回缓存值，不同则重新计算。

**项目实战——TaskCenterPage.jsx 的缺陷统计：**

```jsx
// TaskCenterPage.jsx
const defectStats = React.useMemo(() => {
  const stats = {}
  let totalDefects = 0
  const owners = new Set()

  for (const task of tasks) {
    if (task.owner?.username) {
      owners.add(task.owner.username)
    }
    if (!task.detect_result?.objects?.length) continue
    for (const obj of task.detect_result.objects) {
      const cls = obj.class || "unknown"
      if (!stats[cls]) {
        stats[cls] = { count: 0, totalConf: 0 }
      }
      stats[cls].count += 1
      stats[cls].totalConf += (obj.confidence ?? 0)
      totalDefects += 1
    }
  }

  const ranked = Object.entries(stats)
    .map(([cls, { count, totalConf }]) => ({
      cls,
      count,
      avgConf: Math.round((totalConf / count) * 100),
      pct: totalDefects > 0 ? Math.round((count / totalDefects) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count)

  return { ranked, totalDefects, ownerCount: owners.size }
}, [tasks])
```

这个 `useMemo` 的价值：`tasks` 数组可能包含大量任务，每个任务可能包含多个检测对象。这个双层循环遍历 + 排序的计算开销不小。`TaskCenterPage` 可能因为 `filters` 等其他 state 变化而频繁重渲染，如果没有 `useMemo`，每次渲染都要重新计算缺陷统计，而实际上 `tasks` 并没有变化。

**什么时候不该用 useMemo：**
- 计算非常简单（如字符串拼接、简单条件判断）
- 依赖每次都变化（缓存失效，白白增加了对比开销）

#### useCallback：避免函数引用变化导致子组件重渲染

**是什么：** `useCallback` 缓存一个函数引用，只在依赖变化时创建新函数。

**原理：** 本质上 `useCallback(fn, deps)` 等价于 `useMemo(() => fn, deps)`。

**为什么需要：** 每次组件渲染时，内联函数都会创建新的引用。如果这个函数作为 prop 传给子组件，即使逻辑完全一样，新引用会让 React 认为 prop 变了，导致子组件不必要的重渲染。

**项目实战——useTaskList.js 的回调：**

```jsx
// useTaskList.js
const clearPollingTimer = React.useCallback(() => {
  if (pollingTimerRef.current !== null) {
    clearTimeout(pollingTimerRef.current)
    pollingTimerRef.current = null
  }
}, [])

const loadTasks = React.useCallback(
  async (nextPage = page, nextPageSize = pageSize) => {
    const requestId = ++requestIdRef.current
    clearPollingTimer()
    // ...
  },
  [clearPollingTimer, page, pageSize, pollIntervalMs],
)

const refresh = React.useCallback(() => {
  return loadTasks(page, pageSize)
}, [loadTasks, page, pageSize])
```

注意依赖链：`clearPollingTimer` → `loadTasks` → `refresh`。`clearPollingTimer` 依赖为空数组，永远不变；`loadTasks` 只在分页参数变化时才变；`refresh` 只在 `loadTasks` 变化时才变。这样避免了不必要的重创建和子组件重渲染。

**项目实战——ChatMessageList.jsx 的 handleScroll：**

```jsx
const handleScroll = React.useCallback(() => {
  const el = containerRef.current
  if (!el) return
  isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}, [])
```

`handleScroll` 被传给 `<GlassPanel onScroll={handleScroll}>`，空依赖保证函数引用不变，GlassPanel 不会因为父组件重渲染而重新注册滚动事件。

---

## 二、React Router

### 2.1 客户端路由 vs 服务端路由

**服务端路由（传统模式）：**
- 每次 URL 变化 → 浏览器向服务器发送 HTTP 请求 → 服务器返回完整 HTML → 整页刷新
- 特点：每次导航都有网络请求、白屏等待、页面闪烁

**客户端路由（SPA 模式）：**
- 首次加载时下载整个应用的 JS Bundle
- 之后 URL 变化 → JavaScript 拦截导航事件 → 在客户端切换组件 → 无需网络请求
- 技术基础：HTML5 History API（`pushState` / `replaceState`）或 Hash（`#`）
- 特点：导航瞬间完成、无白屏、更流畅的用户体验

**项目使用 `createBrowserRouter`，即 History API 模式：**

```jsx
// router.jsx
export function createAppRouter() {
  return createBrowserRouter(routes)
}
```

### 2.2 React Router v7 核心概念

项目使用 `react-router-dom@^7.13.1`。

**核心概念：**

1. **`<RouterProvider>`**：新版推荐的路由入口，接收一个 router 对象
2. **`<Outlet>`**：类似 Vue 的 `<router-view>`，渲染子路由匹配的组件
3. **`<NavLink>`**：带有"激活状态"的导航链接
4. **`<Navigate>`**：声明式重定向组件
5. **嵌套路由**：子路由的 path 自动拼接到父路由

**项目路由结构：**

```jsx
// router.jsx
export const routes = [
  // 公开路由 —— 不需要登录
  { path: "/login",    element: <LazyLoginPage /> },
  { path: "/register", element: <LazyRegisterPage /> },

  // 受保护路由 —— 需要登录
  {
    element: <ProtectedRoute />,     // 路由守卫（无 path，纯布局路由）
    children: [
      {
        element: <AppShell />,       // 布局组件（侧边栏 + 顶栏 + Outlet）
        children: [
          { index: true, element: <LazyHomePage /> },           // "/"
          { path: "/tasks", element: <LazyTaskCenterPage /> },  // "/tasks"
          { path: "/tasks/:taskId", element: <LazyTaskDetailPage /> },
          { path: "/chat", element: <LazyChatPage /> },

          // 管理员路由 —— 嵌套第二层守卫
          {
            element: <AdminRoute />,
            children: [
              { path: "/knowledge/documents", ... },
              { path: "/knowledge/rebuild", ... },
              { path: "/knowledge/chunk-configs", ... },
              { path: "/users", ... },
            ],
          },
        ],
      },
    ],
  },
]
```

**嵌套层级可视化：**

```
/login → LoginPage（无布局壳）
/register → RegisterPage（无布局壳）

/ → ProtectedRoute 守卫
  └─ AppShell 布局
     ├─ / → HomePage
     ├─ /tasks → TaskCenterPage
     ├─ /tasks/:taskId → TaskDetailPage
     ├─ /chat → ChatPage
     └─ AdminRoute 守卫
        ├─ /knowledge/documents → KnowledgeDocumentsPage
        ├─ /knowledge/rebuild → KnowledgeRebuildPage
        ├─ /knowledge/chunk-configs → KnowledgeChunkConfigsPage
        └─ /users → UsersPage
```

### 2.3 路由懒加载（React.lazy + Suspense）

**为什么需要：** 如果所有页面都打包到一个 JS 文件中，用户首次加载时需要下载整个应用的代码，即使他只访问登录页。代码分割（Code Splitting）按路由拆分 bundle，用户访问某个页面时才加载对应代码。

**项目实现：**

```jsx
// router.jsx
// 通用懒加载工具函数，处理命名导出
function lazyPage(loadPage, exportName) {
  return React.lazy(() =>
    loadPage().then((module) => ({
      default: module[exportName],  // 将命名导出转为 default 导出（React.lazy 要求）
    })),
  )
}

// 通用 Suspense 包装
function withPageFallback(element) {
  return (
    <React.Suspense fallback={<div role="status">页面加载中...</div>}>
      {element}
    </React.Suspense>
  )
}

// 使用
const LazyLoginPage = lazyPage(() => import("../pages/LoginPage.jsx"), "LoginPage")
const LazyTaskCenterPage = lazyPage(() => import("../pages/TaskCenterPage.jsx"), "TaskCenterPage")
```

**技术细节：**

1. `import("../pages/LoginPage.jsx")` 是 ES 动态 import，Vite 会自动将其拆分为独立的 chunk 文件
2. `React.lazy` 要求 `default` 导出。项目中的页面组件都是命名导出（`export function LoginPage`），所以 `lazyPage` 做了转换
3. `<Suspense fallback={...}>` 在 chunk 加载期间展示 fallback UI，避免白屏

### 2.4 路由守卫的实现

**项目实现了两级路由守卫：**

**第一级：ProtectedRoute —— 登录守卫**

```jsx
// ProtectedRoute.jsx
export function ProtectedRoute() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)
  const location = useLocation()

  // 阶段 1：AuthBootstrap 还没完成验证，显示加载状态
  if (!hydrated) {
    return <div role="status">正在验证登录状态...</div>
  }

  // 阶段 2：没有 token，重定向到登录页，同时记录来源位置
  if (!token) {
    return <Navigate replace state={{ from: location }} to="/login" />
  }

  // 阶段 3：有 token，渲染子路由
  return <Outlet />
}
```

关键细节：`state={{ from: location }}` 将用户原来想访问的页面保存到路由状态中。登录成功后可以通过 `location.state?.from?.pathname` 重定向回去，而不是粗暴地跳到首页。这是一个优秀的 UX 体验。

**第二级：AdminRoute —— 角色守卫**

```jsx
// AdminRoute.jsx
export function AdminRoute() {
  const isSuperuser = useAuthStore((state) => state.userInfo?.is_superuser)

  if (!isSuperuser) {
    return <Navigate replace to="/" />
  }

  return <Outlet />
}
```

`AdminRoute` 嵌套在 `ProtectedRoute` 内部，所以执行到这里时 token 一定存在、userInfo 一定已加载。如果用户不是超级管理员，静默重定向到首页。

---

## 三、状态管理（Zustand）

### 3.1 为什么用 Zustand 而不是 Redux？

| 维度 | Redux | Zustand |
|------|-------|---------|
| 样板代码 | 大量：action types + action creators + reducers + store config | 极少：一个 `create()` 搞定 |
| 学习曲线 | 高：需理解 dispatch、middleware、combineReducers、thunk/saga 等 | 低：就是一个带 set 函数的对象 |
| Bundle 大小 | ~7KB (redux + react-redux) | ~1.5KB |
| TypeScript 支持 | 需要额外配置，类型推断复杂 | 原生优秀 |
| 组件外访问 | 需要 store.getState() 且不太常规 | `useXxxStore.getState()` 原生支持 |
| DevTools | 有 | 有中间件支持 |
| 异步 | 需要 thunk/saga | 直接在 action 里 async/await |

**Zustand 最大的杀手锏：可以在 React 组件外部访问状态。** 项目中 `http.js` 拦截器就利用了这个特性：

```jsx
// http.js —— 这不是 React 组件，但可以直接读取 store
http.interceptors.request.use((config) =>
  applyAuthHeader(config, useAuthStore.getState().token)
)

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      useAuthStore.getState().clearAuth()  // 组件外部调用 action
    }
    return Promise.reject(error)
  }
)
```

在 Redux 中，要在拦截器里访问 store 需要先导出 store 实例，或者使用复杂的中间件模式。Zustand 的 `getState()` 让这一切变得自然。

### 3.2 Zustand 的核心原理

Zustand 的核心是一个发布-订阅模式。简化版实现大约 40 行代码：

```javascript
function createStore(createState) {
  let state
  const listeners = new Set()

  function getState() {
    return state
  }

  function setState(partial) {
    const nextState = typeof partial === 'function' ? partial(state) : partial
    if (!Object.is(state, nextState)) {
      state = { ...state, ...nextState }
      listeners.forEach(listener => listener(state))
    }
  }

  // 初始化 state
  state = createState(setState, getState)

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { getState, setState, subscribe }
}
```

在 React 中，Zustand 通过 `useSyncExternalStore`（React 18+ 内置 Hook）将外部 store 与 React 渲染周期同步：

```javascript
function useStore(selector) {
  return React.useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
  )
}
```

**`useSyncExternalStore` 的价值：** React 18 引入并发特性后，如果外部 store 不正确同步，可能出现 "tearing"（撕裂）——同一次渲染中不同组件读到 store 的不同版本。`useSyncExternalStore` 保证渲染一致性。

### 3.3 persist 中间件：localStorage 持久化

**为什么需要：** 用户刷新页面后，内存中的 store 会被清空。Token 和用户信息需要持久化到 localStorage，否则每次刷新都要重新登录。

**项目实现：**

```jsx
// auth-store.js
export const useAuthStore = create(
  persist(
    (set) => ({
      hydrated: false,
      token: null,
      userInfo: null,
      setHydrated: (hydrated) => set({ hydrated }),
      setUserInfo: (userInfo) => set({ userInfo }),
      clearAuth: () => set({ hydrated: true, token: null, userInfo: null }),
      setAuth: ({ token, userInfo }) => set({ hydrated: true, token, userInfo }),
    }),
    {
      name: AUTH_STORAGE_KEY,       // localStorage 的 key："rework-auth"
      storage: authStorage,         // 自定义存储适配器
      partialize: (state) => ({     // 只持久化 token 和 userInfo
        token: state.token,
        userInfo: state.userInfo,
      }),
    },
  ),
)
```

### 3.4 partialize：选择性持久化

**为什么需要 partialize：** 并非所有状态都应该持久化。`hydrated` 是一个运行时标志（表示 AuthBootstrap 是否完成了 token 验证），不应该保存到 localStorage。如果不用 `partialize`，localStorage 中会存储 `hydrated: true`，下次加载时直接读到 `true`，跳过了 token 验证环节，可能用过期 token 访问 API。

```jsx
partialize: (state) => ({
  token: state.token,       // 持久化
  userInfo: state.userInfo,  // 持久化
  // hydrated: 不持久化，每次启动都从 false 开始
})
```

### 3.5 自定义 storage 适配器

```jsx
const authStorage = {
  getItem: (name) => {
    const storedValue = window.localStorage.getItem(name)
    return storedValue ? JSON.parse(storedValue) : null
  },
  setItem: (name, value) => {
    window.localStorage.setItem(name, JSON.stringify(value))
  },
  removeItem: (name) => {
    window.localStorage.removeItem(name)
  },
}
```

为什么要自定义？Zustand v5 的 `persist` 中间件要求 storage 适配器的 `getItem` 返回解析后的对象（而非字符串），`setItem` 接收对象（而非字符串）。浏览器原生的 `localStorage` 只支持字符串，所以需要包装一层 JSON 序列化/反序列化。

### 3.6 useShellStore —— 简单 store 示例

```jsx
// useShellStore.js
export const useShellStore = create((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () =>
    set((state) => ({
      sidebarCollapsed: !state.sidebarCollapsed,
    })),
}))
```

这个 store 没有 `persist`，因为侧边栏的展开/折叠状态不需要跨会话保持。它展示了 Zustand 最简形态：一个初始值 + 一个 action。

---

## 四、HTTP 通信

### 4.1 Axios 实例化和配置

**为什么要创建 Axios 实例而不是直接用 `axios.get()`：**
1. 可以设置统一的 `baseURL`，避免每个 API 调用都写完整 URL
2. 可以挂载拦截器，统一处理认证、错误
3. 多个后端服务可以创建多个实例，各自独立配置

```jsx
// http.js
export const http = axios.create({
  baseURL: "/api",  // 所有请求自动加上 /api 前缀
})
```

### 4.2 请求拦截器：自动附加 Token

```jsx
// http.js
export function applyAuthHeader(config, token) {
  const nextConfig = {
    ...config,
    headers: {
      ...(config.headers ?? {}),
    },
  }

  if (token) {
    nextConfig.headers.Authorization = `Bearer ${token}`
  }

  return nextConfig
}

http.interceptors.request.use((config) =>
  applyAuthHeader(config, useAuthStore.getState().token)
)
```

**每次请求发出前：**
1. 从 Zustand store 读取最新的 token（注意是 `getState()` 同步读取，不是 hook 订阅）
2. 如果 token 存在，添加 `Authorization: Bearer <token>` 请求头
3. 不可变更新：创建新的 config 对象，不修改原始 config

**为什么不把 token 存到 Axios 的默认 headers？** 因为 token 可能随时变化（登录、登出、刷新），每次请求时从 store 实时读取更可靠。

### 4.3 响应拦截器：401 自动登出

```jsx
// http.js
export function handleHttpError(error) {
  if (error?.response?.status === 401) {
    useAuthStore.getState().clearAuth()  // 清除 token 和 userInfo
  }
  return Promise.reject(error)  // 继续抛出错误，让调用方感知
}

http.interceptors.response.use(
  (response) => response,           // 成功时直接放行
  handleHttpError                    // 失败时检查 401
)
```

**401 的含义：** 服务器返回 `401 Unauthorized`，表示 token 无效或已过期。此时前端应该：
1. 清除本地的 token（`clearAuth`）
2. 因为 `ProtectedRoute` 监听 `token`，token 变为 null 后会自动重定向到 `/login`
3. 继续 `reject` 错误，让具体的业务代码决定是否需要额外处理（如显示 Toast）

### 4.4 文件下载

```jsx
// http.js
export async function downloadFile(url, config = {}) {
  const response = await http.get(url, {
    ...config,
    responseType: "blob",  // 以二进制 Blob 接收响应
  })

  // 从 Content-Disposition 头解析文件名
  const disposition = response.headers?.["content-disposition"] ?? ""
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i)
  const filename = match ? decodeURIComponent(match[1]) : "download"

  // 创建临时 URL → 触发下载 → 清理
  const blobUrl = URL.createObjectURL(response.data)
  const anchor = document.createElement("a")
  anchor.href = blobUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(blobUrl)  // 释放内存

  return response
}
```

这是浏览器端文件下载的标准模式：通过创建隐藏的 `<a>` 标签并模拟点击来触发下载，因为直接 window.open 无法附加 Authorization 请求头。

---

## 五、流式通信（HTTP Streaming / SSE 对比）

### 5.1 为什么不用 WebSocket，而是用基于 fetch 的 HTTP 流式读取？

| 维度 | HTTP Streaming（本项目） | WebSocket |
|------|---------------------------|-----------|
| 方向 | 客户端先 POST，服务端单向分块返回 | 双向 |
| 协议 | 标准 HTTP | 自有协议 (ws://) |
| 鉴权 / 上传图片 | 直接复用现有 `fetch + FormData + Authorization` | 需要额外协议设计 |
| 负载均衡 / 代理 | 友好（HTTP 协议） | 需要特殊配置 |
| 适用场景 | AI 单向流式输出 | 实时聊天、游戏、协同编辑 |

**本项目选择 HTTP 流式读取的原因：** AI 模型推理是典型的单向流。用户一次性 POST 问题和图片，服务器逐 token 返回回答，不需要双向实时通信，因此没有必要引入 WebSocket。

**SSE 在这里是对比知识，不是当前实现。**  
项目没有使用浏览器原生 `EventSource`，因为 `EventSource` 只支持 GET，且不适合当前的 `POST + FormData + Authorization` 组合。真实实现是 **Fetch API + ReadableStream**。

### 5.2 fetch API 读取 ReadableStream

```jsx
// chat-api.js
export async function streamChat({ question, taskId, images, onChunk, signal } = {}) {
  const payload = new FormData()
  payload.append("question", question ?? "")

  if (taskId !== undefined && taskId !== null && taskId !== "") {
    payload.append("task_id", String(taskId))
  }

  for (const image of normalizeFiles(images)) {
    payload.append("images", image)
  }

  // 使用原生 fetch 而不是 Axios
  const token = useAuthStore.getState().token
  const response = await fetch("/api/chat/stream", {
    body: payload,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    method: "POST",
    signal,  // 支持 AbortController 取消
  })

  if (!response.ok) {
    if (response.status === 401) {
      useAuthStore.getState().clearAuth()
    }
    throw await buildStreamError(response)
  }

  // 获取 ReadableStream 的 reader
  const reader = response.body?.getReader()
  if (!reader) return ""

  const decoder = new TextDecoder()
  let content = ""

  // 循环读取流数据
  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    // value 是 Uint8Array，需要 TextDecoder 解码为字符串
    const chunk = decoder.decode(value, { stream: true })
    content += chunk
    onChunk?.(chunk)  // 每收到一块数据就回调
  }

  // 处理 TextDecoder 的残留字节
  const remaining = decoder.decode()
  if (remaining) {
    content += remaining
    onChunk?.(remaining)
  }

  return content
}
```

**为什么用 `fetch` 而不是 `axios`？** Axios 默认把整个响应体读完才返回，不支持流式读取。Fetch API 的 `response.body` 是原生的 `ReadableStream`，可以边接收边处理。

**TextDecoder 的 `stream: true` 参数：** UTF-8 编码中一个字符可能由多个字节组成（如中文是 3 个字节）。如果网络传输恰好在一个多字节字符的中间截断了，`stream: true` 告诉 TextDecoder 保留不完整的字节到下一次 `decode` 调用中拼接，避免产生乱码。最后的 `decoder.decode()`（无参数）刷新残留缓冲区。

### 5.3 parseStreamSegments 算法

**背景：** AI 模型返回的流式内容不只是纯文本，还包含特殊标记段：
- `<<<THINK_START>>>...<<<THINK_END>>>`：模型的思考过程
- `<think>...</think>`：另一种思考过程标记
- `<<<SOURCES>>>...<<<SOURCES_END>>>`：引用的知识库来源

这些标记在流式传输过程中可能被截断（比如收到了 `<<<THINK_ST`，结束标记还没到），需要优雅处理。

```jsx
// parseStreamSegments.js
export function parseStreamSegments(rawContent = "") {
  // 1. 提取 <<<THINK_START>>>...<<<THINK_END>>> 中的思考内容
  const thinkMatches = Array.from(rawContent.matchAll(THINK_PATTERN))
  let think = thinkMatches.map((match) => match[1] ?? "").join("").trim()

  // 1b. 流式场景：如果开始标记已到达但结束标记还没到，提取部分思考内容
  if (!think) {
    const startIdx = rawContent.lastIndexOf(THINK_START)
    if (startIdx !== -1) {
      const afterStart = rawContent.slice(startIdx + THINK_START.length)
      if (!afterStart.includes(THINK_END)) {
        think = afterStart.trim()  // 不完整的 think 段也展示
      }
    }
  }

  // 2. 后备方案：提取 <think>...</think> XML 标签
  // ...

  // 3. 提取 sources JSON
  const sourcesMatch = contentAfterMarkers.match(SOURCES_PATTERN)
  const sources = parseSources(sourcesMatch?.[1])

  // 4. 清理显示内容：移除所有标记和不完整的标记残留
  const rawDisplayContent = stripTrailingPartialMarker(
    stripIncompleteBlock(
      stripIncompleteBlock(/* ... */),
      THINK_START, THINK_END,
    ),
  ).trim()

  return { content, sources, think }
}
```

**`stripTrailingPartialMarker` 的巧妙设计：**

```jsx
function stripTrailingPartialMarker(content) {
  let nextContent = content
  for (const marker of MARKERS) {
    for (let length = marker.length - 1; length > 0; length -= 1) {
      const partialMarker = marker.slice(0, length)
      if (nextContent.endsWith(partialMarker)) {
        nextContent = nextContent.slice(0, -length)
        break
      }
    }
  }
  return nextContent
}
```

这个函数解决一个关键的 UX 问题：当流式传输中途，内容末尾可能是 `<<<THINK_` 这样一个不完整的标记。如果直接显示给用户，用户会看到乱码。这个函数检查内容末尾是否以任何标记的前缀结束，如果是则截掉。

### 5.4 流式渲染的用户体验优化

**onChunk 回调驱动的实时更新：**

```jsx
// useChatSession.js
const rawResponse = await streamChat({
  images,
  onChunk: (chunk) => {
    rawAssistantRef.current += chunk          // 累积原始内容
    const parsed = parseStreamSegments(rawAssistantRef.current)  // 每次都重新解析
    setMessages((currentMessages) =>
      appendAssistantMessage(
        currentMessages,
        getDraftMessage(parsed.content, parsed, assistantCreatedAt, assistantDraftId),
        assistantDraftId,
      ),
    )
  },
  question,
  signal: controller.signal,
  taskId,
})
```

每收到一个 chunk（可能只有几个字符），就：
1. 累积到 `rawAssistantRef.current`
2. 重新解析完整的累积内容（提取 think/sources/content）
3. 更新消息列表中的"草稿"消息

**Draft 消息模式：**

```jsx
function getDraftMessage(content, parsed, createdAt, id) {
  return {
    content,
    created_at: createdAt,
    id,                              // 唯一的草稿 ID
    meta: { sources: parsed.sources, think: parsed.think },
    role: "assistant",
    status: "streaming",            // 标记为流式进行中
  }
}
```

消息列表中同时存在用户消息和一条状态为 `streaming` 的助手消息。流式结束后，状态更新为 `complete`。UI 可以根据 `status` 显示不同样式（如打字机光标效果）。

### 5.5 智能滚动（isNearBottomRef）

```jsx
// ChatMessageList.jsx
const containerRef = React.useRef(null)
const bottomRef = React.useRef(null)
const isNearBottomRef = React.useRef(true)

const handleScroll = React.useCallback(() => {
  const el = containerRef.current
  if (!el) return
  // scrollHeight - scrollTop - clientHeight = 距离底部的距离
  isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
}, [])

React.useEffect(() => {
  if (isNearBottomRef.current) {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }
}, [messages])
```

**行为描述：**
- 用户在底部（距离 < 100px）→ 新消息到来时自动滚到底部
- 用户滚动查看历史消息 → 新消息到来时不滚动，不打断用户阅读
- `scrollIntoView({ behavior: "smooth" })` 提供平滑的滚动动画

### 5.6 AbortController 终止流式请求

```jsx
// useChatSession.js
const abortControllerRef = useRef(null)

const sendMessage = useCallback(async ({ question, images }) => {
  const controller = new AbortController()
  abortControllerRef.current = controller

  try {
    await streamChat({
      signal: controller.signal,  // 传入 abort signal
      // ...
    })
  } catch (sendError) {
    if (sendError.name === "AbortError") {
      // 用户主动终止，保留已接收的内容
      const parsed = parseStreamSegments(rawAssistantRef.current)
      if (rawAssistantRef.current.trim()) {
        setMessages((currentMessages) =>
          appendAssistantMessage(currentMessages, getFinalAssistantMessage(...), assistantDraftId)
        )
      } else {
        // 还没收到任何内容，移除草稿消息
        setMessages((currentMessages) => removeAssistantDraft(currentMessages, assistantDraftId))
      }
    }
  }
}, [taskId])

const stopChat = useCallback(() => {
  abortControllerRef.current?.abort()
}, [])
```

**AbortController 工作流：**
1. 发送请求前创建 `new AbortController()`
2. 将 `controller.signal` 传给 `fetch()`
3. 用户点击"终止"按钮 → 调用 `controller.abort()`
4. `fetch` 抛出 `AbortError`
5. 捕获 `AbortError`，保留已收到的部分内容

---

## 六、轮询模式

### 6.1 为什么使用轮询而不是 WebSocket？

**轮询（Polling）** 是最简单的"实时"更新方案：定时向服务器发请求获取最新数据。

**本项目选择轮询的理由：**
1. 任务状态变更频率低（几秒到几分钟一次），不需要毫秒级的实时性
2. 轮询实现简单，不需要后端维护长连接
3. 对基础设施无额外要求（无需 WebSocket 代理配置）
4. 任务完成后自动停止轮询，不浪费资源

### 6.2 requestIdRef 防止竞态条件

这是轮询模式中最重要的健壮性保障：

```jsx
// useTaskList.js
const requestIdRef = React.useRef(0)

const loadTasks = React.useCallback(
  async (nextPage = page, nextPageSize = pageSize) => {
    const requestId = ++requestIdRef.current  // 原子递增

    clearPollingTimer()
    setLoading(true)
    setError(null)

    try {
      const response = await getTasks(nextPage, nextPageSize)

      // 守卫条件：如果已卸载或有更新的请求，丢弃本次结果
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return response
      }

      setTasks(nextTasks)
      setTotal(response?.total ?? 0)

      // 如果还有运行中的任务，继续轮询
      if (hasRunningTask(nextTasks)) {
        pollingTimerRef.current = setTimeout(() => {
          loadTasks(nextPage, nextPageSize)
        }, pollIntervalMs)
      }

      return response
    } catch (nextError) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(nextError)
      }
      return null
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  },
  [clearPollingTimer, page, pageSize, pollIntervalMs],
)
```

**竞态条件场景：**
1. 轮询请求 A 发出（requestId = 1）
2. 用户手动点击"刷新"，请求 B 发出（requestId = 2）
3. 请求 B 先返回（requestId 此时 = 2，匹配，正常更新 state）
4. 请求 A 后返回（requestId 此时 = 2，不匹配 1，丢弃）

如果没有这个守卫，请求 A 的旧数据会覆盖请求 B 的新数据。

### 6.3 轮询的启动和停止条件

```jsx
function hasRunningTask(tasks) {
  return tasks.some((task) => task?.status === "pending" || task?.status === "progressing")
}
```

**启动条件：** 任务列表中存在 `pending` 或 `progressing` 状态的任务。

**停止条件：**
1. 所有任务都已完成（`hasRunningTask` 返回 false）→ 不设置 setTimeout
2. 组件卸载 → `clearPollingTimer()` 清除定时器
3. 新的请求发出 → `clearPollingTimer()` 先清除旧定时器

**轮询间隔：** `DEFAULT_POLL_INTERVAL_MS = 5000`（5 秒）

### 6.4 mountedRef 防止内存泄漏

```jsx
const mountedRef = React.useRef(true)

React.useEffect(() => {
  mountedRef.current = true
  return () => {
    mountedRef.current = false
    clearPollingTimer()
  }
}, [clearPollingTimer])
```

组件卸载后异步请求可能还在进行中。`mountedRef.current = false` 确保卸载后不再调用 `setState`，避免 React "Can't perform a React state update on an unmounted component" 警告。

---

## 七、认证流程

### 7.1 完整认证流程图

```
应用启动
  │
  ├─ main.jsx → <StrictMode> → <AppProvider>
  │
  ├─ AppProvider.jsx
  │   ├─ <ConfigProvider> (Ant Design 主题)
  │   ├─ <AuthBootstrap>     ← 认证引导
  │   └─ <RouterProvider>     ← 路由
  │
  ├─ AuthBootstrap
  │   ├─ 从 Zustand(persist) 读取 localStorage 中的 token
  │   ├─ 如果没有 token → setHydrated(true) → 渲染子组件
  │   ├─ 如果有 token → 调 GET /users/me 验证 token 有效性
  │   │   ├─ 成功 → setUserInfo + setHydrated(true) → 渲染子组件
  │   │   └─ 失败 → clearAuth() → 渲染子组件（token 被清除）
  │   └─ hydrated 变为 true 后，ProtectedRoute 才开始判断
  │
  ├─ ProtectedRoute
  │   ├─ hydrated = false → 显示"正在验证登录状态..."
  │   ├─ hydrated = true, token = null → Navigate 到 /login
  │   └─ hydrated = true, token 存在 → <Outlet> 渲染子路由
  │
  └─ AdminRoute（嵌套在 ProtectedRoute 内）
      ├─ is_superuser = false → Navigate 到 /
      └─ is_superuser = true → <Outlet> 渲染管理路由
```

### 7.2 AuthBootstrap 组件的作用

```jsx
// AuthBootstrap.jsx
export function AuthBootstrap({ children }) {
  const token = useAuthStore((state) => state.token)
  const setHydrated = useAuthStore((state) => state.setHydrated)
  const setUserInfo = useAuthStore((state) => state.setUserInfo)
  const clearAuth = useAuthStore((state) => state.clearAuth)

  React.useEffect(() => {
    let active = true

    async function bootstrap() {
      if (!token) {
        if (active) setHydrated(true)
        return
      }

      try {
        const currentUser = await getCurrentUser()
        if (active) {
          setUserInfo(currentUser)
          setHydrated(true)
        }
      } catch {
        if (active) clearAuth()
      }
    }

    bootstrap()

    return () => { active = false }
  }, [clearAuth, setHydrated, setUserInfo, token])

  return children
}
```

**AuthBootstrap 解决了什么问题？**

用户刷新页面后，Zustand persist 会从 localStorage 恢复 token，但 **token 可能已经过期**。如果不验证就直接进入应用，用户可能看到一堆 401 错误。AuthBootstrap 在应用启动时立即验证 token，确保进入应用时 token 是有效的。

**为什么是一个组件而不是一个 Hook？**
因为它需要包裹 `<RouterProvider>`，在路由初始化之前就执行验证。如果用 Hook，验证逻辑会和某个具体页面组件耦合。

### 7.3 登录流程

```jsx
// LoginPage.jsx
async function handleFinish(values) {
  setSubmitting(true)
  setErrorMessage("")

  try {
    // 第一步：获取 access_token
    const tokenData = await login(values)
    setAuth({ token: tokenData.access_token, userInfo: null })

    // 第二步：用 token 获取用户信息
    const currentUser = await getCurrentUser()
    setAuth({ token: tokenData.access_token, userInfo: currentUser })

    // 第三步：重定向到用户原来想访问的页面
    navigate(location.state?.from?.pathname ?? "/", { replace: true })
  } catch (error) {
    clearAuth()
    setErrorMessage(error?.response?.data?.detail ?? "登录失败，请稍后重试")
  } finally {
    setSubmitting(false)
  }
}
```

**两步设置 auth 的原因：** 先设置 token 后设置 userInfo。因为 `getCurrentUser()` 需要 token 才能调用（通过 http 拦截器自动附加），所以必须先存 token。第二次 `setAuth` 同时设置 token 和 userInfo。

### 7.4 登出流程

```jsx
// AppShell.jsx
async function handleLogout() {
  try {
    await http.get("/auth/logout")  // 通知后端让 token 进入黑名单
  } catch {
    // 即使后端请求失败也继续登出
  }
  clearAuth()                       // 清除前端 token
  navigate("/login", { replace: true })
}
```

**双重保障：**
1. **后端黑名单：** 通知服务器将 JWT token 加入黑名单，即使 token 未过期也无法再使用
2. **前端清除：** 清空 Zustand store 和 localStorage 中的 token
3. **容错：** 即使后端请求失败（如网络断开），前端也执行登出，确保用户体验一致

### 7.5 已登录用户访问登录页的处理

```jsx
// LoginPage.jsx
export function LoginPage() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)

  // 如果已登录，直接跳转到首页，不显示登录表单
  if (hydrated && token) {
    return <Navigate replace to="/" />
  }

  // ...
}
```

---

## 八、性能优化

### 8.1 React.lazy 代码分割

**效果：** 每个页面生成独立的 JS chunk 文件。用户访问 `/login` 时只下载 LoginPage 的代码，不需要下载 TaskCenterPage、ChatPage 等无关代码。

**项目实现：**

```jsx
const LazyLoginPage = lazyPage(() => import("../pages/LoginPage.jsx"), "LoginPage")
const LazyTaskCenterPage = lazyPage(() => import("../pages/TaskCenterPage.jsx"), "TaskCenterPage")
// ... 所有页面都是懒加载
```

**构建产物对比：**
- 无代码分割：1 个大 JS 文件（可能 500KB+）
- 有代码分割：1 个主 bundle + N 个页面 chunk（每个 20-50KB）

### 8.2 useMemo 避免重复计算

**核心原则：** 只在计算真的"昂贵"时使用 useMemo。

项目中的典型用例——`defectStats` 计算：
- 需要遍历所有 tasks
- 每个 task 遍历其 detect_result.objects
- 还要做 map + sort
- `tasks` 不变时，这些计算不需要重做

**反面案例（不该用 useMemo 的情况）：**

```jsx
// 不需要 useMemo，计算足够简单
const keyword = filters.fileName.trim().toLowerCase()
const hasActiveFilters = keyword !== "" || status !== "all"
```

### 8.3 useCallback 避免不必要重渲染

项目中的 `useCallback` 使用模式：

1. **作为 prop 传递给子组件的函数**：`refresh`、`handleScroll`
2. **被其他 Hook 依赖的函数**：`clearPollingTimer` 被 `loadTasks` 依赖，`loadTasks` 被 `refresh` 依赖
3. **useEffect 的依赖**：`loadHistory` 被 `useEffect` 依赖

### 8.4 列表渲染优化

**key 的重要性（重复但必须强调）：**

```jsx
// 项目中所有列表都用唯一业务 ID 作为 key
{messages.map((message) => (
  <ChatMessageCard key={message.id} message={message} />
))}

{defectStats.ranked.map(({ cls }) => (
  <li key={cls}>...</li>
))}
```

**key 的选择原则：**
1. 必须在兄弟元素间唯一
2. 必须稳定（不随渲染变化）
3. 最好是业务 ID，不要用数组 index

### 8.5 AppProvider 中的 useMemo

```jsx
// AppProvider.jsx
export function AppProvider() {
  const router = React.useMemo(() => createAppRouter(), [])
  // ...
}
```

`createBrowserRouter()` 不应该在每次 AppProvider 渲染时都重新创建。`useMemo(... , [])` 确保 router 只创建一次。

### 8.6 Zustand 的选择性订阅

```jsx
// 只订阅 token，不订阅整个 store
const token = useAuthStore((state) => state.token)

// 而不是
const { token, userInfo, hydrated } = useAuthStore()
```

选择性订阅确保只有被选择的字段变化时，组件才重渲染。如果 `userInfo` 变了但 `token` 没变，使用第一种写法的组件不会重渲染。

---

## 九、项目架构

### 9.1 目录结构设计

```
src/
├── app/                          # 应用级配置
│   ├── AppProvider.jsx           # Provider 聚合（主题 + 认证 + 路由）
│   ├── router.jsx                # 路由定义
│   └── theme.js                  # Ant Design 主题配置
│
├── features/                     # 功能模块（按业务领域划分）
│   ├── auth/                     # 认证模块
│   │   ├── api/auth-api.js       # API 函数
│   │   ├── components/           # 专属组件（AuthBootstrap, ProtectedRoute, AdminRoute）
│   │   └── store/auth-store.js   # Zustand store
│   │
│   ├── chat/                     # 聊天模块
│   │   ├── api/chat-api.js
│   │   ├── components/           # ChatComposer, ChatMessageCard, ChatMessageList 等
│   │   ├── hooks/useChatSession.js
│   │   └── utils/                # parseStreamSegments, extractAssistantThink
│   │
│   ├── task-center/              # 任务中心模块
│   │   ├── api/task-api.js
│   │   ├── components/           # TaskTable, TaskUploadCard, TaskFilters 等
│   │   └── hooks/                # useTaskList, useTaskDetail
│   │
│   ├── knowledge-admin/          # 知识库管理模块
│   │   ├── api/
│   │   ├── components/
│   │   └── hooks/
│   │
│   ├── user-admin/               # 用户管理模块
│   │   ├── api/
│   │   ├── components/
│   │   └── hooks/
│   │
│   └── app-shell/                # 应用外壳模块
│       └── store/useShellStore.js
│
├── layouts/                      # 布局组件
│   └── AppShell.jsx              # 侧边栏 + 顶栏 + 内容区
│
├── pages/                        # 页面组件（薄层，组装 features）
│   ├── ChatPage.jsx
│   ├── TaskCenterPage.jsx
│   ├── TaskDetailPage.jsx
│   ├── LoginPage.jsx
│   └── ...
│
├── shared/                       # 跨功能共享
│   ├── api/http.js               # Axios 实例 + 拦截器
│   └── ui/                       # 通用 UI 组件（GlassPanel, MetricCard 等）
│
├── main.jsx                      # 入口文件
└── index.css                     # 全局样式
```

### 9.2 关注点分离原则

**feature 模块的内部分层：**

```
feature/
├── api/          数据获取层：纯函数，不涉及任何 React 概念
├── hooks/        业务逻辑层：封装状态 + 副作用 + API 调用
├── components/   展示层：UI 渲染 + 事件处理
├── store/        全局状态层：跨组件共享的状态
└── utils/        工具函数层：纯函数，无副作用
```

**每一层的职责边界：**

| 层 | 可以依赖 | 不可以依赖 | 输出 |
|----|----------|------------|------|
| api | http.js, store（读 token） | 组件, hooks | Promise |
| hooks | api, store | 组件 | { state, actions } |
| components | hooks, store, shared/ui | api（直接调用） | JSX |
| store | 无 | 任何 | { state, actions } |
| utils | 无 | 任何 React 概念 | 纯数据 |

**实际案例——ChatPage 的分层：**

```
用户点击"发送"
  → ChatComposer (component) 调用 onSend prop
  → ChatPage (page) 转发到 useChatSession.sendMessage
  → useChatSession (hook) 调用 streamChat
  → streamChat (api) 发起 fetch 请求
  → 收到 chunk → useChatSession 调用 parseStreamSegments
  → parseStreamSegments (utils) 解析内容
  → useChatSession 更新 messages state
  → ChatMessageList (component) 重渲染
```

### 9.3 API 层封装模式

**统一模式：**

```jsx
// 所有 API 函数都遵循相同模式
export async function getXxx(params) {
  const response = await http.get("/endpoint", { params })
  return response.data  // 直接返回 data，调用方不需要处理 response wrapper
}

export async function createXxx(payload) {
  const response = await http.post("/endpoint", payload)
  return response.data
}
```

**API 层的设计原则：**
1. 纯函数，不包含 React 状态逻辑
2. 返回 `response.data`（解包 Axios 的响应结构），调用方直接拿到业务数据
3. 不捕获错误（让调用方决定如何处理）
4. 参数和返回值贴近后端 API 的数据结构

---

## 十、面试高频问题

### 问题 1：什么是虚拟 DOM？为什么需要它？

**参考答案：**
虚拟 DOM 是 React 对真实 DOM 的 JavaScript 对象抽象。每次 render 时，React 在内存中构建新的虚拟 DOM 树，与旧树做 Diff，计算最小变更集合，然后批量更新到真实 DOM。

核心价值不是"虚拟 DOM 比真实 DOM 快"（直接操作 DOM 一定比间接操作快），而是它提供了一个声明式编程模型——开发者只需要描述"最终状态"，React 自动计算"最优变更路径"，避免了手动管理 DOM 更新时的遗漏和冲突。

---

### 问题 2：React 中 key 的作用是什么？为什么不建议用 index 作为 key？

**参考答案：**
key 帮助 React 的 Reconciliation 算法识别列表中哪些元素是新增的、哪些被删除了、哪些只是移动了位置。如果用 index 作为 key，在列表头部插入元素时，所有后续元素的 index 都会变化，React 会认为每个元素都需要更新。更严重的是，如果子组件有受控状态（如输入框内容），状态会错误地关联到错误的 DOM 元素。

项目中所有列表渲染都使用业务唯一 ID，例如 `ChatMessageList` 使用 `message.id`，`TaskCenterPage` 的缺陷列表使用 `cls`（缺陷类别名）。

---

### 问题 3：useEffect 的清理函数什么时候执行？

**参考答案：**
1. 依赖变化导致 effect 重新执行之前
2. 组件卸载时

项目中的实际例子：`useTaskList.js` 在卸载时清除轮询定时器（`clearPollingTimer()`），防止已卸载组件的定时器继续执行导致内存泄漏和 "setState on unmounted component" 错误。`AuthBootstrap.jsx` 在卸载时设置 `active = false`，阻止在已卸载组件上设置状态。

---

### 问题 4：useState 的函数式更新和直接传值有什么区别？什么场景必须用函数式更新？

**参考答案：**
- `setState(newValue)`：直接替换值
- `setState(prev => newValue)`：基于前一个状态计算新值

当多次 setState 调用之间存在依赖关系，或者在异步回调中读取 state 时，必须用函数式更新。因为 React 出于性能考虑会将多次 setState 批量处理（Batching），直接传值可能读到"过时"的 state。

项目中 `useChatSession.js` 的流式更新场景就是经典案例：`onChunk` 回调每秒可能触发几十次 `setMessages`，如果不用函数式更新，消息数据会丢失。

---

### 问题 5：useRef 和 useState 的区别？什么时候用 useRef？

**参考答案：**
核心区别：修改 `ref.current` 不会触发重渲染，修改 state 会触发重渲染。

使用 useRef 的场景：
1. **DOM 引用**：`containerRef` 获取滚动容器元素
2. **跨渲染周期的可变值**：`requestIdRef` 做竞态条件守卫、`pollingTimerRef` 存定时器 ID
3. **最新值的同步读取**：`sendingRef` 做防重入检查（state 更新是异步的，ref 是同步的）
4. **不需要触发渲染的状态**：`isNearBottomRef` 记录滚动位置、`rawAssistantRef` 累积原始流式内容

---

### 问题 6：解释一下你们项目中的竞态条件处理。

**参考答案：**
竞态条件（Race Condition）发生在多个异步操作并发执行，结果到达顺序不确定时。

项目中有两种竞态场景：
1. **用户快速切换任务**：切换时触发多次 `loadHistory`，先发出的请求可能后返回。解决方案是用 `loadRequestIdRef` 记录最新请求的 ID，旧请求返回时发现 ID 不匹配就丢弃结果。
2. **轮询和手动刷新并发**：轮询定时器触发请求，同时用户点击刷新。解决方案同上，`requestIdRef` 保证只有最新请求的结果生效。

具体实现：每次发起请求前 `requestId = ++requestIdRef.current`，请求返回后检查 `requestIdRef.current === requestId`，不等就丢弃。

---

### 问题 7：你们的路由守卫是怎么实现的？

**参考答案：**
我们实现了两级路由守卫，都是利用 React Router v7 的嵌套路由 + Layout Route 模式。

第一级 `ProtectedRoute`：检查 token 是否存在。没有 token 则 `<Navigate to="/login">`，同时通过 `state={{ from: location }}` 记住用户原来想去的页面，登录后跳回。

第二级 `AdminRoute`：检查 `userInfo.is_superuser`。非管理员重定向到首页。

关键是 `hydrated` 状态：在 `AuthBootstrap` 验证完 token 有效性之前，`hydrated` 为 false，`ProtectedRoute` 显示加载状态，而不是错误地重定向到登录页。

---

### 问题 8：为什么用 Zustand 而不是 Redux？

**参考答案：**
Zustand 的核心优势：
1. **极简 API**：没有 action type、reducer、dispatch、middleware 的概念，直接 `set()` 更新
2. **组件外可用**：`useAuthStore.getState()` 可以在 Axios 拦截器、API 函数等非 React 代码中使用
3. **体积小**：~1.5KB vs Redux 的 ~7KB
4. **选择性订阅**：`useAuthStore(state => state.token)` 天然支持精确订阅
5. **中间件生态**：persist 中间件一行配置实现 localStorage 持久化

---

### 问题 9：Zustand 的 persist 中间件是怎么工作的？partialize 有什么用？

**参考答案：**
`persist` 中间件在 `set()` 被调用时，将状态序列化后写入 localStorage。应用启动时从 localStorage 读取并恢复状态（Hydration）。

`partialize` 过滤掉不需要持久化的状态。我们的 `authStore` 中 `hydrated` 不持久化——它是运行时状态，表示 AuthBootstrap 是否完成了 token 验证。如果持久化了 `hydrated: true`，下次启动直接跳过验证，可能用过期 token 访问后端。

---

### 问题 10：项目中的流式通信是怎么实现的？为什么不用 EventSource？

**参考答案：**
使用 Fetch API + ReadableStream 手动实现。

不用 EventSource 的原因：
1. EventSource 只支持 GET 请求，我们需要 POST + FormData（包含图片）
2. EventSource 不支持自定义请求头（如 Authorization Bearer token）

实现步骤：
1. `fetch()` 发送 POST 请求
2. `response.body.getReader()` 获取流读取器
3. 循环调用 `reader.read()` 获取 `{ done, value }` 数据块
4. `TextDecoder.decode(value, { stream: true })` 解码为字符串
5. 通过 `onChunk` 回调将每个 chunk 传给 hook，hook 解析后更新 UI

---

### 问题 11：什么是 AbortController？项目中怎么用的？

**参考答案：**
`AbortController` 是浏览器原生 API，用于取消异步操作（如 fetch 请求）。

创建 `new AbortController()` 后，将 `controller.signal` 传给 `fetch()` 的 `signal` 参数。调用 `controller.abort()` 时，fetch 会抛出 `AbortError`。

项目中用于聊天的"终止生成"功能：用户点击"终止"按钮调用 `stopChat()`，底层调用 `abortControllerRef.current.abort()`。捕获到 `AbortError` 后，如果已有部分回答则保留，否则清除草稿消息。

---

### 问题 12：你们的 HTTP 拦截器做了什么？

**参考答案：**
请求拦截器：从 Zustand store 读取 token，自动添加 `Authorization: Bearer <token>` 请求头。这样每个 API 调用都不需要手动传 token。

响应拦截器：检查是否为 401 状态码。如果是，调用 `clearAuth()` 清除 token。因为 ProtectedRoute 监听了 token 变化，token 变 null 后自动跳转到登录页。整个链条是声明式的、自动化的。

---

### 问题 13：useMemo 和 useCallback 的区别？什么时候用？

**参考答案：**
`useMemo` 缓存计算结果，`useCallback` 缓存函数引用。本质上 `useCallback(fn, deps)` 等价于 `useMemo(() => fn, deps)`。

使用 `useMemo` 的场景：计算成本高且依赖不经常变化。如 `TaskCenterPage` 中遍历所有 tasks 统计缺陷数据。

使用 `useCallback` 的场景：函数作为 prop 传给子组件、或者作为 useEffect 的依赖。如 `useTaskList` 中的 `loadTasks`、`refresh`、`clearPollingTimer`。

不该用的场景：简单计算、依赖频繁变化（缓存反而增加开销）。

---

### 问题 14：什么是代码分割？React.lazy 怎么工作的？

**参考答案：**
代码分割把一个大的 JS bundle 拆成多个小文件，按需加载。React.lazy 配合 ES 动态 `import()` 实现组件级别的代码分割。

`React.lazy(() => import('./MyComponent'))` 返回一个懒加载组件。组件首次渲染时才执行 `import()`，触发网络请求下载对应的 JS chunk。加载期间展示 `<Suspense fallback>` 的内容。

项目中的特殊处理：`lazyPage` 函数把命名导出转为默认导出，因为 React.lazy 只支持默认导出。

---

### 问题 15：解释一下你们项目的认证流程，从打开浏览器到进入应用。

**参考答案：**
1. 浏览器打开 → 加载 `main.jsx` → 渲染 `AppProvider`
2. `AppProvider` 挂载 `AuthBootstrap`
3. `AuthBootstrap` 触发 useEffect：
   - Zustand persist 从 localStorage 恢复 token
   - 如果有 token，调 `GET /users/me` 验证有效性
   - 成功：设置 userInfo + hydrated=true
   - 失败：清除 token + hydrated=true
   - 无 token：直接 hydrated=true
4. `ProtectedRoute` 读到 hydrated=true：
   - 有 token → 渲染 AppShell → 渲染子路由
   - 无 token → Navigate 到 /login

---

### 问题 16：什么是闭包陷阱？useRef 怎么解决它？

**参考答案：**
闭包陷阱发生在 useEffect 或 useCallback 的回调中读取 state 时。由于闭包捕获的是创建时的变量值，如果 state 后来变了，回调中读到的仍然是旧值。

```jsx
// 闭包陷阱示例
const [count, setCount] = useState(0)
useEffect(() => {
  const timer = setInterval(() => {
    console.log(count)  // 永远是 0，因为闭包捕获了初始值
  }, 1000)
  return () => clearInterval(timer)
}, [])  // 空依赖，effect 只执行一次
```

解决方案 1：把 count 加到依赖数组（但会重建定时器）
解决方案 2：用 ref 存储最新值

```jsx
const countRef = useRef(count)
countRef.current = count  // 每次渲染都更新 ref

useEffect(() => {
  const timer = setInterval(() => {
    console.log(countRef.current)  // 始终读到最新值
  }, 1000)
  return () => clearInterval(timer)
}, [])
```

项目中 `sendingRef` 就是这个模式：`sending` state 的变化可能还没反映到 ref 中，但 `sendingRef.current` 的修改是同步的，能可靠地做防重入。

---

### 问题 17：React 的批量更新（Batching）是什么？React 18 有什么变化？

**参考答案：**
React 将多次 setState 合并为一次重渲染，这就是批量更新。React 17 只在事件处理函数中做 batching，setTimeout / Promise / 原生事件中不做。React 18 引入了 Automatic Batching，所有场景都自动批量更新。

项目中的影响：`useChatSession.js` 的 `sendMessage` 同时调用 `setSending(true)`、`setError(null)`、`setMessages(...)`，React 18 会将这些合并为一次重渲染，而不是三次。

---

### 问题 18：为什么项目中用 `useAuthStore(state => state.token)` 而不是 `useAuthStore()`？

**参考答案：**
这是 Zustand 的选择性订阅。`useAuthStore()` 订阅整个 store，任何字段变化都会触发组件重渲染。`useAuthStore(state => state.token)` 只订阅 `token` 字段，其他字段变化不会触发重渲染。

在 ProtectedRoute 中，如果用 `useAuthStore()`，每次 `userInfo` 变化（比如 AuthBootstrap 加载完用户信息）都会触发 ProtectedRoute 重渲染。而实际上 ProtectedRoute 只关心 `hydrated` 和 `token`。

---

### 问题 19：解释一下你们项目中的"智能滚动"机制。

**参考答案：**
在聊天界面中，新消息到来时是否自动滚到底部取决于用户当前的滚动位置：

1. 用 `isNearBottomRef` 记录用户是否在底部附近（距离 < 100px）
2. 每次 `onScroll` 事件更新这个 ref
3. 当 `messages` 变化时（useEffect 监听），如果 `isNearBottomRef.current` 为 true，调用 `scrollIntoView` 滚动到底部
4. 如果用户在上方浏览历史消息，`isNearBottomRef.current` 为 false，不滚动

用 useRef 而不是 useState，因为滚动位置的变化非常频繁（每帧都可能触发 scroll 事件），如果用 state 会导致大量不必要的重渲染。

---

### 问题 20：你们项目中的轮询什么时候会启动，什么时候会停止？如何避免内存泄漏？

**参考答案：**
**启动条件：** 任务列表中有状态为 `pending` 或 `progressing` 的任务。数据加载完成后调用 `hasRunningTask(nextTasks)` 判断。

**停止条件：**
1. 所有任务都已完成或失败 → 不设置新的 setTimeout
2. 新的请求发出 → 先 `clearPollingTimer()` 清除旧定时器再发请求
3. 组件卸载 → useEffect 的 cleanup 调用 `clearPollingTimer()`

**防止内存泄漏的三重保障：**
1. `mountedRef`：组件卸载后阻止 setState
2. `clearPollingTimer`：卸载时清除 setTimeout
3. `requestIdRef`：丢弃过期请求的结果

这三个 ref 形成一套完整的异步安全机制，确保异步操作在组件生命周期之外不会造成问题。
