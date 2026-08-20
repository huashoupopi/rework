import * as React from "react"
import { createBrowserRouter } from "react-router-dom"

import { AdminRoute } from "@/features/auth/components/AdminRoute"
import { ProtectedRoute } from "@/features/auth/components/ProtectedRoute"
import { AppShell } from "@/layouts/AppShell"

function lazyPage(loadPage, exportName) {
  return React.lazy(() =>
    loadPage().then((module) => ({
      default: module[exportName],
    })),
  )
}

function withPageFallback(element) {
  return <React.Suspense fallback={<div role="status">页面加载中...</div>}>{element}</React.Suspense>
}

const LazyLoginPage = lazyPage(() => import("../pages/LoginPage.jsx"), "LoginPage")
const LazyRegisterPage = lazyPage(() => import("../pages/RegisterPage.jsx"), "RegisterPage")
const LazyHomePage = lazyPage(() => import("../pages/HomePage.jsx"), "HomePage")
const LazyTaskCenterPage = lazyPage(() => import("../pages/TaskCenterPage.jsx"), "TaskCenterPage")
const LazyTaskDetailPage = lazyPage(() => import("../pages/TaskDetailPage.jsx"), "TaskDetailPage")
const LazyChatPage = lazyPage(() => import("../pages/ChatPage.jsx"), "ChatPage")
const LazyKnowledgeDocumentsPage = lazyPage(() => import("../pages/KnowledgeDocumentsPage.jsx"), "KnowledgeDocumentsPage")
const LazyKnowledgeRebuildPage = lazyPage(() => import("../pages/KnowledgeRebuildPage.jsx"), "KnowledgeRebuildPage")
const LazyKnowledgeChunkConfigsPage = lazyPage(
  () => import("../pages/KnowledgeChunkConfigsPage.jsx"),
  "KnowledgeChunkConfigsPage",
)
const LazyUsersPage = lazyPage(() => import("../pages/UsersPage.jsx"), "UsersPage")
const LazyEvalReportPage = lazyPage(() => import("../pages/EvalReportPage.jsx"), "EvalReportPage")
const LazyNotFoundPage = lazyPage(() => import("../pages/NotFoundPage.tsx"), "NotFoundPage")

export const routes = [
  {
    path: "/login",
    element: withPageFallback(<LazyLoginPage />),
  },
  {
    path: "/register",
    element: withPageFallback(<LazyRegisterPage />),
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            index: true,
            element: withPageFallback(<LazyHomePage />),
          },
          {
            path: "/tasks",
            element: withPageFallback(<LazyTaskCenterPage />),
          },
          {
            path: "/tasks/:taskId",
            element: withPageFallback(<LazyTaskDetailPage />),
          },
          {
            path: "/chat",
            element: withPageFallback(<LazyChatPage />),
          },
          {
            element: <AdminRoute />,
            children: [
              {
                path: "/knowledge/documents",
                element: withPageFallback(<LazyKnowledgeDocumentsPage />),
              },
              {
                path: "/knowledge/rebuild",
                element: withPageFallback(<LazyKnowledgeRebuildPage />),
              },
              {
                path: "/knowledge/chunk-configs",
                element: withPageFallback(<LazyKnowledgeChunkConfigsPage />),
              },
              {
                path: "/users",
                element: withPageFallback(<LazyUsersPage />),
              },
              {
                path: "/evals",
                element: withPageFallback(<LazyEvalReportPage />),
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: withPageFallback(<LazyNotFoundPage />),
  },
]

export function createAppRouter() {
  return createBrowserRouter(routes)
}
