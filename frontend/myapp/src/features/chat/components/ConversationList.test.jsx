import * as React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { ConversationList } from "./ConversationList"

test("lists conversations and supports create rename delete", () => {
  const onCreate = vi.fn()
  const onSelect = vi.fn()
  const onRename = vi.fn()
  const onDelete = vi.fn()
  vi.spyOn(window, "prompt").mockReturnValue("叶片A")
  vi.spyOn(window, "confirm").mockReturnValue(true)

  render(
    <ConversationList
      activeId={2}
      items={[
        { id: 1, title: "历史对话", task_id: null },
        { id: 2, title: "任务对话", task_id: 7 },
      ]}
      onCreate={onCreate}
      onDelete={onDelete}
      onRename={onRename}
      onSelect={onSelect}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "新建" }))
  expect(onCreate).toHaveBeenCalled()
  fireEvent.click(screen.getByText("历史对话"))
  expect(onSelect).toHaveBeenCalledWith({ id: 1, title: "历史对话", task_id: null })
  fireEvent.click(screen.getByRole("button", { name: "重命名 任务对话" }))
  expect(onRename).toHaveBeenCalledWith(2, "叶片A")
  fireEvent.click(screen.getByRole("button", { name: "删除 历史对话" }))
  expect(onDelete).toHaveBeenCalledWith(1)
})
