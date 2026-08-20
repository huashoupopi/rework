import * as React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const refreshMock = vi.fn()
const setPageMock = vi.fn()
const setPageSizeMock = vi.fn()
const setStatusMock = vi.fn()
const setFileNameMock = vi.fn()

vi.mock("@/features/task-center/hooks/useTaskList", () => ({
  useTaskList: () => ({
    error: null,
    fileName: "",
    loading: false,
    page: 2,
    pageSize: 10,
    refresh: refreshMock,
    setFileName: setFileNameMock,
    setPage: setPageMock,
    setPageSize: setPageSizeMock,
    setStatus: setStatusMock,
    status: "",
    statusCounts: { completed: 18, failed: 4, pending: 1 },
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
  // 描述用全库口径：total 与 statusCounts 都来自服务端，不再数当前页
  expect(screen.getByText("共 23 条任务，本页显示 3 条，全部已完成 18 条。")).toBeInTheDocument()
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

// 回归钉：筛选必须交给服务端。此前在前端对当前页做本地过滤 ——
// 实测第 2 页共 6 条，筛「失败」得 5、筛「已完成」得 1，5+1 正好是这一页全部，
// 说明根本没查全库；要找全某状态的任务得一页页翻着筛。
test("filters are pushed to the server, not applied locally", () => {
  render(<TaskCenterPage />)

  fireEvent.change(screen.getByLabelText("文件名关键词"), {
    target: { value: "report" },
  })
  expect(setFileNameMock).toHaveBeenCalledWith("report")

  fireEvent.change(screen.getByLabelText("状态"), {
    target: { value: "failed" },
  })
  expect(setStatusMock).toHaveBeenCalledWith("failed")

  // 表格渲染的是服务端返回的那一页，前端不再自己裁
  expect(screen.getByText("任务表格:demo.png,beta.png,report.png")).toBeInTheDocument()
})

test("forwards pagination controls", () => {
  render(<TaskCenterPage />)

  fireEvent.click(screen.getByRole("button", { name: "下一页入口" }))
  fireEvent.click(screen.getByRole("button", { name: "切换每页条数" }))

  expect(setPageMock).toHaveBeenCalledWith(3)
  expect(setPageMock).toHaveBeenCalledWith(1)
  expect(setPageSizeMock).toHaveBeenCalledWith(20)
})
