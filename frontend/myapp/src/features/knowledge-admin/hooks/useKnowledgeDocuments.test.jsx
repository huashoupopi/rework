import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getKnowledgeDocumentsMock = vi.fn()
const uploadKnowledgeDocumentMock = vi.fn()
const deleteKnowledgeDocumentMock = vi.fn()

vi.mock("../api/knowledge-api", () => ({
  deleteKnowledgeDocument: (...args) => deleteKnowledgeDocumentMock(...args),
  getKnowledgeDocuments: (...args) => getKnowledgeDocumentsMock(...args),
  uploadKnowledgeDocument: (...args) => uploadKnowledgeDocumentMock(...args),
}))

const { useKnowledgeDocuments } = await import("./useKnowledgeDocuments")

afterEach(() => {
  deleteKnowledgeDocumentMock.mockReset()
  getKnowledgeDocumentsMock.mockReset()
  uploadKnowledgeDocumentMock.mockReset()
})

test("loads knowledge documents on mount with default list params", async () => {
  getKnowledgeDocumentsMock.mockResolvedValueOnce({
    documents: [
      {
        doc_key: "guide",
        title: "guide.md",
      },
    ],
    total: 1,
  })

  const { result } = renderHook(() => useKnowledgeDocuments())

  await waitFor(() => {
    expect(getKnowledgeDocumentsMock).toHaveBeenCalledWith({
      keyword: "",
      limit: 10,
      offset: 0,
      status: "active",
    })
  })

  await waitFor(() => {
    expect(result.current.documents).toEqual([
      {
        doc_key: "guide",
        title: "guide.md",
      },
    ])
    expect(result.current.total).toBe(1)
  })
})

test("uploadDocument refreshes the current list after a successful upload", async () => {
  getKnowledgeDocumentsMock
    .mockResolvedValueOnce({
      documents: [],
      total: 0,
    })
    .mockResolvedValueOnce({
      documents: [
        {
          doc_key: "guide",
          title: "guide.md",
        },
      ],
      total: 1,
    })
  uploadKnowledgeDocumentMock.mockResolvedValueOnce({
    created: true,
  })

  const file = new File(["knowledge"], "guide.md", {
    type: "text/markdown",
  })

  const { result } = renderHook(() => useKnowledgeDocuments())

  await waitFor(() => {
    expect(getKnowledgeDocumentsMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.uploadDocument(file)
  })

  expect(uploadKnowledgeDocumentMock).toHaveBeenCalledWith(file)
  await waitFor(() => {
    expect(getKnowledgeDocumentsMock).toHaveBeenCalledTimes(2)
  })
})

test("deleteDocument refreshes the current list after a successful delete", async () => {
  getKnowledgeDocumentsMock
    .mockResolvedValueOnce({
      documents: [
        {
          doc_key: "guide",
          title: "guide.md",
        },
      ],
      total: 1,
    })
    .mockResolvedValueOnce({
      documents: [],
      total: 0,
    })
  deleteKnowledgeDocumentMock.mockResolvedValueOnce({
    success: true,
  })

  const { result } = renderHook(() => useKnowledgeDocuments())

  await waitFor(() => {
    expect(getKnowledgeDocumentsMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.deleteDocument("guide", {
      physicalDelete: true,
    })
  })

  expect(deleteKnowledgeDocumentMock).toHaveBeenCalledWith("guide", {
    physicalDelete: true,
  })
  await waitFor(() => {
    expect(getKnowledgeDocumentsMock).toHaveBeenCalledTimes(2)
  })
})
