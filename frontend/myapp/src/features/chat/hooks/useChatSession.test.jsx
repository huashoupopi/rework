import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getChatHistoryMock = vi.fn()
const streamChatMock = vi.fn()
const parseStreamSegmentsMock = vi.fn()

vi.mock("../api/chat-api", () => ({
  getChatHistory: (...args) => getChatHistoryMock(...args),
  streamChat: (...args) => streamChatMock(...args),
}))

vi.mock("../utils/parseStreamSegments", () => ({
  parseStreamSegments: (...args) => parseStreamSegmentsMock(...args),
}))

const { useChatSession } = await import("./useChatSession")

afterEach(() => {
  getChatHistoryMock.mockReset()
  streamChatMock.mockReset()
  parseStreamSegmentsMock.mockReset()
})

test("loads chat history for the active task id", async () => {
  getChatHistoryMock.mockResolvedValueOnce({
    items: [
      {
        id: 1,
        role: "user",
        content: "历史问题",
        created_at: "2026-03-21T08:00:00.000Z",
      },
    ],
    total: 1,
  })

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(getChatHistoryMock).toHaveBeenCalledWith({
      limit: 50,
      order: "asc",
      taskId: 7,
    })
  })

  await waitFor(() => {
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.loadingHistory).toBe(false)
  })
})

test("sendMessage appends the user message and finalizes the assistant response from the stream", async () => {
  getChatHistoryMock.mockResolvedValueOnce({
    items: [],
    total: 0,
  })
  parseStreamSegmentsMock
    .mockReturnValueOnce({
      content: "草稿",
      sources: [],
      think: "",
    })
    .mockReturnValueOnce({
      content: "草稿内容",
      sources: [],
      think: "",
    })
    .mockReturnValueOnce({
    content: "最终回答",
    sources: [{ title: "知识库文档" }],
    think: "推理过程",
  })
  streamChatMock.mockImplementationOnce(async ({ onChunk }) => {
    onChunk("草稿")
    onChunk("内容")

    return "草稿内容<<<THINK_START>>>推理过程<<<THINK_END>>>"
  })

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(result.current.loadingHistory).toBe(false)
  })

  await act(async () => {
    await result.current.sendMessage({
      question: "请分析任务 7",
    })
  })

  expect(streamChatMock).toHaveBeenCalledWith({
    images: undefined,
    onChunk: expect.any(Function),
    question: "请分析任务 7",
    signal: expect.any(AbortSignal),
    taskId: 7,
  })
  expect(parseStreamSegmentsMock).toHaveBeenCalledWith("草稿内容<<<THINK_START>>>推理过程<<<THINK_END>>>")
  expect(result.current.messages).toHaveLength(2)
  expect(result.current.messages[0]).toMatchObject({
    role: "user",
    content: "请分析任务 7",
  })
  expect(result.current.messages[1]).toMatchObject({
    role: "assistant",
    content: "最终回答",
    meta: {
      sources: [{ title: "知识库文档" }],
      think: "推理过程",
    },
  })
})

test("preserves earlier assistant replies when a second question is sent", async () => {
  getChatHistoryMock.mockResolvedValueOnce({
    items: [],
    total: 0,
  })
  parseStreamSegmentsMock
    .mockReturnValueOnce({
      content: "第一条回答",
      sources: [],
      think: "第一条思考",
    })
    .mockReturnValueOnce({
      content: "第二条回答",
      sources: [],
      think: "第二条思考",
    })
  streamChatMock
    .mockResolvedValueOnce("first-raw-response")
    .mockResolvedValueOnce("second-raw-response")

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(result.current.loadingHistory).toBe(false)
  })

  await act(async () => {
    await result.current.sendMessage({
      question: "第一问",
    })
  })

  await act(async () => {
    await result.current.sendMessage({
      question: "第二问",
    })
  })

  expect(result.current.messages).toHaveLength(4)
  expect(result.current.messages[0]).toMatchObject({
    role: "user",
    content: "第一问",
  })
  expect(result.current.messages[1]).toMatchObject({
    role: "assistant",
    content: "第一条回答",
    meta: {
      think: "第一条思考",
    },
  })
  expect(result.current.messages[2]).toMatchObject({
    role: "user",
    content: "第二问",
  })
  expect(result.current.messages[3]).toMatchObject({
    role: "assistant",
    content: "第二条回答",
    meta: {
      think: "第二条思考",
    },
  })
})

