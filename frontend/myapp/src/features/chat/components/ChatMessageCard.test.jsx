import * as React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { expect, test } from "vitest"

import { ChatMessageCard } from "./ChatMessageCard"

test("renders collapsible think and source panels for assistant messages", () => {
  render(
    <ChatMessageCard
      message={{
        content: "这是回答",
        id: 1,
        meta: {
          sources: [{ title: "知识库文档" }],
          think: "先分析任务上下文，再判断缺陷风险。",
        },
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  expect(screen.getByText("这是回答")).toBeInTheDocument()

  // thinking panel — collapsed by default
  const thinkTrigger = screen.getByText("思考过程")
  expect(thinkTrigger).toBeInTheDocument()
  expect(screen.queryByText("先分析任务上下文，再判断缺陷风险。")).not.toBeInTheDocument()

  // expand thinking
  fireEvent.click(thinkTrigger.closest("button"))
  expect(screen.getByText("先分析任务上下文，再判断缺陷风险。")).toBeInTheDocument()

  // sources panel — collapsed by default
  const sourcesTrigger = screen.getByText("参考文献 (1)")
  expect(sourcesTrigger).toBeInTheDocument()
  expect(screen.queryByText("知识库文档")).not.toBeInTheDocument()

  // expand sources
  fireEvent.click(sourcesTrigger.closest("button"))
  expect(screen.getByText("知识库文档")).toBeInTheDocument()
})

test("renders the thinking panel before the final answer content", () => {
  render(
    <ChatMessageCard
      message={{
        content: "这是回答",
        id: 11,
        meta: {
          think: "先分析，再给结论。",
        },
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  const article = screen.getByLabelText("助手消息")
  const thinkPanel = screen.getByText("思考过程").closest(".collapsible-panel")
  const content = article.querySelector(".message-card__content")

  expect(thinkPanel).toBeTruthy()
  expect(content).toBeTruthy()
  expect(Array.from(article.children)[1]).toBe(thinkPanel)
  expect(Array.from(article.children)[2]).toBe(content)
})

test("extracts and hides think blocks from content with Thinking Process: pattern", () => {
  const contentWithThink =
    "助手回答: Thinking Process:\n分析请求内容\n</think>\n\n这是实际回答"

  render(
    <ChatMessageCard
      message={{
        content: contentWithThink,
        id: 2,
        meta: {},
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  // Think content should NOT appear in main content
  expect(screen.queryByText(/分析请求内容/)).not.toBeInTheDocument()
  // Response should appear
  expect(screen.getByText("这是实际回答")).toBeInTheDocument()
  // Think panel should exist
  expect(screen.getByText("思考过程")).toBeInTheDocument()

  // Expand and verify think content
  fireEvent.click(screen.getByText("思考过程").closest("button"))
  expect(screen.getByText("分析请求内容")).toBeInTheDocument()
})

test("handles multi-turn content with multiple think blocks", () => {
  const multiTurnContent = [
    "助手回答: Thinking Process:\n第一轮思考\n</think>\n\n第一轮回答",
    "=============",
    "用户问题: 继续分析",
    "助手回答: Thinking Process:\n第二轮思考\n</think>\n\n第二轮回答",
  ].join("\n")

  render(
    <ChatMessageCard
      message={{
        content: multiTurnContent,
        id: 3,
        meta: {},
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  // Neither think block should appear in main content
  expect(screen.queryByText(/第一轮思考/)).not.toBeInTheDocument()
  expect(screen.queryByText(/第二轮思考/)).not.toBeInTheDocument()
  // Responses should appear
  expect(screen.getByText(/第一轮回答/)).toBeInTheDocument()
  expect(screen.getByText(/第二轮回答/)).toBeInTheDocument()

  // Expand think panel — both think blocks should be there
  fireEvent.click(screen.getByText("思考过程").closest("button"))
  expect(screen.getByText(/第一轮思考/)).toBeInTheDocument()
  expect(screen.getByText(/第二轮思考/)).toBeInTheDocument()
})

test("cleans think blocks from content even when meta.think exists", () => {
  const contentWithResidual =
    "Thinking Process:\n残留思考\n</think>\n\n干净的回答"

  render(
    <ChatMessageCard
      message={{
        content: contentWithResidual,
        id: 4,
        meta: { think: "服务器端思考内容" },
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  // meta.think takes priority for display
  expect(screen.getByText("思考过程")).toBeInTheDocument()
  fireEvent.click(screen.getByText("思考过程").closest("button"))
  expect(screen.getByText("服务器端思考内容")).toBeInTheDocument()

  // Residual think should be cleaned from content
  expect(screen.queryByText(/残留思考/)).not.toBeInTheDocument()
  expect(screen.getByText("干净的回答")).toBeInTheDocument()
})

test("moves leaked thinking-process text into the collapsible panel even without a closing tag", () => {
  render(
    <ChatMessageCard
      message={{
        content: "助手回答: Thinking Process:\n1. 分析请求\n2. 组织答案",
        id: 5,
        meta: {},
        role: "assistant",
        status: "complete",
      }}
    />,
  )

  expect(screen.queryByText(/Thinking Process/)).not.toBeInTheDocument()
  expect(screen.getByText("思考过程")).toBeInTheDocument()

  fireEvent.click(screen.getByText("思考过程").closest("button"))
  expect(screen.getByText(/1\. 分析请求[\s\S]*2\. 组织答案/)).toBeInTheDocument()
})
