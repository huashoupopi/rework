import * as React from "react"
import { afterEach, expect, test, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"

import { useAuthStore } from "@/features/auth/store/auth-store"

import { LoginPage } from "./LoginPage"

const getCurrentUserMock = vi.fn()
const loginMock = vi.fn()

vi.mock("@/features/auth/api/auth-api", () => ({
  getCurrentUser: (...args) => getCurrentUserMock(...args),
  login: (...args) => loginMock(...args),
  register: vi.fn(),
}))

afterEach(() => {
  getCurrentUserMock.mockReset()
  loginMock.mockReset()
  useAuthStore.setState({
    hydrated: true,
    token: null,
    userInfo: null,
  })
})

function renderLoginPage(initialEntry = "/login") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        <Route element={<h1>任务中心</h1>} path="/tasks" />
        <Route element={<h1>工作台</h1>} path="/" />
      </Routes>
    </MemoryRouter>,
  )
}

test("logs in, loads the current user, and redirects to the app home", async () => {
  const user = userEvent.setup()

  loginMock.mockResolvedValue({
    access_token: "token-123",
    token_type: "bearer",
  })
  getCurrentUserMock.mockImplementation(async () => {
    if (useAuthStore.getState().token !== "token-123") {
      return Promise.reject({
        response: {
          data: {
            detail: "无法验证凭据",
          },
          status: 401,
        },
      })
    }

    return {
      id: 1,
      username: "demo",
      full_name: "Demo",
      is_superuser: false,
      created_at: "2026-03-21T00:00:00Z",
    }
  })

  renderLoginPage()

  expect(screen.getByRole("heading", { name: "风机叶片智能检测" })).toBeInTheDocument()
  expect(screen.getByText("基于深度学习的缺陷检测、知识管理与智能问答平台。")).toBeInTheDocument()
  expect(screen.getByText("REWORK")).toBeInTheDocument()

  await user.type(screen.getByPlaceholderText("请输入用户名"), "demo")
  await user.type(screen.getByPlaceholderText("请输入密码"), "secret")
  await user.click(screen.getByRole("button", { name: /登\s*录/i }))

  expect(await screen.findByRole("heading", { name: "工作台" })).toBeInTheDocument()

  await waitFor(() => {
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      token: "token-123",
      userInfo: {
        username: "demo",
      },
    })
  })
})

test("shows a register entry on the login page", () => {
  renderLoginPage()

  expect(screen.getByRole("link", { name: "没有账号？立即注册" })).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "欢迎回来" })).toBeInTheDocument()
})

test("shows the backend error message when login fails", async () => {
  const user = userEvent.setup()

  loginMock.mockRejectedValue({
    response: {
      data: {
        detail: "用户名或密码错误",
      },
    },
  })

  renderLoginPage()

  await user.type(screen.getByPlaceholderText("请输入用户名"), "demo")
  await user.type(screen.getByPlaceholderText("请输入密码"), "wrong")
  await user.click(screen.getByRole("button", { name: /登\s*录/i }))

  expect(await screen.findByText("用户名或密码错误")).toBeInTheDocument()
})
