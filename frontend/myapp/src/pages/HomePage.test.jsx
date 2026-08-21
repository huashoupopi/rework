import * as React from "react"
import { act, render, screen } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { MemoryRouter } from "react-router-dom"

import { useAuthStore } from "@/features/auth/store/auth-store"

const { HomePage } = await import("./HomePage")

afterEach(() => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: null,
      userInfo: null,
    })
  })
})

function renderHomePage() {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  )
}

test("renders welcome hero and quick actions for normal users", () => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: {
        id: 3,
        is_superuser: false,
        username: "demo",
      },
    })
  })

  renderHomePage()

  // 2026-08-21 工作台由 marketing hero 改为 utility dashboard：
  // 标语式大标题（「从这里开始今天的检测工作」）、「当前账号」侧卡、
  // 写死的「今日节奏 3 步」全部移除，改为先给状态、再给动作、最后给入口。
  expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument()
  expect(screen.getByText("demo · 成员")).toBeInTheDocument()
  expect(screen.getByText("概览")).toBeInTheDocument()
  expect(screen.getByText("总任务")).toBeInTheDocument()
  expect(screen.getByText("主要操作")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /上传检测任务/ })).toBeInTheDocument()
  expect(screen.getAllByRole("link", { name: /智能问答/ }).length).toBeGreaterThanOrEqual(1)
  expect(screen.queryByText("管理")).not.toBeInTheDocument()
})

test("renders admin grid for superusers", () => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: {
        id: 1,
        is_superuser: true,
        username: "admin",
      },
    })
  })

  renderHomePage()

  // 「管理员功能」这个分组标题收敛成「管理」；原本重复出现的
  // 「知识库管理」快捷卡与「知识库文档」入口合并为后者一处。
  expect(screen.getByText("管理")).toBeInTheDocument()
  expect(screen.getByText("知识库文档")).toBeInTheDocument()
  expect(screen.getByText("索引重建")).toBeInTheDocument()
  expect(screen.getByText("用户管理")).toBeInTheDocument()
  expect(screen.getByText("评测报告")).toBeInTheDocument()
})
