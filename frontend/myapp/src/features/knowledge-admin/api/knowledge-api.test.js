import { expect, test, vi } from "vitest"

const getMock = vi.fn()
const postMock = vi.fn()
const putMock = vi.fn()
const deleteMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    delete: (...args) => deleteMock(...args),
    get: (...args) => getMock(...args),
    post: (...args) => postMock(...args),
    put: (...args) => putMock(...args),
  },
}))

const {
  createChunkConfig,
  deleteChunkConfig,
  deleteKnowledgeDocument,
  getChunkConfigs,
  getKnowledgeDocuments,
  getKnowledgeStatus,
  triggerFullRebuild,
  triggerIncrementalRebuild,
  updateChunkConfig,
  uploadKnowledgeDocument,
} = await import("./knowledge-api")

test("getKnowledgeDocuments maps filters to /knowledge/documents", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      items: [],
      total: 0,
    },
  })

  const result = await getKnowledgeDocuments({
    keyword: "vector",
    limit: 10,
    offset: 20,
    status: "ready",
  })

  expect(getMock).toHaveBeenCalledWith("/knowledge/documents", {
    params: {
      keyword: "vector",
      limit: 10,
      offset: 20,
      status: "ready",
    },
  })
  expect(result).toEqual({
    items: [],
    total: 0,
  })
})

test("uploadKnowledgeDocument sends a single multipart file field named file", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      doc_key: "doc-1",
    },
  })

  const file = new File(["content"], "knowledge.md", {
    type: "text/markdown",
  })

  const result = await uploadKnowledgeDocument(file)

  const [url, payload] = postMock.mock.calls.at(-1)

  expect(url).toBe("/knowledge/documents/upload")
  expect(payload).toBeInstanceOf(FormData)
  expect(payload.get("file")).toBe(file)
  expect(result).toEqual({
    doc_key: "doc-1",
  })
})

test("deleteKnowledgeDocument passes physical_delete as a query param", async () => {
  deleteMock.mockResolvedValueOnce({
    data: {
      ok: true,
    },
  })

  const result = await deleteKnowledgeDocument("doc-9", {
    physicalDelete: true,
  })

  expect(deleteMock).toHaveBeenCalledWith("/knowledge/documents/doc-9", {
    params: {
      physical_delete: true,
    },
  })
  expect(result).toEqual({
    ok: true,
  })
})

test("getKnowledgeStatus requests /knowledge/status", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      status: "ready",
    },
  })

  const result = await getKnowledgeStatus()

  expect(getMock).toHaveBeenCalledWith("/knowledge/status")
  expect(result).toEqual({
    status: "ready",
  })
})

test("triggerFullRebuild sends chunkConfigId as query params", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      job_id: "job-full",
    },
  })

  const result = await triggerFullRebuild({
    chunkConfigId: 7,
  })

  expect(postMock).toHaveBeenCalledWith(
    "/knowledge/rebuild/full",
    null,
    {
      params: {
        chunk_config_id: 7,
      },
    },
  )
  expect(result).toEqual({
    job_id: "job-full",
  })
})

test("triggerIncrementalRebuild sends chunkConfigId as query params", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      job_id: "job-incremental",
    },
  })

  const result = await triggerIncrementalRebuild({
    chunkConfigId: 8,
  })

  expect(postMock).toHaveBeenCalledWith(
    "/knowledge/rebuild/incremental",
    null,
    {
      params: {
        chunk_config_id: 8,
      },
    },
  )
  expect(result).toEqual({
    job_id: "job-incremental",
  })
})

test("getChunkConfigs requests /knowledge/chunk-configs", async () => {
  getMock.mockResolvedValueOnce({
    data: [],
  })

  const result = await getChunkConfigs()

  expect(getMock).toHaveBeenCalledWith("/knowledge/chunk-configs")
  expect(result).toEqual([])
})

test("createChunkConfig posts the payload to /knowledge/chunk-configs", async () => {
  postMock.mockResolvedValueOnce({
    data: {
      id: 1,
    },
  })

  const payload = {
    chunk_size: 500,
  }
  const result = await createChunkConfig(payload)

  expect(postMock).toHaveBeenCalledWith("/knowledge/chunk-configs", payload)
  expect(result).toEqual({
    id: 1,
  })
})

test("updateChunkConfig puts the payload on /knowledge/chunk-configs/{id}", async () => {
  putMock.mockResolvedValueOnce({
    data: {
      id: 2,
    },
  })

  const payload = {
    overlap_size: 50,
  }
  const result = await updateChunkConfig(2, payload)

  expect(putMock).toHaveBeenCalledWith("/knowledge/chunk-configs/2", payload)
  expect(result).toEqual({
    id: 2,
  })
})

test("deleteChunkConfig deletes /knowledge/chunk-configs/{id}", async () => {
  deleteMock.mockResolvedValueOnce({
    data: {
      deleted: true,
    },
  })

  const result = await deleteChunkConfig(3)

  expect(deleteMock).toHaveBeenCalledWith("/knowledge/chunk-configs/3")
  expect(result).toEqual({
    deleted: true,
  })
})
