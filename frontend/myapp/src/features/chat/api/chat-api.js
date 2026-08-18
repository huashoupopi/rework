import { useAuthStore } from "@/features/auth/store/auth-store"
import { http } from "@/shared/api/http"

function normalizeFiles(files) {
  if (files instanceof FileList) {
    return Array.from(files)
  }

  return Array.isArray(files) ? files : files ? [files] : []
}

async function buildStreamError(response) {
  const message = (await response.text()) || `Request failed with status ${response.status}`
  const error = new Error(message)

  error.status = response.status

  return error
}

export async function getChatHistory({ taskId, limit = 50, order = "asc", before, after } = {}) {
  const params = {
    limit,
    order,
  }

  if (taskId !== undefined && taskId !== null && taskId !== "") {
    params.task_id = taskId
  }

  if (before !== undefined && before !== null) {
    params.before = before
  }

  if (after !== undefined && after !== null) {
    params.after = after
  }

  const response = await http.get("/chat/history", {
    params,
  })

  return response.data
}

export async function streamChat({ question, taskId, images, onChunk, signal } = {}) {
  const payload = new FormData()
  payload.append("question", question ?? "")

  if (taskId !== undefined && taskId !== null && taskId !== "") {
    payload.append("task_id", String(taskId))
  }

  for (const image of normalizeFiles(images)) {
    payload.append("images", image)
  }

  const token = useAuthStore.getState().token
  const response = await fetch("/api/chat/stream", {
    body: payload,
    headers: token
      ? {
          Authorization: `Bearer ${token}`,
        }
      : {},
    method: "POST",
    signal,
  })

  if (!response.ok) {
    if (response.status === 401) {
      useAuthStore.getState().clearAuth()
    }
    throw await buildStreamError(response)
  }

  const reader = response.body?.getReader()

  if (!reader) {
    return ""
  }

  const decoder = new TextDecoder()
  let content = ""

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    const chunk = decoder.decode(value, {
      stream: true,
    })

    content += chunk
    onChunk?.(chunk)
  }

  const remaining = decoder.decode()

  if (remaining) {
    content += remaining
    onChunk?.(remaining)
  }

  return content
}
