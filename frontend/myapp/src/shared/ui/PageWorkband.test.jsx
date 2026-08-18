import * as React from "react"
import { render, screen } from "@testing-library/react"
import { test } from "vitest"

import { PageWorkband } from "./PageWorkband"

test("renders the workband with title, description, actions, aside, and footer", () => {
  render(
    <PageWorkband
      actions={<button type="button">上传任务</button>}
      aside={<div>当前成员 2 人</div>}
      description="管理当前页面的关键动作和状态。"
      eyebrow="任务工作区"
      footer={<div>底部承接内容</div>}
      title="任务中心"
    />,
  )

  expect(screen.getByText("任务工作区")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "任务中心" })).toBeInTheDocument()
  expect(screen.getByText("管理当前页面的关键动作和状态。")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "上传任务" })).toBeInTheDocument()
  expect(screen.getByText("当前成员 2 人")).toBeInTheDocument()
  expect(screen.getByText("底部承接内容")).toBeInTheDocument()
})
