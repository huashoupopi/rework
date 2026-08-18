import { expect, test, vi } from "vitest"

const getMock = vi.fn()
const postMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    get: (...args) => getMock(...args),
    post: (...args) => postMock(...args),
  },
}))

const { getCurrentUser, login, register } = await import("./auth-api")

test("login sends form-urlencoded credentials", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      access_token: "token-123",
      token_type: "bearer",
    },
  })

  const result = await login({
    password: "secret",
    username: "demo",
  })

  const [url, payload, config] = postMock.mock.calls.at(-1)

  expect(url).toBe("/auth/login")
  expect(payload).toBeInstanceOf(URLSearchParams)
  expect(payload.get("username")).toBe("demo")
  expect(payload.get("password")).toBe("secret")
  expect(config.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
  expect(result).toMatchObject({
    access_token: "token-123",
  })
})

test("register sends the expected JSON payload", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      id: 1,
      username: "demo",
    },
  })

  await register({
    full_name: "Demo User",
    password: "secret",
    username: "demo",
  })

  const [url, payload] = postMock.mock.calls.at(-1)

  expect(url).toBe("/auth/register")
  expect(payload).toEqual({
    full_name: "Demo User",
    password: "secret",
    username: "demo",
  })
})

test("current user is loaded from /users/me", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      id: 1,
      username: "demo",
    },
  })

  const result = await getCurrentUser()

  expect(getMock).toHaveBeenCalledWith("/users/me")
  expect(result).toEqual({
    id: 1,
    username: "demo",
  })
})