test("blocks duplicate sends while a response is in flight", async () => {
  getChatHistoryMock.mockResolvedValueOnce({
    items: [],
    total: 0,
  })
  let resolveStream
  streamChatMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStream = resolve
      }),
  )
  parseStreamSegmentsMock.mockReturnValue({
    content: "完成",
    sources: [],
    think: "",
  })

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(result.current.loadingHistory).toBe(false)
  })

  let firstPromise

  await act(async () => {
    firstPromise = result.current.sendMessage({
      question: "第一条",
    })
  })

  await act(async () => {
    await result.current.sendMessage({
      question: "第二条",
    })
  })

  expect(streamChatMock).toHaveBeenCalledTimes(1)

  await act(async () => {
    resolveStream("完成")
    await firstPromise
  })
})

test("surfaces backend send errors", async () => {
  getChatHistoryMock.mockResolvedValueOnce({
    items: [],
    total: 0,
  })
  streamChatMock.mockRejectedValueOnce(
    Object.assign(new Error("上一条消息仍在生成"), {
      status: 409,
    }),
  )

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(result.current.loadingHistory).toBe(false)
  })

  await act(async () => {
    await result.current.sendMessage({
      question: "继续",
    })
  })

  expect(result.current.error).toMatchObject({
    message: "上一条消息仍在生成",
    status: 409,
  })
  expect(result.current.sending).toBe(false)
})

test("keeps optimistic messages when history resolves after a send has started", async () => {
  let resolveHistory
  getChatHistoryMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveHistory = resolve
      }),
  )
  parseStreamSegmentsMock
    .mockReturnValueOnce({
      content: "草稿",
      sources: [],
      think: "",
    })
    .mockReturnValueOnce({
      content: "最终回答",
      sources: [],
      think: "",
    })
  streamChatMock.mockImplementationOnce(async ({ onChunk }) => {
    onChunk("草稿")

    return "最终回答"
  })

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await act(async () => {
    void result.current.sendMessage({
      question: "并发问题",
    })
  })

  await waitFor(() => {
    expect(result.current.messages[0]).toMatchObject({
      role: "user",
      content: "并发问题",
    })
  })

  await act(async () => {
    resolveHistory({
      items: [
        {
          id: 1,
          role: "user",
          content: "更早的历史消息",
          created_at: "2026-03-21T08:00:00.000Z",
        },
      ],
      total: 1,
    })
  })

  await waitFor(() => {
    expect(result.current.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "更早的历史消息",
        }),
        expect.objectContaining({
          role: "user",
          content: "并发问题",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "最终回答",
        }),
      ]),
    )
  })
})

test("keeps optimistic messages when history refresh fails during a send", async () => {
  getChatHistoryMock
    .mockResolvedValueOnce({
      items: [],
      total: 0,
    })
    .mockRejectedValueOnce(new Error("history failed"))
  let resolveStream
  parseStreamSegmentsMock
    .mockReturnValueOnce({
      content: "草稿",
      sources: [],
      think: "",
    })
    .mockReturnValueOnce({
      content: "最终回答",
      sources: [],
      think: "",
    })
  streamChatMock.mockImplementationOnce(
    ({ onChunk }) =>
      new Promise((resolve) => {
        onChunk("草稿")
        resolveStream = resolve
      }),
  )

  const { result } = renderHook(() => useChatSession({ taskId: 7 }))

  await waitFor(() => {
    expect(result.current.loadingHistory).toBe(false)
  })

  let sendPromise

  await act(async () => {
    sendPromise = result.current.sendMessage({
      question: "刷新失败保护",
    })
  })

  await act(async () => {
    await result.current.refreshHistory()
  })

  await act(async () => {
    resolveStream("最终回答")
    await sendPromise
  })

  expect(result.current.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: "刷新失败保护",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "最终回答",
      }),
    ]),
  )
  expect(result.current.error).toMatchObject({
    message: "history failed",
  })
})
