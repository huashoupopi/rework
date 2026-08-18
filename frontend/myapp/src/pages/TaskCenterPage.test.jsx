import * as React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const refreshMock = vi.fn()
const setPageMock = vi.fn()
const setPageSizeMock = vi.fn()

vi.mock("@/features/task-center/hooks/useTaskList", () => ({
  useTaskList: () => ({
    error: null,
    loading: false,
    page: 2,
    pageSize: 10,
    refresh: refreshMock,
    setPage: setPageMock,
    setPageSize: setPageSizeMock,
    tasks: [
      {
        id: 1,
        file_name: "demo.png",
        status: "completed",
        created_at: "2026-03-21T08:00:00.000Z",
        summary: "识别 3 个目标",
      },
      {
        id: 2,
        file_name: "beta.png",
        status: "progressing",
        created_at: "2026-03-21T08:05:00.000Z",
        summary: "处理中",
      },
      {
        id: 3,
        file_name: "report.png",
        status: "failed",
        created_at: "2026-03-21T08:10:00.000Z",
        summary: "失败",
      },
    ],
    total: 23,
  }),
}))

vi.mock("@/features/task-center/components/TaskUploadCard", () => ({
  TaskUploadCard: ({ onUploaded }) => (
    <button type="button" onClick={onUploaded}>
      模拟上传成功
    </button>
  ),
}))

vi.mock("@/features/task-center/components/TaskFilters", () => ({
  TaskFilters: ({ filters, onFiltersChange, onRefresh }) => (
    <section>
      <label>
        文件名关键词
        <input
          aria-label="文件名关键词"
          value={filters.fileName}
          onChange={(event) => onFiltersChange({ ...filters, fileName: event.target.value })}
        />
      </label>
      <label>
        状态
        <select
          aria-label="状态"
          value={filters.status}
          onChange={(event) => onFiltersChange({ ...filters, status: event.target.value })}
        >
          <option value="all">全部状态</option>
          <option value="completed">已完成</option>
          <option value="progressing">处理中</option>
          <option value="pending">待处理</option>
          <option value="failed">失败</option>
        </select>
      </label>
      <button type="button" onClick={onRefresh}>
        刷新按钮
      </button>
    </section>
  ),
}))

vi.mock("@/features/task-center/components/TaskTable", () => ({
  TaskTable: ({ tasks, page, pageSize, total, onPageChange, onPageSizeChange }) => (
    <div>
      <div>任务表格:{tasks.map((task) => task.file_name).join(",")}</div>
      <div>
        <span>
          {page}/{pageSize}/{total}
        </span>
      </div>
      <button type="button" onClick={() => onPageChange(page + 1)}>
        下一页入口
      </button>
      <button type="button" onClick={() => onPageSizeChange(20)}>
        切换每页条数
      </button>
    </div>
  ),
}))

const { TaskCenterPage } = await import("./TaskCenterPage")

afterEach(() => {
  refreshMock.mockReset()
  setPageMock.mockReset()
  setPageSizeMock.mockReset()
})

test("renders upload entry, filtering entry, and task table", () => {
  render(<TaskCenterPage />)

  expect(screen.getByRole("heading", { name: "任务中心" })).toBeInTheDocument()
  expect(screen.getByText("检测任务")).toBeInTheDocument()
  expect(screen.getByText("已加载 3 条任务，当前页完成 1 条。")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "刷新任务列表" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "刷新按钮" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "模拟上传成功" })).toBeInTheDocument()
  expect(screen.getByLabelText("文件名关键词")).toBeInTheDocument()
  expect(screen.getByLabelText("状态")).toBeInTheDocument()
  expect(screen.getByText("任务表格:demo.png,beta.png,report.png")).toBeInTheDocument()
})

test("refreshes the list after upload success", async () => {
  render(<TaskCenterPage />)

  fireEvent.click(screen.getByRole("button", { name: "模拟上传成功" }))

  await waitFor(() => {
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})

test("filters tasks locally and forwards pagination controls", () => {
  render(<TaskCenterPage />)

  fireEvent.change(screen.getByLabelText("文件名关键词"), {
    target: { value: "report" },
  })

  fireEvent.change(screen.getByLabelText("状态"), {
    target: { value: "failed" },
  })

  expect(screen.getByText("筛选结果：1 / 3")).toBeInTheDocument()
  expect(screen.getByText("任务表格:report.png")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "下一页入口" }))
  fireEvent.click(screen.getByRole("button", { name: "切换每页条数" }))

  expect(setPageMock).toHaveBeenCalledWith(3)
  expect(setPageMock).toHaveBeenCalledWith(1)
  expect(setPageSizeMock).toHaveBeenCalledWith(20)
})
