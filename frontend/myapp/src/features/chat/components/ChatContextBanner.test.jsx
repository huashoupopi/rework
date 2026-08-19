import * as React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { ChatContextBanner } from "./ChatContextBanner"

test("renders defect classes and counts plus preset questions", () => {
  const onAsk = vi.fn()
  render(
    <ChatContextBanner
      onAsk={onAsk}
      taskId={7}
      task={{
        detect_result: {
          objects: [{ class: "craze" }, { class: "craze" }, { class: "corrosion" }],
          total: 3,
        },
      }}
    />,
  )

  expect(screen.getByRole("heading", { name: "当前任务缺陷摘要" })).toBeInTheDocument()
  expect(screen.getByText("裂纹 2")).toBeInTheDocument()
  expect(screen.getByText("腐蚀 1")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "裂纹怎么修?" }))
  expect(onAsk).toHaveBeenCalledWith("裂纹怎么修?")
})

test("keeps generic banner without task context", () => {
  render(<ChatContextBanner />)
  expect(screen.getByText("通用对话")).toBeInTheDocument()
  expect(screen.queryByRole("heading", { name: "当前任务缺陷摘要" })).not.toBeInTheDocument()
})
