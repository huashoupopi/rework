import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const onSendMock = vi.fn()

const { ChatComposer } = await import("./ChatComposer")

afterEach(() => {
  onSendMock.mockReset()
})

test("submits text and selected images, then clears the form", async () => {
  onSendMock.mockResolvedValueOnce(undefined)

  render(<ChatComposer onSend={onSendMock} sending={false} />)

  expect(screen.getByPlaceholderText("输入你的问题...")).toBeInTheDocument()
  expect(screen.getByText("图片")).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText("输入问题"), {
    target: { value: "请分析这个任务" },
  })

  const file = new File(["image"], "sample.png", {
    type: "image/png",
  })
  fireEvent.change(screen.getByLabelText("上传图片"), {
    target: { files: [file] },
  })

  expect(screen.getByText("1 张")).toBeInTheDocument()

  fireEvent.click(screen.getByRole("button", { name: /发送/ }))

  await waitFor(() => {
    expect(onSendMock).toHaveBeenCalledWith({
      images: [file],
      question: "请分析这个任务",
    })
  })

  await waitFor(() => {
    expect(screen.getByLabelText("输入问题")).toHaveValue("")
    expect(screen.getByLabelText("上传图片")).toHaveValue("")
  })
})

test("disables repeated submit while sending", () => {
  const onStopMock = vi.fn()

  render(<ChatComposer onSend={onSendMock} onStop={onStopMock} sending />)

  const stopButton = screen.getByRole("button", { name: /终止/ })

  expect(stopButton).toBeInTheDocument()
  expect(stopButton).not.toBeDisabled()
  expect(screen.getByLabelText("输入问题")).toBeDisabled()
})
