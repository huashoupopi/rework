import { afterEach, expect, test, vi } from "vitest"

const getMock = vi.fn()
const postMock = vi.fn()
const patchMock = vi.fn()
const deleteMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    get: (...args) => getMock(...args),
    post: (...args) => postMock(...args),
    patch: (...args) => patchMock(...args),
    delete: (...args) => deleteMock(...args),
  },
}))

const {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} = await import("./conversation-api")

afterEach(() => {
  getMock.mockReset()
  postMock.mockReset()
  patchMock.mockReset()
  deleteMock.mockReset()
})

test("listConversations hits GET /conversations", async () => {
  getMock.mockResolvedValueOnce({ data: { items: [{ id: 1, title: "历史对话" }] } })
  const result = await listConversations()
  expect(getMock).toHaveBeenCalledWith("/conversations")
  expect(result.items[0].title).toBe("历史对话")
})

test("createConversation posts optional task_id", async () => {
  postMock.mockResolvedValueOnce({ data: { id: 9, title: "新对话", task_id: 7 } })
  const result = await createConversation({ taskId: 7 })
  expect(postMock).toHaveBeenCalledWith("/conversations", { task_id: 7 })
  expect(result.id).toBe(9)
})

test("rename and delete target the conversation id", async () => {
  patchMock.mockResolvedValueOnce({ data: { id: 3, title: "叶片A" } })
  deleteMock.mockResolvedValueOnce({})
  await renameConversation(3, "叶片A")
  await deleteConversation(3)
  expect(patchMock).toHaveBeenCalledWith("/conversations/3", { title: "叶片A" })
  expect(deleteMock).toHaveBeenCalledWith("/conversations/3")
})
