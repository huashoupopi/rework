import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"

const sendMessageMock = vi.fn()
const refreshHistoryMock = vi.fn()
const useChatSessionMock = vi.fn()
const useConversationsMock = vi.fn()
const useTaskDetailMock = vi.fn()

vi.mock("@/features/chat/hooks/useChatSession", () => ({
  useChatSession: (...args) => useChatSessionMock(...args),
}))

vi.mock("@/features/chat/hooks/useConversations", () => ({
  useConversations: (...args) => useConversationsMock(...args),
}))

vi.mock("@/features/task-center/hooks/useTaskDetail", () => ({
  useTaskDetail: (...args) => useTaskDetailMock(...args),
}))

const { ChatPage } = await import("./ChatPage")

function mockSession(overrides = {}) {
  return {
    error: null,
    loadingHistory: false,
    messages: [],
    refreshHistory: refreshHistoryMock,
    sendMessage: sendMessageMock,
    sending: false,
    ...overrides,
  }
}

function mockConversations(overrides = {}) {
  return {
    create: vi.fn(),
    error: null,
    items: [],
    loading: false,
    refresh: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  sendMessageMock.mockReset()
  refreshHistoryMock.mockReset()
  useChatSessionMock.mockReset()
  useConversationsMock.mockReset()
  useTaskDetailMock.mockReset()
})

function renderChatPage(initialEntry = "/chat?taskId=7") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<ChatPage />} path="/chat" />
      </Routes>
    </MemoryRouter>,
  )
}

test("renders task-context chat and forwards composer submit to useChatSession", async () => {
  sendMessageMock.mockResolvedValueOnce(undefined)
  useChatSessionMock.mockReturnValue(
    mockSession({
      messages: [
        {
          id: 1,
          role: "assistant",
          content: "这是历史回答",
          meta: {
            sources: [{ title: "文档 A" }, { title: "文档 B" }],
          },
          status: "streaming",
        },
      ],
    }),
  )
  useConversationsMock.mockReturnValue(mockConversations())
  useTaskDetailMock.mockReturnValue({
    task: {
      detect_result: {
        objects: [{ class: "craze" }, { class: "craze" }, { class: "corrosion" }],
      },
    },
  })

  renderChatPage()

  expect(useChatSessionMock).toHaveBeenCalledWith({
    conversationId: undefined,
    taskId: 7,
  })
  expect(screen.getByRole("heading", { name: "智能问答" })).toBeInTheDocument()
  expect(screen.getByText("围绕当前任务继续推理、追问和记录处理判断。")).toBeInTheDocument()
  expect(screen.getByRole("log", { name: "聊天消息列表" })).toHaveAttribute("aria-live", "polite")
  expect(screen.getByText("关联任务 #7")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "当前任务缺陷摘要" })).toBeInTheDocument()
  expect(screen.getByText("裂纹 2")).toBeInTheDocument()
  expect(screen.getByText("腐蚀 1")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "会话" })).toBeInTheDocument()
  expect(screen.getByText("参考文献 (2)")).toBeInTheDocument()
  expect(screen.getByText("生成中")).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText("输入问题"), {
    target: { value: "请继续分析" },
  })
  fireEvent.click(screen.getByRole("button", { name: /发送/ }))

  await waitFor(() => {
    expect(sendMessageMock).toHaveBeenCalledWith({
      images: [],
      question: "请继续分析",
    })
  })
})

test("renders general chat mode and surfaces hook errors", () => {
  useChatSessionMock.mockReturnValue(
    mockSession({
      error: Object.assign(new Error("上一条消息仍在生成"), {
        status: 409,
      }),
      sending: true,
    }),
  )
  useConversationsMock.mockReturnValue(mockConversations())
  useTaskDetailMock.mockReturnValue({ task: null })

  renderChatPage("/chat")

  expect(useChatSessionMock).toHaveBeenCalledWith({
    conversationId: undefined,
    taskId: undefined,
  })
  expect(screen.getByRole("heading", { name: "智能问答" })).toBeInTheDocument()
  expect(screen.getByText("围绕当前任务继续推理、追问和记录处理判断。")).toBeInTheDocument()
  expect(screen.getByText("开始对话")).toBeInTheDocument()
  expect(screen.getByText("通用对话")).toBeInTheDocument()
  expect(screen.getByRole("alert")).toHaveTextContent("上一条消息仍在生成")
  expect(screen.getByRole("button", { name: /终止/ })).toBeInTheDocument()
})

test("treats taskId=0 as a valid task context", () => {
  useChatSessionMock.mockReturnValue(mockSession())
  useConversationsMock.mockReturnValue(mockConversations())
  useTaskDetailMock.mockReturnValue({ task: null })

  renderChatPage("/chat?taskId=0")

  expect(useChatSessionMock).toHaveBeenCalledWith({
    conversationId: undefined,
    taskId: 0,
  })
  expect(screen.getByText("关联任务 #0")).toBeInTheDocument()
})

test("treats invalid taskId as general chat mode", () => {
  useChatSessionMock.mockReturnValue(mockSession())
  useConversationsMock.mockReturnValue(mockConversations())
  useTaskDetailMock.mockReturnValue({ task: null })

  renderChatPage("/chat?taskId=foo")

  expect(useChatSessionMock).toHaveBeenCalledWith({
    conversationId: undefined,
    taskId: undefined,
  })
  expect(screen.getByText("通用对话")).toBeInTheDocument()
})
