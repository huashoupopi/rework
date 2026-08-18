# Frontend Foundation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Vite-based frontend foundation for `frontend/myapp`, including app shell, route skeleton, auth boundary, shared HTTP client, lightweight global state, Tailwind v4 + Antd + shadcn/ui setup, and placeholder pages that match the approved spec.

**Architecture:** Keep the app as a single SPA with route-level pages and feature-level modules. Use `zustand` only for auth and app-shell state, route/search params for page context, `axios` for standard API calls, and `fetch` reserved for future chat streaming. Use `shadcn/ui + Tailwind v4` for shell and product-feeling surfaces, and `Antd` for dense business controls.

**Tech Stack:** Vite, React 19, JavaScript, pnpm, react-router-dom, axios, zustand, Tailwind CSS v4, shadcn/ui primitives, Antd, Vitest, Testing Library

---

## Scope Guard

This plan implements only the frontend foundation approved in the spec:

- app structure
- route map
- layout shell
- auth boundary
- shared request layer
- lightweight global state
- visual tokens and theme wiring
- placeholder pages

This plan does **not** implement:

- task upload logic
- task polling
- chat streaming
- knowledge management behaviors
- user management behaviors

Those belong to later plans.

## File Map

### Existing files to modify

- Modify: `frontend/myapp/package.json`
  - Add runtime dependencies, test dependencies, and scripts
- Modify: `frontend/myapp/vite.config.js`
  - Add stable alias and dev proxy
- Modify: `frontend/myapp/jsconfig.json`
  - Keep alias config aligned with final structure
- Modify: `frontend/myapp/src/main.jsx`
  - Mount providers and router instead of the current placeholder app
- Modify: `frontend/myapp/src/index.css`
  - Define Tailwind v4 imports, app tokens, liquid-glass inspired shell tokens, Antd compatibility overrides
- Delete or stop using: `frontend/myapp/src/App.jsx`
  - Replace root entry with route-driven app assembly

### New foundation files to create

- Create: `frontend/myapp/src/app/AppProvider.jsx`
  - Compose router, Antd provider, and future global providers
- Create: `frontend/myapp/src/app/router.jsx`
  - Define route tree
- Create: `frontend/myapp/src/app/routes/ProtectedRoute.jsx`
  - Enforce login boundary
- Create: `frontend/myapp/src/app/routes/AdminRoute.jsx`
  - Enforce `is_superuser`
- Create: `frontend/myapp/src/layouts/AppShell.jsx`
  - Main shell layout with nav, sidebar, outlet area
- Create: `frontend/myapp/src/features/auth/store/useAuthStore.js`
  - Persist token and user info only
- Create: `frontend/myapp/src/features/app-shell/store/useShellStore.js`
  - Sidebar collapse and minimal shell state
- Create: `frontend/myapp/src/shared/api/http.js`
  - Shared axios instance with auth injection and 401 handling
- Create: `frontend/myapp/src/shared/api/download.js`
  - Blob download helper
- Create: `frontend/myapp/src/shared/config/env.js`
  - Read frontend env and expose API base assumptions
- Create: `frontend/myapp/src/shared/lib/cn.js`
  - `clsx + tailwind-merge`
- Create: `frontend/myapp/src/shared/ui/PagePlaceholder.jsx`
  - Reusable placeholder page surface
- Create: `frontend/myapp/src/shared/ui/GlassPanel.jsx`
  - Reusable restrained “liquid glass” wrapper for shell/login/home
- Create: `frontend/myapp/src/pages/LoginPage.jsx`
- Create: `frontend/myapp/src/pages/RegisterPage.jsx`
- Create: `frontend/myapp/src/pages/HomePage.jsx`
- Create: `frontend/myapp/src/pages/TasksPage.jsx`
- Create: `frontend/myapp/src/pages/TaskDetailPage.jsx`
- Create: `frontend/myapp/src/pages/ChatPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeDocumentsPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeRebuildPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeChunkConfigsPage.jsx`
- Create: `frontend/myapp/src/pages/admin/UsersPage.jsx`

### New test files to create

- Create: `frontend/myapp/src/app/router.test.jsx`
  - Verify public/protected/admin route behavior
