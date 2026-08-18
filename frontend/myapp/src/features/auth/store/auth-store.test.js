import { afterEach, expect, test } from "vitest"

import { useAuthStore } from "@/features/auth/store/auth-store"

const initialState = {
  hydrated: false,
  token: null,
  userInfo: null,
}

afterEach(() => {
  useAuthStore.setState(initialState)
})

test("starts unauthenticated by default", () => {
  expect(useAuthStore.getState()).toMatchObject(initialState)
})

test("stores token and user info when auth is set", () => {
  useAuthStore.getState().setAuth({
    token: "token-123",
    userInfo: { id: 1, is_superuser: false, username: "demo" },
  })

  expect(useAuthStore.getState()).toMatchObject({
    hydrated: true,
    token: "token-123",
    userInfo: { id: 1, is_superuser: false, username: "demo" },
  })
})

test("clears auth back to the initial state", () => {
  useAuthStore.getState().setAuth({
    token: "token-123",
    userInfo: { id: 1, is_superuser: true, username: "admin" },
  })

  useAuthStore.getState().clearAuth()

  expect(useAuthStore.getState()).toMatchObject({
    hydrated: true,
    token: null,
    userInfo: null,
  })
})
