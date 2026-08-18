import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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

test("forwards delete actions to the hook", async () => {
  deleteUserByIdMock.mockResolvedValueOnce(null)

  render(<UsersPage />)

  fireEvent.click(screen.getByRole("button", { name: "删除 demo" }))

  await waitFor(() => {
    expect(deleteUserByIdMock).toHaveBeenCalledWith(2)
  })
})

test("disables self-delete entry", () => {
  render(<UsersPage />)

  expect(screen.getByRole("button", { name: "不可删除自己" })).toBeDisabled()
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