- Create: `frontend/myapp/src/features/auth/store/useAuthStore.test.js`
  - Verify persisted auth shape stays minimal
- Create: `frontend/myapp/src/shared/api/http.test.js`
  - Verify token injection and 401 handling contract
- Create: `frontend/myapp/src/layouts/AppShell.test.jsx`
  - Verify shell renders role-aware navigation
- Create: `frontend/myapp/src/test/setup.js`
  - Testing Library and matchers setup

## Implementation Notes

- Use the `rework` backend as the only API truth source.
- Do not copy `bs` request paths blindly.
- Keep dense pages readable; liquid-glass styling is for shell surfaces, not table bodies.
- Prefer feature-local files over top-level `apis/`, `store/`, or giant shared folders.
- If a route needs future data but not behavior yet, render a clear placeholder instead of inventing fake business logic.

## Chunk 1: Tooling And App Skeleton

### Task 1: Add frontend dependencies and test harness

**Files:**
- Modify: `frontend/myapp/package.json`
- Modify: `frontend/myapp/vite.config.js`
- Modify: `frontend/myapp/jsconfig.json`
- Create: `frontend/myapp/src/test/setup.js`

- [ ] **Step 1: Write the failing smoke test for the router mount**

```jsx
import { render, screen } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"

import { routes } from "@/app/router"

test("renders login route shell for public entry", () => {
  const router = createMemoryRouter(routes, { initialEntries: ["/login"] })
  render(<RouterProvider router={router} />)

  expect(screen.getByRole("heading", { name: /登录/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/myapp && pnpm test:run src/app/router.test.jsx`

Expected: FAIL because Vitest, test setup, and `routes` do not exist yet.

- [ ] **Step 3: Add minimal tooling and config**

Update `package.json` to add:

- Runtime:
  - `react-router-dom`
  - `axios`
  - `zustand`
  - `antd`
  - `@ant-design/icons`
  - `@tailwindcss/vite`
  - `clsx`
  - `tailwind-merge`
  - `class-variance-authority`
  - `lucide-react`
  - minimal Radix packages needed for initial shell components
  - `dayjs`
- Dev:
  - `tailwindcss`
  - `vitest`
  - `jsdom`
  - `@testing-library/react`
  - `@testing-library/jest-dom`
  - `@testing-library/user-event`

Add scripts:

```json
{
  "test": "vitest",
  "test:run": "vitest run"
}
```

Update `vite.config.js` to include:

- existing `@` alias
- `/api` proxy pointing to backend dev server
- `test` config block using `jsdom` and `src/test/setup.js`

Keep `jsconfig.json` aligned with `@/* -> src/*`.

- [ ] **Step 4: Run tests and lint to verify the harness is alive**

Run:

```bash
cd frontend/myapp
pnpm lint
pnpm test:run
```

Expected:

- `lint` runs without config errors
- `test:run` executes and still fails only on missing app files, not on tooling

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/package.json frontend/myapp/vite.config.js frontend/myapp/jsconfig.json frontend/myapp/src/test/setup.js
git commit -m "chore: add frontend foundation tooling"
```

### Task 2: Replace placeholder app entry with route-based assembly

**Files:**
- Modify: `frontend/myapp/src/main.jsx`
- Delete or stop importing: `frontend/myapp/src/App.jsx`
- Create: `frontend/myapp/src/app/AppProvider.jsx`
- Create: `frontend/myapp/src/app/router.jsx`

- [ ] **Step 1: Write the failing route smoke test**

```jsx
import { render, screen } from "@testing-library/react"
import { createMemoryRouter, RouterProvider } from "react-router-dom"

import { routes } from "@/app/router"

