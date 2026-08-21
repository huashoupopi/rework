import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const getTaskDetailMock = vi.fn()
const downloadTaskImageMock = vi.fn()
const exportTaskMock = vi.fn()

vi.mock("@/features/task-center/api/task-api", () => ({
  downloadTaskImage: (...args) => downloadTaskImageMock(...args),
  exportTask: (...args) => exportTaskMock(...args),
  getTaskDetail: (...args) => getTaskDetailMock(...args),
}))

// TaskImagePreview 内部走鉴权接口取原图 Blob（批次 2 关了 /static 匿名访问）。
// 只替换 http.get，其余导出（downloadFile / extractErrorMessage）保留真实实现。
const httpGetMock = vi.fn()
vi.mock("@/shared/api/http", async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    http: { ...actual.http, get: (...args) => httpGetMock(...args) },
  }
})

const { TaskDetailPage } = await import("./TaskDetailPage")

beforeEach(() => {
  httpGetMock.mockReset()
  httpGetMock.mockResolvedValue({ data: new Blob(["fake-image"], { type: "image/png" }) })
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-preview")
  globalThis.URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  getTaskDetailMock.mockReset()
  downloadTaskImageMock.mockReset()
  exportTaskMock.mockReset()
})

function renderTaskDetailPage(initialEntry = "/tasks/7") {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<TaskDetailPage />} path="/tasks/:taskId" />
      </Routes>
    </MemoryRouter>,
  )
}

test("loads task detail from the route param and renders the completed summary", async () => {
  getTaskDetailMock.mockResolvedValueOnce({
    created_at: "2026-03-21T08:00:00.000Z",
    detect_result: {
      objects: [
        {
          box: [10, 20, 30, 40],
          class: "crack",
          confidence: 0.98,
        },
      ],
      total: 3,
    },
    file_name: "demo.png",
    id: 7,
    original_path: "static/uploads/demo.png",
    status: "completed",
  })
  downloadTaskImageMock.mockResolvedValueOnce({})

  renderTaskDetailPage()

  expect(await screen.findByRole("heading", { name: "任务详情" })).toBeInTheDocument()
  expect(screen.getAllByText("任务 #7").length).toBeGreaterThanOrEqual(1)

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledWith(7)
  })

  // 2026-08-21 结果摘要重做：原本并排「发现 3 处目标」与「对象 1 个」两句话，
  // 说的是同一件事却给出两个数。现在只报明细条数，两者对不上时单独提示 ——
  // 这份 mock 恰好就是 total=3 / objects=1 的不一致数据，正好覆盖那条路径。
  expect(screen.getByText("处缺陷")).toBeInTheDocument()
  expect(screen.getByText("模型报告 3 处，结构化明细 1 条")).toBeInTheDocument()
  expect(screen.getByText(/crack/)).toBeInTheDocument()
  // 置信度从原始浮点 0.98 换成百分数
  expect(screen.getByText("98%")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /关联问答/ })).toHaveAttribute("href", "/chat?taskId=7")
  expect(await screen.findByRole("img", { name: "demo.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByLabelText("检测标框画布")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "下载单张" }))
  fireEvent.click(screen.getByRole("button", { name: "导出 JSON" }))
  fireEvent.click(screen.getByRole("button", { name: "导出 CSV" }))

  await waitFor(() => {
    expect(downloadTaskImageMock).toHaveBeenCalledWith(7)
  })
  expect(exportTaskMock).toHaveBeenCalledWith(7, "json")
  expect(exportTaskMock).toHaveBeenCalledWith(7, "csv")
})

test("shows the failed state without exposing the download action", async () => {
  getTaskDetailMock.mockResolvedValueOnce({
    detect_result: null,
    file_name: "failed.png",
    id: 7,
    original_path: "static/uploads/failed.png",
    status: "failed",
  })

  renderTaskDetailPage()

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledWith(7)
  })

  expect(screen.getByRole("alert")).toHaveTextContent("任务处理失败")
  expect(screen.getAllByText("任务 #7").length).toBeGreaterThanOrEqual(1)
  expect(screen.queryByRole("button", { name: "下载单张" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "导出 JSON" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "导出 CSV" })).not.toBeInTheDocument()
  expect(await screen.findByRole("img", { name: "failed.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByText("检测失败，请检查原始图片或稍后重试。")).toBeInTheDocument()
})

function NavigateButton() {
  const navigate = useNavigate()

  return (
    <button type="button" onClick={() => navigate("/tasks/8")}>
      跳到任务 8
    </button>
  )
}

test("hides the previous task immediately when the route changes", async () => {
  let resolveNextTask
  const nextTaskPromise = new Promise((resolve) => {
    resolveNextTask = resolve
  })

  getTaskDetailMock
    .mockResolvedValueOnce({
      created_at: "2026-03-21T08:00:00.000Z",
      detect_result: {
        objects: [],
        total: 3,
      },
      id: 7,
      original_path: "static/uploads/task-7.png",
      status: "completed",
    })
    .mockImplementationOnce(() => nextTaskPromise)

  render(
    <MemoryRouter initialEntries={["/tasks/7"]}>
      <Routes>
        <Route
          element={
            <>
              <NavigateButton />
              <TaskDetailPage />
            </>
          }
          path="/tasks/:taskId"
        />
      </Routes>
    </MemoryRouter>,
  )

  expect(await screen.findByText("模型报告 3 处，结构化明细 0 条")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "跳到任务 8" }))

  expect(screen.queryByText("模型报告 3 处，结构化明细 0 条")).not.toBeInTheDocument()

  resolveNextTask({
    detect_result: null,
    file_name: "task-8.png",
    id: 8,
    original_path: "static/uploads/task-8.png",
    status: "failed",
  })

  expect(await screen.findByRole("alert")).toHaveTextContent("任务处理失败")
})

test("shows the original image with a processing hint before detection completes", async () => {
  getTaskDetailMock.mockResolvedValueOnce({
    created_at: "2026-03-21T08:00:00.000Z",
    detect_result: null,
    file_name: "queue.png",
    id: 7,
    original_path: "static/uploads/queue.png",
    status: "progressing",
  })

  renderTaskDetailPage()

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledWith(7)
  })

  expect(await screen.findByRole("img", { name: "queue.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByText("正在检测中，结果生成后会自动刷新。")).toBeInTheDocument()
  expect(screen.queryByLabelText("检测标框画布")).not.toBeInTheDocument()
})
