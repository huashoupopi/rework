import * as React from "react"
import { act, render, screen } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import userEvent from "@testing-library/user-event"

import { useAuthStore } from "@/features/auth/store/auth-store"
import { useShellStore } from "@/features/app-shell/store/useShellStore"

import { AppShell } from "./AppShell"

afterEach(() => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: null,
      userInfo: null,
    })
    useShellStore.setState({
      sidebarCollapsed: false,
    })
  })
})

function renderAppShell() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route element={<AppShell />} path="/">
          <Route element={<h2>工作台内容</h2>} index />
        </Route>
        <Route element={<h1>登录</h1>} path="/login" />
      </Routes>
    </MemoryRouter>,
  )
}

test("hides admin navigation for normal users", async () => {
  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: false, username: "demo" },
    })

    renderAppShell()
  })

  expect(screen.getByText("REWORK")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument()
  expect(screen.getByRole("navigation", { name: "主导航" })).toBeInTheDocument()
  expect(screen.getByText("工作台", { selector: ".app-sidebar__group-label" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "工作台" })).toBeInTheDocument()
  expect(screen.queryByRole("link", { name: "知识库文档" })).not.toBeInTheDocument()
  expect(screen.queryByRole("link", { name: "用户管理" })).not.toBeInTheDocument()
})

test("shows admin navigation for superusers", async () => {
  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: true, username: "admin" },
    })

    renderAppShell()
  })

  expect(screen.getByRole("link", { name: "知识库文档" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "索引重建" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "分块配置" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "用户管理" })).toBeInTheDocument()
  expect(screen.getByText("管理", { selector: ".app-sidebar__group-label" })).toBeInTheDocument()
  expect(screen.getByText("admin")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "工作台" })).toBeInTheDocument()
})

test("toggles the navigation collapse state from the header control", async () => {
  const user = userEvent.setup()

  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: false, username: "demo" },
    })

    renderAppShell()
  })

  const toggleButton = screen.getByRole("button", { name: "收起" })

  expect(toggleButton).toHaveAttribute("aria-pressed", "false")
  expect(useShellStore.getState().sidebarCollapsed).toBe(false)

  await user.click(toggleButton)

  expect(toggleButton).toHaveAttribute("aria-pressed", "true")
  expect(useShellStore.getState().sidebarCollapsed).toBe(true)
  expect(document.querySelector(".app-shell")).toHaveAttribute("data-sidebar-collapsed", "true")
  expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true")
})

test("logs out and returns to the login page", async () => {
  const user = userEvent.setup()

  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: false, username: "demo" },
    })

    renderAppShell()
  })

  await user.click(screen.getByRole("button", { name: "退出登录" }))

  expect(await screen.findByRole("heading", { name: "登录" })).toBeInTheDocument()
  expect(useAuthStore.getState()).toMatchObject({
    hydrated: true,
    token: null,
    userInfo: null,
  })
})

test("spins the logo after five clicks without changing auth state", async () => {
  const user = userEvent.setup()

  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: false, username: "demo" },
    })

    renderAppShell()
  })

  const logo = screen.getByRole("button", { name: "REWORK 标志" })
  await user.click(logo)
  await user.click(logo)
  await user.click(logo)
  await user.click(logo)
  await user.click(logo)

  expect(logo).toHaveAttribute("data-spinning", "true")
  expect(useAuthStore.getState().token).toBe("token-123")
})
