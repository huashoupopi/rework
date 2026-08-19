import { http } from "@/shared/api/http"

export async function listConversations() {
  const response = await http.get("/conversations")
  return response.data
}

export async function createConversation({ taskId, title } = {}) {
  const payload = {}

  if (taskId !== undefined && taskId !== null && taskId !== "") {
    payload.task_id = taskId
  }

  if (title) {
    payload.title = title
  }

  const response = await http.post("/conversations", payload)
  return response.data
}

export async function renameConversation(conversationId, title) {
  const response = await http.patch(`/conversations/${conversationId}`, { title })
  return response.data
}

export async function deleteConversation(conversationId) {
  await http.delete(`/conversations/${conversationId}`)
}
