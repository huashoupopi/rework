import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getKnowledgeStatusMock = vi.fn()
const triggerFullRebuildMock = vi.fn()
const triggerIncrementalRebuildMock = vi.fn()

vi.mock("../api/knowledge-api", () => ({
  getKnowledgeStatus: (...args) => getKnowledgeStatusMock(...args),
  triggerFullRebuild: (...args) => triggerFullRebuildMock(...args),
  triggerIncrementalRebuild: (...args) => triggerIncrementalRebuildMock(...args),
}))

const { useKnowledgeStatus } = await import("./useKnowledgeStatus")

afterEach(() => {
  getKnowledgeStatusMock.mockReset()
  triggerFullRebuildMock.mockReset()
  triggerIncrementalRebuildMock.mockReset()
  vi.useRealTimers()
})

test("loads knowledge rebuild status on mount", async () => {
  getKnowledgeStatusMock.mockResolvedValueOnce({
    documents: [],
    failed: 0,
    indexed: 2,
    pending: 1,
    rebuild_running: false,
    total_documents: 3,
  })

  const { result } = renderHook(() => useKnowledgeStatus())

  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(1)
  })

  await waitFor(() => {
    expect(result.current.status).toMatchObject({
      indexed: 2,
      pending: 1,
      total_documents: 3,
    })
  })
})

test("refresh reloads the latest rebuild status", async () => {
  getKnowledgeStatusMock
    .mockResolvedValueOnce({
      documents: [],
      pending: 1,
      rebuild_running: false,
      total_documents: 1,
    })
    .mockResolvedValueOnce({
      documents: [],
      pending: 0,
      rebuild_running: false,
      total_documents: 1,
    })

  const { result } = renderHook(() => useKnowledgeStatus())

  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.refresh()
  })

  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(2)
  })
})

test("triggerFullRebuild stores the backend message and refreshes status", async () => {
  getKnowledgeStatusMock
    .mockResolvedValueOnce({
      documents: [],
      rebuild_running: false,
      total_documents: 2,
    })
    .mockResolvedValueOnce({
      documents: [],
      rebuild_running: true,
      total_documents: 2,
    })
  triggerFullRebuildMock.mockResolvedValueOnce({
    message: "已提交全量重建",
    success: true,
  })

  const { result } = renderHook(() => useKnowledgeStatus())

  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.triggerFullRebuild({
      chunkConfigId: 7,
    })
  })

  expect(triggerFullRebuildMock).toHaveBeenCalledWith({
    chunkConfigId: 7,
  })
  expect(result.current.actionMessage).toBe("已提交全量重建")
  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(2)
  })
})

test("triggerIncrementalRebuild stores the backend message and refreshes status", async () => {
  getKnowledgeStatusMock
    .mockResolvedValueOnce({
      documents: [],
      rebuild_running: false,
      total_documents: 2,
    })
    .mockResolvedValueOnce({
      documents: [],
      rebuild_running: true,
      total_documents: 2,
    })
  triggerIncrementalRebuildMock.mockResolvedValueOnce({
    message: "没有待索引的文档",
    success: true,
  })

  const { result } = renderHook(() => useKnowledgeStatus())

  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.triggerIncrementalRebuild({
      chunkConfigId: 9,
    })
  })

  expect(triggerIncrementalRebuildMock).toHaveBeenCalledWith({
    chunkConfigId: 9,
  })
  expect(result.current.actionMessage).toBe("没有待索引的文档")
  await waitFor(() => {
    expect(getKnowledgeStatusMock).toHaveBeenCalledTimes(2)
  })
})
