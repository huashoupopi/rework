import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { ConversationList } from "./ConversationList"

function renderList(handlers = {}) {
  const props = {
    onCreate: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(),
    onSelect: vi.fn(),
    ...handlers,
  }

  render(
    <ConversationList
      activeId={2}
      items={[
        { id: 1, title: "历史对话", task_id: null },
        { id: 2, title: "任务对话", task_id: 7 },
      ]}
      {...props}
    />,
  )

  return props
}

test("creates and selects conversations", () => {
  const { onCreate, onSelect } = renderList()

  fireEvent.click(screen.getByRole("button", { name: "新建" }))
  expect(onCreate).toHaveBeenCalled()

  fireEvent.click(screen.getByText("历史对话"))
  expect(onSelect).toHaveBeenCalledWith({ id: 1, title: "历史对话", task_id: null })
})

test("renames inline and commits on Enter", () => {
  const { onRename } = renderList()

  fireEvent.click(screen.getByRole("button", { name: "重命名 任务对话" }))

  const input = screen.getByRole("textbox", { name: "会话标题 任务对话" })
  fireEvent.change(input, { target: { value: "叶片A" } })
  fireEvent.keyDown(input, { key: "Enter" })

  expect(onRename).toHaveBeenCalledWith(2, "叶片A")
})

test("Escape cancels the rename without calling back", () => {
  const { onRename } = renderList()

  fireEvent.click(screen.getByRole("button", { name: "重命名 任务对话" }))
  const input = screen.getByRole("textbox", { name: "会话标题 任务对话" })
  fireEvent.change(input, { target: { value: "不该保存" } })
  fireEvent.keyDown(input, { key: "Escape" })

  expect(onRename).not.toHaveBeenCalled()
  expect(screen.getByText("任务对话")).toBeInTheDocument()
})

test("delete asks for confirmation first, then calls back", async () => {
  const { onDelete } = renderList()

  fireEvent.click(screen.getByRole("button", { name: "删除 历史对话" }))
  // 点一下不该直接删 —— 必须先出确认
  expect(onDelete).not.toHaveBeenCalled()

  // antd 会给两字中文按钮插空格（渲染为「删 除」）；用 ^$ 锚定，
  // 否则会连图标按钮的「删除 历史对话」一起命中
  const confirm = await screen.findByRole("button", { name: /^删\s*除$/ })
  fireEvent.click(confirm)

  await waitFor(() => {
    expect(onDelete).toHaveBeenCalledWith(1)
  })
})

// 回归钉：原生对话框会阻塞整个 JS 主线程（自动化实测点删除后页面完全无响应），
// 且与深色玻璃设计不搭。确认与输入必须走应用内 UI。
test("never uses native prompt or confirm", () => {
  const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("x")
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true)

  const { onDelete } = renderList()

  fireEvent.click(screen.getByRole("button", { name: "重命名 任务对话" }))
  fireEvent.click(screen.getByRole("button", { name: "删除 历史对话" }))

  expect(promptSpy).not.toHaveBeenCalled()
  expect(confirmSpy).not.toHaveBeenCalled()
  expect(onDelete).not.toHaveBeenCalled()

  promptSpy.mockRestore()
  confirmSpy.mockRestore()
})
