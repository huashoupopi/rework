import * as React from "react"
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const downloadTaskBatchMock = vi.fn()
const downloadTaskImageMock = vi.fn()
const setPageMock = vi.fn()
const setPageSizeMock = vi.fn()

vi.mock("../api/task-api", () => ({
  downloadTaskBatch: (...args) => downloadTaskBatchMock(...args),
  downloadTaskImage: (...args) => downloadTaskImageMock(...args),
}))

const { TaskTable } = await import("./TaskTable")

afterEach(() => {
  downloadTaskBatchMock.mockReset()
  downloadTaskImageMock.mockReset()
  setPageMock.mockReset()
  setPageSizeMock.mockReset()
})

test("renders task fields, detail entry, and gated download actions", async () => {
  const tasks = [
    {
      id: 1,
      detect_result: {
        objects: [
          { class: "craze" },
          { class: "craze" },
          { class: "corrosion" },
        ],
        total: 3,
      },
      file_name: "ready.png",
      status: "completed",
      created_at: "2026-03-21T08:00:00.000Z",
    },
    {
      id: 2,
      file_name: "running.png",
      status: "progressing",
      created_at: "2026-03-21T08:05:00.000Z",
    },
  ]

  render(
    <TaskTable
      onPageChange={setPageMock}
      onPageSizeChange={setPageSizeMock}
      page={1}
      pageSize={10}
      tasks={tasks}
      total={2}
    />,
  )

  expect(screen.getByText("任务列表")).toBeInTheDocument()
  expect(screen.getByText("检测任务总览")).toBeInTheDocument()
  expect(screen.getByText("已选 0 项")).toBeInTheDocument()
  expect(screen.getByText("ready.png")).toBeInTheDocument()
  expect(screen.getByText("running.png")).toBeInTheDocument()
  expect(screen.getByText("completed")).toBeInTheDocument()
  expect(screen.getByText("progressing")).toBeInTheDocument()
  expect(screen.getByText("裂纹 2")).toBeInTheDocument()
  expect(screen.getByText("腐蚀 1")).toBeInTheDocument()
  expect(screen.getAllByText("-")).toHaveLength(3)
  expect(screen.getAllByRole("link", { name: "查看详情" })).toHaveLength(2)

  const readyRow = screen.getByText("ready.png").closest("tr")
  const runningRow = screen.getByText("running.png").closest("tr")

  expect(within(readyRow).getByRole("button", { name: "下载单张" })).toBeEnabled()
  expect(within(runningRow).getByRole("button", { name: "下载单张" })).toBeDisabled()

  expect(screen.getByRole("button", { name: "批量下载" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled()
  expect(screen.getByLabelText("每页条数")).toHaveValue("10")

  fireEvent.click(within(readyRow).getByRole("checkbox"))

  await waitFor(() => {
    expect(screen.getByRole("button", { name: "批量下载" })).toBeEnabled()
  })

  expect(screen.getByText("已选 1 项")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "批量下载" }))

  await waitFor(() => {
    expect(downloadTaskBatchMock).toHaveBeenCalledWith([1])
  })

  fireEvent.click(within(readyRow).getByRole("button", { name: "下载单张" }))

  await waitFor(() => {
    expect(downloadTaskImageMock).toHaveBeenCalledWith(1)
  })
})

test("keeps batch download disabled when any selected task is not completed", async () => {
  const tasks = [
    {
      id: 1,
      detect_result: {
        total: 3,
      },
      file_name: "ready.png",
      status: "completed",
      created_at: "2026-03-21T08:00:00.000Z",
    },
    {
      id: 2,
      file_name: "pending.png",
      status: "pending",
      created_at: "2026-03-21T08:05:00.000Z",
    },
  ]

  render(
    <TaskTable
      onPageChange={setPageMock}
      onPageSizeChange={setPageSizeMock}
      page={1}
      pageSize={10}
      tasks={tasks}
      total={2}
    />,
  )

  fireEvent.click(screen.getByLabelText("选择 ready.png"))
  fireEvent.click(screen.getByLabelText("选择 pending.png"))

  expect(screen.getByRole("button", { name: "批量下载" })).toBeDisabled()
})

test("exposes pagination controls that update page and page size", () => {
  const tasks = [
    {
      id: 1,
      file_name: "ready.png",
      status: "completed",
      created_at: "2026-03-21T08:00:00.000Z",
    },
  ]

  render(
    <TaskTable
      onPageChange={setPageMock}
      onPageSizeChange={setPageSizeMock}
      page={2}
      pageSize={10}
      tasks={tasks}
      total={25}
    />,
  )

  expect(screen.getByRole("button", { name: "上一页" })).toBeEnabled()
  expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled()
  expect(screen.getByText("第 2 / 3 页")).toBeInTheDocument()
  expect(screen.getByText("任务列表")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "上一页" }))
  fireEvent.click(screen.getByRole("button", { name: "下一页" }))
  fireEvent.change(screen.getByLabelText("每页条数"), { target: { value: "20" } })

  expect(setPageMock).toHaveBeenCalledWith(1)
  expect(setPageMock).toHaveBeenCalledWith(3)
  expect(setPageSizeMock).toHaveBeenCalledWith(20)
})
