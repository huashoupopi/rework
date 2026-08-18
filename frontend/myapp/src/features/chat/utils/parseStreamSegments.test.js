import { expect, test } from "vitest"

const { parseStreamSegments } = await import("./parseStreamSegments")

test("keeps plain assistant text unchanged", () => {
  expect(parseStreamSegments("这是普通回答")).toEqual({
    content: "这是普通回答",
    sources: [],
    think: "",
  })
})

test("extracts think markers without leaking them into visible content", () => {
  expect(parseStreamSegments("结论<<<THINK_START>>>中间推理<<<THINK_END>>>补充")).toEqual({
    content: "结论补充",
    sources: [],
    think: "中间推理",
  })
})

test("extracts json sources without leaking the source block into visible content", () => {
  expect(
    parseStreamSegments(
      '回答正文\n<<<SOURCES>>>[{"title":"文档 A","score":0.91}]<<<SOURCES_END>>>',
    ),
  ).toEqual({
    content: "回答正文",
    sources: [
      {
        score: 0.91,
        title: "文档 A",
      },
    ],
    think: "",
  })
})

test("streams partial think content and hides incomplete sources during streaming", () => {
  expect(parseStreamSegments("回答<<<THINK_START>>>推理中")).toEqual({
    content: "回答",
    sources: [],
    think: "推理中",
  })

  expect(parseStreamSegments("回答<<<SOUR")).toEqual({
    content: "回答",
    sources: [],
    think: "",
  })
})

test("extracts leaked thinking-process text without a closing think tag", () => {
  expect(
    parseStreamSegments("助手回答: Thinking Process:\n1. 分析请求\n2. 组织答案"),
  ).toEqual({
    content: "",
    sources: [],
    think: "1. 分析请求\n2. 组织答案",
  })
})
