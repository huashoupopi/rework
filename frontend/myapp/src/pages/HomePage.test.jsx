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

  expect(screen.getByText("工作台")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "从这里开始今天的检测工作" })).toBeInTheDocument()
  expect(screen.getByText("你好，demo")).toBeInTheDocument()
  expect(screen.getByText("上传叶片图片、查看缺陷分析结果，或在智能问答中继续深入。")).toBeInTheDocument()
  expect(screen.getByText("今天先完成上传、复核和追问。")).toBeInTheDocument()
  expect(screen.getByText("当前账号")).toBeInTheDocument()
  expect(screen.getByText("demo")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /上传检测任务/ })).toBeInTheDocument()
  expect(screen.getAllByRole("link", { name: /智能问答/ }).length).toBeGreaterThanOrEqual(1)
  expect(screen.queryByText("管理员功能")).not.toBeInTheDocument()
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

  expect(screen.getByText("管理员功能")).toBeInTheDocument()
  expect(screen.getByText("知识库管理")).toBeInTheDocument()
  expect(screen.getByText("知识库文档")).toBeInTheDocument()
  expect(screen.getByText("索引重建")).toBeInTheDocument()
  expect(screen.getByText("用户管理")).toBeInTheDocument()
})
