import * as React from "react"
import { render } from "@testing-library/react"
import { expect, test } from "vitest"

import { ChatMessageCard } from "./ChatMessageCard"

// 「生成中」用自家风机，不用通用转圈。复用 WindTurbineSvg（彩蛋同款），
// 转停与 prefers-reduced-motion 由 .wind-turbine-svg 既有契约管，这里不另起一套。
test("streaming badge shows the wind turbine, not a generic spinner", () => {
  const { container } = render(
    <ChatMessageCard message={{ content: "", role: "assistant", status: "streaming" }} />,
  )

  const turbine = container.querySelector(".message-card__badge .wind-turbine-svg")
  expect(turbine).not.toBeNull()
  expect(turbine?.getAttribute("data-spinning")).toBe("true")
})

test("the badge turbine is decorative", () => {
  const { container } = render(
    <ChatMessageCard message={{ content: "", role: "assistant", status: "streaming" }} />,
  )

  const turbine = container.querySelector(".message-card__badge .wind-turbine-svg")
  expect(turbine?.getAttribute("aria-hidden")).toBe("true")
})
