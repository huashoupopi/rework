import * as React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const uploadTasksMock = vi.fn()

vi.mock("../api/task-api", () => ({
  uploadTasks: (...args) => uploadTasksMock(...args),
}))

const { TaskUploadCard } = await import("./TaskUploadCard")

afterEach(() => {
  uploadTasksMock.mockReset()
})

test("uploads a selected file and refreshes after success", async () => {
  uploadTasksMock.mockResolvedValueOnce([
    {
      id: 1,
      file_name: "demo.png",
    },
  ])
  const onUploaded = vi.fn()

  render(<TaskUploadCard onUploaded={onUploaded} />)

  expect(screen.getByText("上传检测")).toBeInTheDocument()
  expect(screen.getByText("上传待检测图片")).toBeInTheDocument()
  expect(screen.getByText("批量图片会拆成独立任务，自动进入检测队列。")).toBeInTheDocument()

  const file = new File(["demo"], "demo.png", { type: "image/png" })
  fireEvent.change(screen.getByLabelText("上传文件"), {
    target: {
      files: [file],
    },
  })
  fireEvent.click(screen.getByRole("button", { name: "上传任务" }))

  await waitFor(() => {
    expect(uploadTasksMock).toHaveBeenCalledWith([file])
  })

  await waitFor(() => {
    expect(onUploaded).toHaveBeenCalledTimes(1)
  })

  expect(screen.getByText("批量图片会拆成独立任务，自动进入检测队列。")).toBeInTheDocument()
  expect(screen.getByLabelText("上传文件")).toHaveValue("")
})
