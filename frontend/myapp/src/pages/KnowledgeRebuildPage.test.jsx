import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const refreshMock = vi.fn()
const triggerFullRebuildMock = vi.fn()
const triggerIncrementalRebuildMock = vi.fn()

vi.mock("@/features/knowledge-admin/hooks/useKnowledgeStatus", () => ({
  useKnowledgeStatus: () => ({
    actionLoading: false,
    actionMessage: "当前无运行中的重建任务",
    error: null,
    loading: false,
    refresh: refreshMock,
    status: {
      documents: [
        {
          doc_key: "guide",
          index_status: "indexed",
          title: "guide.md",
        },
      ],
      failed: 0,
      indexed: 1,
      pending: 0,
      rebuild_running: false,
      total_documents: 1,
    },
    triggerFullRebuild: triggerFullRebuildMock,
    triggerIncrementalRebuild: triggerIncrementalRebuildMock,
  }),
}))

const { KnowledgeRebuildPage } = await import("./KnowledgeRebuildPage")

afterEach(() => {
  refreshMock.mockReset()
  triggerFullRebuildMock.mockReset()
  triggerIncrementalRebuildMock.mockReset()
})

test("renders rebuild summary and document status", () => {
  render(<KnowledgeRebuildPage />)

  expect(screen.getByRole("heading", { name: "知识库重建" })).toBeInTheDocument()
  expect(screen.getByText("索引维护")).toBeInTheDocument()
  expect(screen.getByText("查看索引状态，触发全量或增量重建。")).toBeInTheDocument()
  expect(screen.getByText("已索引")).toBeInTheDocument()
  expect(screen.getByText("guide.md")).toBeInTheDocument()
  expect(screen.getByText("indexed")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "全量重建" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "增量重建" })).toBeInTheDocument()
})

test("forwards refresh and rebuild actions", async () => {
  triggerFullRebuildMock.mockResolvedValueOnce({
    success: true,
  })
  triggerIncrementalRebuildMock.mockResolvedValueOnce({
    success: true,
  })

  render(<KnowledgeRebuildPage />)

  fireEvent.click(screen.getByRole("button", { name: "刷新状态" }))
  fireEvent.click(screen.getByRole("button", { name: "全量重建" }))
  fireEvent.click(screen.getByRole("button", { name: "增量重建" }))

  expect(refreshMock).toHaveBeenCalledTimes(1)
  await waitFor(() => {
    expect(triggerFullRebuildMock).toHaveBeenCalledTimes(1)
  })
  await waitFor(() => {
    expect(triggerIncrementalRebuildMock).toHaveBeenCalledTimes(1)
  })
})

test("renders the real status summary as Antd metric cards", async () => {
  const { KnowledgeStatusSummary } = await vi.importActual(
    "@/features/knowledge-admin/components/KnowledgeStatusSummary",
  )

  const { container } = render(
    <KnowledgeStatusSummary
      actionLoading={false}
      actionMessage="当前无运行中的重建任务"
      loading={false}
      onRefresh={vi.fn()}
      onTriggerFull={vi.fn()}
      onTriggerIncremental={vi.fn()}
      status={{
        documents: [
          {
            doc_key: "guide",
            index_status: "indexed",
            title: "guide.md",
          },
        ],
        failed: 0,
        indexed: 1,
        pending: 0,
        rebuild_running: false,
        total_documents: 1,
      }}
    />,
  )

  expect(container.querySelectorAll(".ant-statistic")).toHaveLength(5)
  expect(container.querySelector(".ant-list")).toBeInTheDocument()
})
