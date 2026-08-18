import { afterEach, expect, test, vi } from "vitest"

import { useAuthStore } from "@/features/auth/store/auth-store"

const getMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    get: (...args) => getMock(...args),
  },
}))

const { getChatHistory, streamChat } = await import("./chat-api")

afterEach(() => {
  getMock.mockReset()
  vi.unstubAllGlobals()
  useAuthStore.setState({
    hydrated: true,
    token: null,
    userInfo: null,
  })
})

test("getChatHistory maps task scope and pagination params to /chat/history", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      items: [],
      total: 0,
    },
  })

  const result = await getChatHistory({
    limit: 20,
    order: "desc",
    taskId: 7,
  })

  expect(getMock).toHaveBeenCalledWith("/chat/history", {
    params: {
      limit: 20,
      order: "desc",
      task_id: 7,
    },
  })
  expect(result).toEqual({
    items: [],
    total: 0,
  })
})

test("streamChat sends multipart form data with auth and streams plain text chunks", async () => {
  useAuthStore.setState({
    hydrated: true,
    token: "token-123",
    userInfo: {
      id: 1,
      username: "demo",
      is_superuser: false,
    },
  })

  const fetchMock = vi.fn().mockResolvedValueOnce({
    body: {
      getReader: () => ({
        read: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode("你好，"),
          })
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode("世界"),
          })
          .mockResolvedValueOnce({
            done: true,
            value: undefined,
          }),
      }),
    },
    ok: true,
    status: 200,
  })

  vi.stubGlobal("fetch", fetchMock)

  const image = new File(["image"], "sample.png", {
    type: "image/png",
  })
  const onChunk = vi.fn()

  const result = await streamChat({
    images: [image],
    onChunk,
    question: "请分析这张图",
    taskId: 7,
  })

  const [url, options] = fetchMock.mock.calls.at(-1)
  const payload = options.body

  expect(url).toBe("/api/chat/stream")
  expect(options.method).toBe("POST")
  expect(options.headers.Authorization).toBe("Bearer token-123")
  expect(payload).toBeInstanceOf(FormData)
  expect(payload.get("question")).toBe("请分析这张图")
  expect(payload.get("task_id")).toBe("7")
  expect(payload.getAll("images")).toEqual([image])
  expect(onChunk).toHaveBeenNthCalledWith(1, "你好，")
  expect(onChunk).toHaveBeenNthCalledWith(2, "世界")
  expect(result).toBe("你好，世界")
})

test("streamChat throws a status-bearing error when the stream request fails", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({
    ok: false,
    status: 409,
    text: vi.fn().mockResolvedValueOnce("上一条消息仍在生成"),
  })

  vi.stubGlobal("fetch", fetchMock)

  await expect(
    streamChat({
      question: "继续",
    }),
  ).rejects.toMatchObject({
    message: "上一条消息仍在生成",
    status: 409,
  })
})
