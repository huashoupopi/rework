import * as React from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

import { TaskImagePreview } from "./TaskImagePreview"

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

const strokeRectMock = vi.fn()
const fillRectMock = vi.fn()
const fillTextMock = vi.fn()
const clearRectMock = vi.fn()
const scaleMock = vi.fn()
const setTransformMock = vi.fn()
const measureTextMock = vi.fn(() => ({ width: 72 }))
const drawContext = {
  clearRect: clearRectMock,
  fillRect: fillRectMock,
  fillStyle: "",
  fillText: fillTextMock,
  font: "",
  measureText: measureTextMock,
  scale: scaleMock,
  setTransform: setTransformMock,
  strokeRect: strokeRectMock,
  strokeStyle: "",
  lineWidth: 1,
}

const OriginalImage = globalThis.Image

class MockImage {
  constructor() {
    this._src = ""
    this.naturalHeight = 640
    this.naturalWidth = 960
    this.onload = null
    this.onerror = null
  }

  set src(value) {
    this._src = value
    queueMicrotask(() => {
      this.onload?.()
    })
  }

  get src() {
    return this._src
  }
}

beforeEach(() => {
  strokeRectMock.mockClear()
  fillRectMock.mockClear()
  fillTextMock.mockClear()
  clearRectMock.mockClear()
  scaleMock.mockClear()
  setTransformMock.mockClear()
  measureTextMock.mockClear()

  globalThis.Image = MockImage

  httpGetMock.mockReset()
  httpGetMock.mockResolvedValue({ data: new Blob(["fake-image"], { type: "image/png" }) })
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock-preview")
  globalThis.URL.revokeObjectURL = vi.fn()

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => drawContext),
  })
})

afterEach(() => {
  globalThis.Image = OriginalImage
})

test("renders the original image and draws boxes for completed tasks", async () => {
  render(
    <TaskImagePreview
      task={{
        detect_result: {
          objects: [{ box: [120, 120, 60, 60], class: "crack", confidence: 0.98 }],
        },
        file_name: "blade.png",
        id: 56,
        original_path: "static/uploads/blade.png",
        status: "completed",
      }}
    />,
  )

  // 必须走鉴权接口，不能回退成直连 /static（那条路已被后端 404）
  expect(httpGetMock).toHaveBeenCalledWith("/tasks/56/image?kind=original", {
    responseType: "blob",
  })

  expect(await screen.findByRole("img", { name: "blade.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByLabelText("检测标框画布")).toBeInTheDocument()

  await waitFor(() => {
    expect(strokeRectMock).toHaveBeenCalled()
  })
})

test("shows the original image with a processing hint and no canvas while running", async () => {
  render(
    <TaskImagePreview
      task={{
        file_name: "processing.png",
        id: 57,
        original_path: "static/uploads/processing.png",
        status: "progressing",
      }}
    />,
  )

  expect(await screen.findByRole("img", { name: "processing.png 原图预览" })).toBeInTheDocument()
  expect(screen.getByText("正在检测中，结果生成后会自动刷新。")).toBeInTheDocument()
  expect(screen.queryByLabelText("检测标框画布")).not.toBeInTheDocument()
  expect(strokeRectMock).not.toHaveBeenCalled()
})

test("shows an empty state when the task has no preview image", () => {
  render(
    <TaskImagePreview
      task={{
        file_name: "missing.png",
        status: "failed",
      }}
    />,
  )

  expect(screen.getByText("原始图片不可用")).toBeInTheDocument()
  expect(screen.queryByRole("img", { name: "missing.png 原图预览" })).not.toBeInTheDocument()
})
