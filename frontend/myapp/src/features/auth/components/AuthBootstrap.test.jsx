import * as React from "react"
import { afterEach, expect, test, vi } from "vitest"
import { act, render, waitFor } from "@testing-library/react"

import { useAuthStore } from "@/features/auth/store/auth-store"

import { AuthBootstrap } from "./AuthBootstrap"

const getCurrentUserMock = vi.fn()

vi.mock("@/features/auth/api/auth-api", () => ({
  getCurrentUser: (...args) => getCurrentUserMock(...args),
}))

let consoleErrorSpy

function hasActWarning() {
  return consoleErrorSpy.mock.calls.some((call) => call.some((value) => String(value).includes("not wrapped in act")))
}

afterEach(() => {
  consoleErrorSpy?.mockRestore()
  getCurrentUserMock.mockReset()
  return act(async () => {
    useAuthStore.setState({
      hydrated: false,
      token: null,
      userInfo: null,
    })
  })
})

test("hydrates immediately when there is no persisted token", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  await act(async () => {
    render(
      <AuthBootstrap>
        <div>app</div>
      </AuthBootstrap>,
    )
  })

  await waitFor(() => {
    expect(useAuthStore.getState().hydrated).toBe(true)
  })

  expect(getCurrentUserMock).not.toHaveBeenCalled()
  expect(hasActWarning()).toBe(false)
})

test("loads the current user when a token exists", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  getCurrentUserMock.mockResolvedValue({
    id: 1,
    username: "demo",
    full_name: "Demo",
    is_superuser: false,
    created_at: "2026-03-21T00:00:00Z",
  })

  await act(async () => {
    useAuthStore.setState({
      hydrated: false,
      token: "token-123",
      userInfo: null,
    })
  })

  await act(async () => {
    render(
      <AuthBootstrap>
        <div>app</div>
      </AuthBootstrap>,
    )
  })

  await waitFor(() => {
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      token: "token-123",
      userInfo: {
        username: "demo",
      },
    })
  })
  expect(hasActWarning()).toBe(false)
})

test("clears auth when loading the current user fails", async () => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  getCurrentUserMock.mockRejectedValue({
    response: {
      status: 401,
    },
  })

  await act(async () => {
    useAuthStore.setState({
      hydrated: false,
      token: "token-123",
      userInfo: null,
    })
  })

  await act(async () => {
    render(
      <AuthBootstrap>
        <div>app</div>
      </AuthBootstrap>,
    )
  })

  await waitFor(() => {
    expect(useAuthStore.getState()).toMatchObject({
      hydrated: true,
      token: null,
      userInfo: null,
    })
  })
  expect(hasActWarning()).toBe(false)
})
