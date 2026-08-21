import * as React from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const deleteUserByIdMock = vi.fn()
const refreshMock = vi.fn()

vi.mock("@/features/user-admin/hooks/useUserAdmin", () => ({
  useUserAdmin: () => ({
    currentUserId: 1,
    deleteUserById: deleteUserByIdMock,
    error: null,
    loading: false,
    refresh: refreshMock,
    users: [
      {
        full_name: "Admin",
        id: 1,
        is_superuser: true,
        username: "admin",
      },
      {
        full_name: "Demo User",
        id: 2,
        is_superuser: false,
        username: "demo",
      },
    ],
  }),
}))

const { UsersPage } = await import("./UsersPage")

afterEach(() => {
  deleteUserByIdMock.mockReset()
  refreshMock.mockReset()
})

test("renders the user table", () => {
  render(<UsersPage />)

  expect(screen.getByRole("heading", { name: "用户管理" })).toBeInTheDocument()
  expect(screen.getByText("系统管理")).toBeInTheDocument()
  expect(screen.getByText("查看用户角色与权限，管理账号生命周期。")).toBeInTheDocument()
  expect(screen.getByText("admin")).toBeInTheDocument()
  expect(screen.getByText("demo")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "刷新" })).toBeInTheDocument()
})

// 2026-08-21 删除改成两步：先弹 Popconfirm，确认后才调 hook。
// 这条测试因此同时是「不确认就不会删」的回归防线。
test("delete needs confirmation before it reaches the hook", async () => {
  deleteUserByIdMock.mockResolvedValueOnce(null)

  render(<UsersPage />)

  fireEvent.click(screen.getByRole("button", { name: "删除" }))

  // 只点了删除按钮，确认框还没确认 —— 此时不应该有任何请求发出
  expect(deleteUserByIdMock).not.toHaveBeenCalled()

  // 触发按钮与确认按钮同名，必须在弹层容器内取，否则命中两个
  const popup = await screen.findByRole("tooltip")
  fireEvent.click(within(popup).getByRole("button", { name: /删\s*除/ }))

  await waitFor(() => {
    expect(deleteUserByIdMock).toHaveBeenCalledWith(2)
  })
})

test("shows the current account as a hint, not a dead button", () => {
  render(<UsersPage />)

  // 原先这里是一个 disabled 的「不可删除自己」按钮 —— 那是状态不是动作，
  // 做成按钮只会看起来像坏了。
  expect(screen.getByText("当前登录账号")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "不可删除自己" })).not.toBeInTheDocument()
})

test("renders the real user table with Antd table chrome", async () => {
  const { UserTable } = await vi.importActual("@/features/user-admin/components/UserTable")

  const { container } = render(
    <UserTable
      currentUserId={1}
      onDeleteUser={vi.fn()}
      users={[
        {
          full_name: "Admin",
          id: 1,
          is_superuser: true,
          username: "admin",
        },
        {
          full_name: "Demo User",
          id: 2,
          is_superuser: false,
          username: "demo",
        },
      ]}
    />,
  )

  expect(container.querySelector(".ant-table")).toBeInTheDocument()
})
