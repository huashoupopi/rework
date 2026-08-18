import * as React from "react"
import { act, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach } from "vitest"

import { AdminRoute } from "@/features/auth/components/AdminRoute"
import { useAuthStore } from "@/features/auth/store/auth-store"

const baseUser = {
  id: 1,
  username: "operator",
  full_name: "Operator",
  created_at: "2026-03-21T00:00:00Z",
}

afterEach(() => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: null,
      userInfo: null,
    })
  })
})

test("redirects non-admin users to home", async () => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: "demo-token",
      userInfo: {
        ...baseUser,
        is_superuser: false,
      },
    })
  })

  render(
    <MemoryRouter initialEntries={["/users"]}>
      <Routes>
        <Route path="/" element={<h1>工作台</h1>} />
        <Route element={<AdminRoute />}>
          <Route path="/users" element={<h1>用户管理</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

  expect(await screen.findByRole("heading", { name: /工作台/i })).toBeInTheDocument()
})

test("renders admin routes for superusers", async () => {
  act(() => {
    useAuthStore.setState({
      hydrated: true,
      token: "demo-token",
      userInfo: {
        ...baseUser,
        is_superuser: true,
      },
    })
  })

  render(
    <MemoryRouter initialEntries={["/users"]}>
      <Routes>
        <Route path="/" element={<h1>工作台</h1>} />
        <Route element={<AdminRoute />}>
          <Route path="/users" element={<h1>用户管理</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )

  expect(await screen.findByRole("heading", { name: /用户管理/i })).toBeInTheDocument()
})
