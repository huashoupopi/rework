import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"

const getTaskDetailMock = vi.fn()
const downloadTaskImageMock = vi.fn()
const exportTaskMock = vi.fn()

vi.mock("@/features/task-center/api/task-api", () => ({
  downloadTaskImage: (...args) => downloadTaskImageMock(...args),
  exportTask: (...args) => exportTaskMock(...args),
  getTaskDetail: (...args) => getTaskDetailMock(...args),
}))

const { TaskDetailPage } = await import("./TaskDetailPage")

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

  expect(screen.getByText("发现 3 处目标")).toBeInTheDocument()
  expect(screen.getByText(/crack/)).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /关联问答/ })).toHaveAttribute("href", "/chat?taskId=7")
  expect(screen.getByRole("img", { name: "demo.png 原图预览" })).toBeInTheDocument()
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
  expect(screen.getByRole("img", { name: "failed.png 原图预览" })).toBeInTheDocument()
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

  expect(await screen.findByText("发现 3 处目标")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: "跳到任务 8" }))

  expect(screen.queryByText("发现 3 处目标")).not.toBeInTheDocument()

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

  expect(screen.getByRole("img", { name: "queue.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByText("正在检测中，结果生成后会自动刷新。")).toBeInTheDocument()
  expect(screen.queryByLabelText("检测标框画布")).not.toBeInTheDocument()
})
