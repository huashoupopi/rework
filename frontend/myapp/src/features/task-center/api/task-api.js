import { downloadFile, http } from "@/shared/api/http"

function normalizeFiles(files) {
  if (files instanceof FileList) {
    return Array.from(files)
  }

  return Array.isArray(files) ? files : [files]
}

export async function uploadTasks(files) {
  const payload = new FormData()

  for (const file of normalizeFiles(files)) {
    payload.append("files", file)
  }

  const response = await http.post("/tasks/upload", payload, {
    headers: {
      "Content-Type": "multipart/form-data",
    },
  })

  return response.data
}

export async function getTasks(page = 1, pageSize = 10) {
  const skip = Math.max(0, (page - 1) * pageSize)
  const limit = pageSize

  const response = await http.get("/tasks", {
    params: {
      limit,
      skip,
    },
  })

  return response.data
}

export async function getTaskDetail(taskId) {
  const response = await http.get(`/tasks/${taskId}`)

  return response.data
}

export async function downloadTaskImage(taskId) {
  const response = await downloadFile(`/tasks/${taskId}/download/image`)

  return response.data
}

export async function exportTask(taskId, format) {
  return downloadFile(`/tasks/${taskId}/export`, {
    params: { format },
  })
}

export async function downloadTaskBatch(taskIds) {
  const params = new URLSearchParams()

  for (const taskId of taskIds) {
    params.append("task_ids", String(taskId))
  }

  const response = await downloadFile(`/tasks/batch/download?${params.toString()}`)

  return response.data
}
