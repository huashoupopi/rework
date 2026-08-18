import * as React from "react"
import { render, screen } from "@testing-library/react"
import { test } from "vitest"

import { PageHeader } from "./PageHeader"

test("renders eyebrow, title, description, and actions", () => {
  render(
    <PageHeader
      actions={<button type="button">主操作</button>}
      description="用于管理检测任务与问答工作流。"
      eyebrow="任务工作台"
      title="任务中心"
    />,
  )

  expect(screen.getByText("任务工作台")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "任务中心" })).toBeInTheDocument()
  expect(screen.getByText("用于管理检测任务与问答工作流。")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "主操作" })).toBeInTheDocument()
})