test("public login route renders without the app shell", () => {
  const router = createMemoryRouter(routes, { initialEntries: ["/login"] })
  render(<RouterProvider router={router} />)

  expect(screen.getByRole("heading", { name: /登录/i })).toBeInTheDocument()
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/myapp && pnpm test:run src/app/router.test.jsx`

Expected: FAIL because `routes` and page components do not exist.

- [ ] **Step 3: Write the minimal app assembly**

Create:

- `AppProvider.jsx` that returns the router provider
- `router.jsx` exporting `routes`

Update `main.jsx` to render the new provider and remove the placeholder `App.jsx` path from the runtime.

Use minimal placeholder route elements for now; real page placeholders will land in later tasks.

- [ ] **Step 4: Run the test to verify mount flow works**

Run: `cd frontend/myapp && pnpm test:run src/app/router.test.jsx`

Expected: route test still fails only on missing page behavior, not on provider wiring.

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/main.jsx frontend/myapp/src/app/AppProvider.jsx frontend/myapp/src/app/router.jsx
git commit -m "refactor: switch frontend entry to route-driven app"
```

## Chunk 2: Auth Boundary, Shell, And Route Map

### Task 3: Implement lightweight auth store and guarded routes

**Files:**
- Create: `frontend/myapp/src/features/auth/store/useAuthStore.js`
- Create: `frontend/myapp/src/app/routes/ProtectedRoute.jsx`
- Create: `frontend/myapp/src/app/routes/AdminRoute.jsx`
- Test: `frontend/myapp/src/features/auth/store/useAuthStore.test.js`
- Test: `frontend/myapp/src/app/router.test.jsx`

- [ ] **Step 1: Write the failing auth store and guard tests**

```js
import { useAuthStore } from "@/features/auth/store/useAuthStore"

test("auth store persists token only with user info", () => {
  useAuthStore.getState().setSession({
    token: "token-1",
    userInfo: { id: 1, username: "admin", is_superuser: true },
  })

  const state = useAuthStore.getState()
  expect(state.token).toBe("token-1")
  expect(state.userInfo.is_superuser).toBe(true)
})
```

```jsx
test("admin route redirects non-admin users away", () => {
  // seed store with non-admin user
  // visit /users
  // expect redirect target content
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd frontend/myapp
pnpm test:run src/features/auth/store/useAuthStore.test.js src/app/router.test.jsx
```

Expected: FAIL because store and route guards do not exist.

- [ ] **Step 3: Implement minimal auth state and guard components**

Implement store shape:

```js
{
  token: "",
  userInfo: null,
  hydrated: false,
  setSession: ({ token, userInfo }) => {},
  clearSession: () => {},
  markHydrated: () => {},
}
```

Persistence rule:

- persist only `token`
- do not persist task/chat/knowledge business state

Implement:

- `ProtectedRoute` redirects anonymous users to `/login`
- `AdminRoute` redirects logged-in non-admin users to `/`

- [ ] **Step 4: Run tests to verify the boundary works**

Run:

```bash
cd frontend/myapp
pnpm test:run src/features/auth/store/useAuthStore.test.js src/app/router.test.jsx
```

Expected: PASS for auth store persistence shape and route boundary behavior.

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/features/auth/store/useAuthStore.js frontend/myapp/src/app/routes/ProtectedRoute.jsx frontend/myapp/src/app/routes/AdminRoute.jsx frontend/myapp/src/features/auth/store/useAuthStore.test.js frontend/myapp/src/app/router.test.jsx
git commit -m "feat: add auth store and route guards"
```

### Task 4: Build the main app shell and role-aware navigation skeleton

**Files:**
- Create: `frontend/myapp/src/layouts/AppShell.jsx`
- Create: `frontend/myapp/src/shared/ui/PagePlaceholder.jsx`
- Create: `frontend/myapp/src/shared/ui/GlassPanel.jsx`
- Create: `frontend/myapp/src/features/app-shell/store/useShellStore.js`
- Create: `frontend/myapp/src/pages/LoginPage.jsx`
- Create: `frontend/myapp/src/pages/RegisterPage.jsx`
- Create: `frontend/myapp/src/pages/HomePage.jsx`
- Create: `frontend/myapp/src/pages/TasksPage.jsx`
- Create: `frontend/myapp/src/pages/TaskDetailPage.jsx`
- Create: `frontend/myapp/src/pages/ChatPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeDocumentsPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeRebuildPage.jsx`
- Create: `frontend/myapp/src/pages/knowledge/KnowledgeChunkConfigsPage.jsx`
- Create: `frontend/myapp/src/pages/admin/UsersPage.jsx`
- Modify: `frontend/myapp/src/app/router.jsx`
- Test: `frontend/myapp/src/layouts/AppShell.test.jsx`
- Test: `frontend/myapp/src/app/router.test.jsx`

- [ ] **Step 1: Write failing shell and route-map tests**

```jsx
test("shell shows task and chat entries for authenticated users", () => {
  // seed authenticated non-admin user
  // render shell route
  // expect Tasks and Chat entries
  // expect Knowledge and Users absent
})

test("shell shows admin entries for superuser", () => {
  // seed admin user
  // expect Knowledge and Users entries visible
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd frontend/myapp
pnpm test:run src/layouts/AppShell.test.jsx src/app/router.test.jsx
```

Expected: FAIL because shell, placeholders, and route map are incomplete.

- [ ] **Step 3: Implement the shell and placeholder pages**

Implement:

- `AppShell` with:
  - header
  - sidebar/nav
  - outlet container
  - restrained glass surfaces for shell chrome only
- `useShellStore` with minimal UI state:
  - `sidebarCollapsed`
  - `setSidebarCollapsed`
- Placeholder pages with stable headings matching the spec:
  - 登录
  - 注册
  - 工作台
  - 任务中心
  - 任务详情
  - 智能问答
  - 知识库文档
  - 索引重建
  - 分块配置
  - 用户管理

Update router map to match the approved spec exactly.

- [ ] **Step 4: Run tests and manual smoke checks**

Run:

```bash
cd frontend/myapp
pnpm test:run src/layouts/AppShell.test.jsx src/app/router.test.jsx
pnpm lint
pnpm dev
```

Manual expectations:

- `/login` and `/register` render outside the shell
- authenticated user can reach `/`, `/tasks`, `/tasks/:taskId`, `/chat`
- non-admin user is blocked from `/knowledge/*` and `/users`
- admin user sees those entries in shell navigation

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/layouts/AppShell.jsx frontend/myapp/src/shared/ui/PagePlaceholder.jsx frontend/myapp/src/shared/ui/GlassPanel.jsx frontend/myapp/src/features/app-shell/store/useShellStore.js frontend/myapp/src/pages frontend/myapp/src/app/router.jsx frontend/myapp/src/layouts/AppShell.test.jsx frontend/myapp/src/app/router.test.jsx
git commit -m "feat: add app shell and route skeleton"
```

## Chunk 3: Request Layer, Theme Tokens, And Foundation Hardening

### Task 5: Implement the shared HTTP client and auth failure contract

**Files:**
- Create: `frontend/myapp/src/shared/api/http.js`
- Create: `frontend/myapp/src/shared/api/download.js`
- Create: `frontend/myapp/src/shared/config/env.js`
- Test: `frontend/myapp/src/shared/api/http.test.js`

- [ ] **Step 1: Write the failing HTTP client tests**

```js
test("injects bearer token when auth store has one", async () => {
  // mock axios adapter
  // seed auth store with token
  // expect Authorization header to equal Bearer token
})

test("clears session on 401 for non-login requests", async () => {
  // mock 401 response
  // expect clearSession called
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/myapp && pnpm test:run src/shared/api/http.test.js`

Expected: FAIL because shared HTTP layer does not exist.

- [ ] **Step 3: Implement the minimal request layer**

Implement:

- `env.js` exposing `apiBasePath` defaulting to `/api`
- `http.js`:
  - axios instance
  - request interceptor injecting `Authorization`
  - response interceptor clearing session on 401
  - preserve future compatibility for login/register/public endpoints
- `download.js`:
  - safe blob download helper

Do **not** implement business APIs in this task.

- [ ] **Step 4: Run tests and verify HTTP contract**

Run:

```bash
cd frontend/myapp
pnpm test:run src/shared/api/http.test.js
pnpm lint
```

Expected: PASS for auth header injection and 401 session clearing contract.

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/shared/api/http.js frontend/myapp/src/shared/api/download.js frontend/myapp/src/shared/config/env.js frontend/myapp/src/shared/api/http.test.js
git commit -m "feat: add shared http foundation"
```

### Task 6: Add Tailwind v4 theme tokens and restrained liquid-glass styling

**Files:**
- Modify: `frontend/myapp/src/index.css`
- Optionally create: `frontend/myapp/src/shared/ui/glass.css` only if `index.css` becomes unwieldy
- Test: `frontend/myapp/src/layouts/AppShell.test.jsx`

- [ ] **Step 1: Write a failing visual-structure test**

```jsx
test("shell root exposes navigation landmark and branded surface classes", () => {
  // render authenticated shell
  // assert navigation landmark exists
  // assert shell uses agreed class hooks, e.g. app-shell or glass-panel
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/myapp && pnpm test:run src/layouts/AppShell.test.jsx`

Expected: FAIL because agreed shell classes/tokens are not wired yet.

- [ ] **Step 3: Implement theme tokens and restrained styling**

In `index.css`:

- import Tailwind v4
- define semantic tokens for:
  - background
  - foreground
  - card
  - border
  - ring
  - brand accent
  - glass surface
  - glass border
  - shell shadow
- add base utility classes for:
  - `app-shell`
  - `glass-panel`
  - `page-container`

Style constraints:

- glass styling only on shell chrome and product-feeling surfaces
- table or dense content regions must keep solid, readable backgrounds
- do not introduce dark mode or theme switching

- [ ] **Step 4: Run tests and visual smoke checks**

Run:

```bash
cd frontend/myapp
pnpm test:run src/layouts/AppShell.test.jsx
pnpm dev
```

Manual expectations:

- login and home pages feel lighter and more polished
- shell chrome uses restrained glass effect
- content area remains readable
- no dense page region uses low-contrast translucent surfaces by default

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/index.css frontend/myapp/src/layouts/AppShell.test.jsx
git commit -m "style: add frontend foundation theme tokens"
```

### Task 7: Harden the route placeholders as a clean handoff for later feature plans

**Files:**
- Modify: `frontend/myapp/src/pages/*.jsx`
- Modify: `frontend/myapp/src/pages/knowledge/*.jsx`
- Modify: `frontend/myapp/src/pages/admin/*.jsx`
- Modify: `frontend/myapp/src/shared/ui/PagePlaceholder.jsx`
- Modify: `frontend/myapp/src/app/router.jsx`

- [ ] **Step 1: Write the failing route-content test**

```jsx
test("every planned route exposes exactly one stable page heading", () => {
  // iterate route entries
  // assert each page renders a stable heading used by later feature tests
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/myapp && pnpm test:run src/app/router.test.jsx`

Expected: FAIL because placeholder content is incomplete or inconsistent.

- [ ] **Step 3: Normalize placeholder pages for later replacement**

Each placeholder page should include:

- stable page title
- one-line scope statement
- one lightweight “next implementation” hint

Examples:

- 任务中心：`上传、筛选、列表、批量操作将在后续计划中实现`
- 智能问答：`流式输出、消息历史、taskId 上下文将在后续计划中实现`

Do not add fake data tables or fake network calls.

- [ ] **Step 4: Run the full foundation verification**

Run:

```bash
cd frontend/myapp
pnpm lint
pnpm test:run
pnpm build
```

Expected:

- lint passes
- tests pass
- production build succeeds

- [ ] **Step 5: Commit**

```bash
git add frontend/myapp/src/pages frontend/myapp/src/shared/ui/PagePlaceholder.jsx frontend/myapp/src/app/router.jsx
git commit -m "chore: finalize frontend foundation placeholders"
```

## Final Verification Checklist

- [ ] `frontend/myapp` installs successfully with `pnpm install`
- [ ] `pnpm lint` passes
- [ ] `pnpm test:run` passes
- [ ] `pnpm build` passes
- [ ] Public routes render outside the shell
- [ ] Protected routes render inside the shell
- [ ] Admin routes are hidden from non-admin nav and blocked by direct access
- [ ] Global store contains auth and shell state only
- [ ] Shared HTTP client exists and is isolated from business API modules
- [ ] Liquid-glass styling is restrained to shell/product surfaces

## Handoff Notes For The Next Plan

Once this plan is complete, the next implementation plan should target `B. 用户工作台规范` and assume the following foundation exists:

- app shell
- auth guard
- route map
- shared axios client
- shell/theme tokens
- placeholder pages ready for replacement

Plan complete and saved to `docs/superpowers/plans/2026-03-21-frontend-foundation-implementation-plan.md`. Ready to execute?
