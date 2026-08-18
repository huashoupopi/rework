import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { useAuthStore } from "@/features/auth/store/auth-store"

const getUsersMock = vi.fn()
const deleteUserMock = vi.fn()

vi.mock("../api/user-api", () => ({
  deleteUser: (...args) => deleteUserMock(...args),
  getUsers: (...args) => getUsersMock(...args),
}))

const { useUserAdmin } = await import("./useUserAdmin")

let consoleErrorSpy

function hasActWarning() {
  return consoleErrorSpy.mock.calls.some((call) => call.some((value) => String(value).includes("not wrapped in act")))
}

afterEach(() => {
  consoleErrorSpy?.mockRestore()
  deleteUserMock.mockReset()
  getUsersMock.mockReset()
  return act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: null,
      userInfo: null,
    })
  })
})

test("loads users on mount", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  getUsersMock.mockResolvedValueOnce([
    {
      id: 1,
      is_superuser: true,
      username: "admin",
    },
  ])

  const { result } = renderHook(() => useUserAdmin())

  await waitFor(() => {
    expect(getUsersMock).toHaveBeenCalledWith({
      page: 1,
      pageSize: 100,
    })
  })

  await waitFor(() => {
    expect(result.current.users).toEqual([
      {
        id: 1,
        is_superuser: true,
        username: "admin",
      },
    ])
  })
  expect(hasActWarning()).toBe(false)
})

test("deleteUserById refreshes the user list after delete", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token",
      userInfo: {
        id: 1,
        is_superuser: true,
        username: "admin",
      },
    })
  })

  getUsersMock
    .mockResolvedValueOnce([
      {
        id: 1,
        username: "admin",
      },
      {
        id: 2,
        username: "demo",
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 1,
        username: "admin",
      },
    ])
  deleteUserMock.mockResolvedValueOnce(null)

  const { result } = renderHook(() => useUserAdmin())

  await waitFor(() => {
    expect(getUsersMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.deleteUserById(2)
  })

  expect(deleteUserMock).toHaveBeenCalledWith(2)
  await waitFor(() => {
    expect(getUsersMock).toHaveBeenCalledTimes(2)
  })
  await waitFor(() => {
    expect(result.current.loading).toBe(false)
  })
  expect(hasActWarning()).toBe(false)
})

test("deleteUserById rejects self-delete before making the request", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  await act(async () => {
    useAuthStore.setState({
      hydrated: true,
      token: "token",
      userInfo: {
        id: 7,
        is_superuser: true,
        username: "admin",
      },
    })
  })
  getUsersMock.mockResolvedValueOnce([
    {
      id: 7,
      username: "admin",
    },
  ])

  const { result } = renderHook(() => useUserAdmin())

  await waitFor(() => {
    expect(getUsersMock).toHaveBeenCalledTimes(1)
  })
  await waitFor(() => {
    expect(result.current.loading).toBe(false)
  })

  await expect(result.current.deleteUserById(7)).rejects.toThrow("无法删除自己")
  expect(deleteUserMock).not.toHaveBeenCalled()
  expect(hasActWarning()).toBe(false)
})
