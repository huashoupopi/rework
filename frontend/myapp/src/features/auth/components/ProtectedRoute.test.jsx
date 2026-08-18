import * as React from "react"
import { afterEach, test } from "vitest"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

import { useAuthStore } from "@/features/auth/store/auth-store"

import { ProtectedRoute } from "./ProtectedRoute"

let consoleErrorSpy

function hasActWarning() {
  return consoleErrorSpy.mock.calls.some((call) => call.some((value) => String(value).includes("not wrapped in act")))
}

afterEach(() => {
  consoleErrorSpy?.mockRestore()
  return act(async () => {
    useAuthStore.setState({
      hydrated: false,
      token: null,
      userInfo: null,
    })
  })
})

test("shows a loading state while auth hydration is pending", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  await act(async () => {
    useAuthStore.setState({
      hydrated: false,
      token: "token-123",
      userInfo: null,
    })

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route element={<h1>任务中心</h1>} path="/tasks" />
          </Route>
          <Route element={<h1>登录</h1>} path="/login" />
        </Routes>
      </MemoryRouter>,
    )
  })

  expect(screen.getByRole("status")).toHaveTextContent("正在验证登录状态")
  expect(hasActWarning()).toBe(false)
})

test("redirects to login when the user is unauthenticated", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: null,
      userInfo: null,
    })

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route element={<h1>任务中心</h1>} path="/tasks" />
          </Route>
          <Route element={<h1>登录</h1>} path="/login" />
        </Routes>
      </MemoryRouter>,
    )
  })

  expect(await screen.findByRole("heading", { name: /登录/i })).toBeInTheDocument()
  expect(hasActWarning()).toBe(false)
})

test("renders the protected page when the user has a token", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token-123",
      userInfo: { is_superuser: false, username: "demo" },
    })

    render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route element={<h1>任务中心</h1>} path="/tasks" />
          </Route>
          <Route element={<h1>登录</h1>} path="/login" />
        </Routes>
      </MemoryRouter>,
    )
  })

  expect(await screen.findByRole("heading", { name: /任务中心/i })).toBeInTheDocument()
  expect(hasActWarning()).toBe(false)
})
