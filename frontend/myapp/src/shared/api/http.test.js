import { expect, test } from "vitest"

import { useAuthStore } from "@/features/auth/store/auth-store"

import { applyAuthHeader, handleHttpError } from "./http"

test("adds a bearer token when auth is available", () => {
  const config = applyAuthHeader({ headers: {} }, "token-123")

  expect(config.headers.Authorization).toBe("Bearer token-123")
})

test("keeps the request unchanged when there is no token", () => {
  const config = applyAuthHeader({ headers: {} }, null)

  expect(config.headers.Authorization).toBeUndefined()
})

test("clears auth state when a 401 response is received", async () => {
  useAuthStore.setState({
    hydrated: true,
    token: "token-123",
    userInfo: { id: 1, is_superuser: false, username: "demo" },
  })

  await expect(
    handleHttpError({
      response: {
        status: 401,
      },
    }),
  ).rejects.toMatchObject({
    response: {
      status: 401,
    },
  })

  expect(useAuthStore.getState()).toMatchObject({
    hydrated: true,
    token: null,
    userInfo: null,
  })
})
