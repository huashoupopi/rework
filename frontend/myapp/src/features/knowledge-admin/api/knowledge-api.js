import { http } from "@/shared/api/http"

function buildParams(entries) {
  const params = {}

  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined && value !== null) {
      params[key] = value
    }
  }

  return params
}

export async function getKnowledgeDocuments({ status, keyword, offset = 0, limit = 20 } = {}) {
  const response = await http.get("/knowledge/documents", {
    params: buildParams({
      keyword,
      limit,
      offset,
      status,
    }),
  })

  return response.data
}

export async function uploadKnowledgeDocument(file) {
  const payload = new FormData()
  payload.append("file", file)

  const response = await http.post("/knowledge/documents/upload", payload)

  return response.data
}

export async function deleteKnowledgeDocument(docKey, { physicalDelete = false } = {}) {
  const response = await http.delete(`/knowledge/documents/${docKey}`, {
    params: {
      physical_delete: physicalDelete,
    },
  })

  return response.data
}

export async function getKnowledgeStatus() {
  const response = await http.get("/knowledge/status")

  return response.data
}

export async function triggerFullRebuild({ chunkConfigId } = {}) {
  const response = await http.post("/knowledge/rebuild/full", null, {
    params: buildParams({
      chunk_config_id: chunkConfigId,
    }),
  })

  return response.data
}

export async function triggerIncrementalRebuild({ chunkConfigId } = {}) {
  const response = await http.post("/knowledge/rebuild/incremental", null, {
    params: buildParams({
      chunk_config_id: chunkConfigId,
    }),
  })

  return response.data
}

export async function getChunkConfigs() {
  const response = await http.get("/knowledge/chunk-configs")

  return response.data
}

export async function createChunkConfig(payload) {
  const response = await http.post("/knowledge/chunk-configs", payload)

  return response.data
}

export async function updateChunkConfig(id, payload) {
  const response = await http.put(`/knowledge/chunk-configs/${id}`, payload)

  return response.data
}

export async function deleteChunkConfig(id) {
  const response = await http.delete(`/knowledge/chunk-configs/${id}`)

  return response.data
}
