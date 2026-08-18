import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const refreshMock = vi.fn()
const setFiltersMock = vi.fn()
const setPageMock = vi.fn()
const setPageSizeMock = vi.fn()
const uploadDocumentMock = vi.fn()
const deleteDocumentMock = vi.fn()

vi.mock("@/features/knowledge-admin/hooks/useKnowledgeDocuments", () => ({
  useKnowledgeDocuments: () => ({
    deleteDocument: deleteDocumentMock,
    documents: [
      {
        current_version: {
          file_name: "guide-v1.md",
        },
        doc_key: "guide",
        latest_version: 1,
        status: "active",
        title: "guide.md",
      },
    ],
    error: null,
    filters: {
      keyword: "",
      status: "",
    },
    loading: false,
    page: 1,
    pageSize: 10,
    refresh: refreshMock,
    setFilters: setFiltersMock,
    setPage: setPageMock,
    setPageSize: setPageSizeMock,
    total: 1,
    uploadDocument: uploadDocumentMock,
  }),
}))

vi.mock("@/features/knowledge-admin/components/KnowledgeUploadCard", () => ({
  KnowledgeUploadCard: ({ onUpload }) => (
    <button type="button" onClick={() => onUpload(new File(["content"], "guide.md"))}>
      模拟上传文档
    </button>
  ),
}))

vi.mock("@/features/knowledge-admin/components/KnowledgeDocumentTable", () => ({
  KnowledgeDocumentTable: ({ documents, onDeleteDocument, onPageChange, onPageSizeChange, page, pageSize, total }) => (
    <section>
      <div>文档表格:{documents.map((document) => document.title).join(",")}</div>
      <div>
        {page}/{pageSize}/{total}
      </div>
      <button type="button" onClick={() => onDeleteDocument("guide", { physicalDelete: false })}>
        删除文档入口
      </button>
      <button type="button" onClick={() => onPageChange(2)}>
        下一页
      </button>
      <button type="button" onClick={() => onPageSizeChange(20)}>
        每页 20 条
      </button>
    </section>
  ),
}))

const { KnowledgeDocumentsPage } = await import("./KnowledgeDocumentsPage")

afterEach(() => {
  deleteDocumentMock.mockReset()
  refreshMock.mockReset()
  setFiltersMock.mockReset()
  setPageMock.mockReset()
  setPageSizeMock.mockReset()
  uploadDocumentMock.mockReset()
})

test("renders upload entry, document filters, and document table", () => {
  render(<KnowledgeDocumentsPage />)

  expect(screen.getByRole("heading", { name: "知识库文档" })).toBeInTheDocument()
  expect(screen.getByText("知识资产")).toBeInTheDocument()
  expect(screen.getByText("管理文档源文件与索引状态。上传后需触发重建才可检索。")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "模拟上传文档" })).toBeInTheDocument()
  expect(screen.getByLabelText("状态筛选")).toBeInTheDocument()
  expect(screen.getByLabelText("关键词筛选")).toBeInTheDocument()
  expect(screen.getByText("文档表格:guide.md")).toBeInTheDocument()
})

test("forwards upload, delete, and pagination actions", async () => {
  uploadDocumentMock.mockResolvedValueOnce({
    created: true,
  })
  deleteDocumentMock.mockResolvedValueOnce({
    success: true,
  })

  render(<KnowledgeDocumentsPage />)

  fireEvent.click(screen.getByRole("button", { name: "模拟上传文档" }))
  fireEvent.click(screen.getByRole("button", { name: "删除文档入口" }))
  fireEvent.click(screen.getByRole("button", { name: "下一页" }))
  fireEvent.click(screen.getByRole("button", { name: "每页 20 条" }))

  await waitFor(() => {
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
  })
  await waitFor(() => {
    expect(deleteDocumentMock).toHaveBeenCalledWith("guide", {
      physicalDelete: false,
    })
  })
  expect(setPageMock).toHaveBeenCalledWith(2)
  expect(setPageMock).toHaveBeenCalledWith(1)
  expect(setPageSizeMock).toHaveBeenCalledWith(20)
})

test("updates filter state and refreshes the list", () => {
  render(<KnowledgeDocumentsPage />)

  fireEvent.change(screen.getByLabelText("关键词筛选"), {
    target: {
      value: "guide",
    },
  })
  fireEvent.change(screen.getByLabelText("状态筛选"), {
    target: {
      value: "active",
    },
  })
  fireEvent.click(screen.getByRole("button", { name: "刷新" }))

  expect(setFiltersMock).toHaveBeenCalledWith({
    keyword: "guide",
  })
  expect(setFiltersMock).toHaveBeenCalledWith({
    status: "active",
  })
  expect(refreshMock).toHaveBeenCalledTimes(1)
})

test("renders the real document table with Antd pagination chrome", async () => {
  const { KnowledgeDocumentTable } = await vi.importActual(
    "@/features/knowledge-admin/components/KnowledgeDocumentTable",
  )

  const { container } = render(
    <KnowledgeDocumentTable
      documents={[
        {
          current_version: {
            file_name: "guide-v1.md",
          },
          doc_key: "guide",
          latest_version: 1,
          status: "active",
          title: "guide.md",
        },
      ]}
      onDeleteDocument={vi.fn()}
      onPageChange={vi.fn()}
      onPageSizeChange={vi.fn()}
      page={1}
      pageSize={10}
      total={25}
    />,
  )

  expect(container.querySelector(".ant-table")).toBeInTheDocument()
  expect(container.querySelector(".ant-pagination")).toBeInTheDocument()
})
