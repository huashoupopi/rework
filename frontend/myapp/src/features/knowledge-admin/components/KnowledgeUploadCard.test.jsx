import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const onUploadMock = vi.fn()

const { KnowledgeUploadCard } = await import("./KnowledgeUploadCard")

afterEach(() => {
  onUploadMock.mockReset()
})

test("submits a single selected file and clears the picker after success", async () => {
  onUploadMock.mockResolvedValueOnce({
    created: true,
  })

  render(<KnowledgeUploadCard onUpload={onUploadMock} />)

  const input = screen.getByLabelText("上传知识库文档")
  const file = new File(["content"], "guide.md", {
    type: "text/markdown",
  })

  fireEvent.change(input, {
    target: {
      files: [file],
    },
  })

  fireEvent.click(screen.getByRole("button", { name: "上传文档" }))

  await waitFor(() => {
    expect(onUploadMock).toHaveBeenCalledWith(file)
  })

  await waitFor(() => {
    expect(screen.queryByText("待上传文件: guide.md")).not.toBeInTheDocument()
  })
  expect(screen.getByRole("button", { name: "上传文档" })).toBeDisabled()
})

test("shows the upload error when the request fails", async () => {
  onUploadMock.mockRejectedValueOnce(new Error("上传失败"))

  render(<KnowledgeUploadCard onUpload={onUploadMock} />)

  fireEvent.change(screen.getByLabelText("上传知识库文档"), {
    target: {
      files: [
        new File(["content"], "guide.md", {
          type: "text/markdown",
        }),
      ],
    },
  })

  fireEvent.click(screen.getByRole("button", { name: "上传文档" }))

  expect(await screen.findByRole("alert")).toHaveTextContent("上传失败")
})
