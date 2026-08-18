import * as React from "react"
import { afterEach, expect, test, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"

import { RegisterPage } from "./RegisterPage"

const registerMock = vi.fn()

vi.mock("@/features/auth/api/auth-api", () => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  register: (...args) => registerMock(...args),
}))

afterEach(() => {
  registerMock.mockReset()
})

function renderRegisterPage() {
  render(
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route element={<RegisterPage />} path="/register" />
        <Route element={<h1>登录</h1>} path="/login" />
      </Routes>
    </MemoryRouter>,
  )
}

test("registers successfully and returns to the login page", async () => {
  const user = userEvent.setup()

  registerMock.mockResolvedValue({
    id: 1,
    username: "demo",
  })

  renderRegisterPage()

  expect(screen.getByRole("heading", { name: "创建你的账号" })).toBeInTheDocument()
  expect(screen.getByText("加入智能检测平台，开始使用 AI 驱动的工作流。")).toBeInTheDocument()
  expect(screen.getByText("REWORK")).toBeInTheDocument()

  await user.type(screen.getByPlaceholderText("请输入用户名"), "demo")
  await user.type(screen.getByPlaceholderText("请输入姓名（选填）"), "Demo User")
  await user.type(screen.getByPlaceholderText("请输入密码"), "secret")
  await user.click(screen.getByRole("button", { name: /注\s*册/i }))

  expect(await screen.findByRole("heading", { name: "登录" })).toBeInTheDocument()
})

test("shows the backend error message when register fails", async () => {
  const user = userEvent.setup()

  registerMock.mockRejectedValue({
    response: {
      data: {
        detail: "用户名已存在",
      },
    },
  })

  renderRegisterPage()

  await user.type(screen.getByPlaceholderText("请输入用户名"), "demo")
  await user.type(screen.getByPlaceholderText("请输入姓名（选填）"), "Demo User")
  await user.type(screen.getByPlaceholderText("请输入密码"), "secret")
  await user.click(screen.getByRole("button", { name: /注\s*册/i }))

  expect(await screen.findByText("用户名已存在")).toBeInTheDocument()
})
