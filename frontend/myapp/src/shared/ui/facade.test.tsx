import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { DotPattern } from "./magicui/dot-pattern"
import { InteractiveHoverButton } from "./magicui/interactive-hover-button"
import { Ripple } from "./magicui/ripple"
import { SlidingNumber } from "./motion-primitives/sliding-number"
import { TextShimmerWave } from "./motion-primitives/text-shimmer-wave"
import { BackgroundPaths } from "./BackgroundPaths"
import { WindTurbineSvg } from "./WindTurbineSvg"

test("background paths and turbine svg render", () => {
  vi.stubGlobal("matchMedia", (query) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: String(query).includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  }))

  render(
    <>
      <BackgroundPaths />
      <WindTurbineSvg sign="停机检修中" stopped />
    </>,
  )

  expect(document.querySelector(".background-paths")).toBeInTheDocument()
  expect(screen.getByRole("img", { name: "停机检修中" })).toHaveAttribute("data-stopped", "true")
})

test("round 2R facade primitives render", () => {
  render(
    <>
      <div style={{ height: 80, position: "relative", width: 80 }}>
        <DotPattern />
        <Ripple numCircles={2} />
      </div>
      <InteractiveHoverButton>登录</InteractiveHoverButton>
    </>,
  )

  expect(document.querySelector(".animate-ripple, [class*='ripple']")).toBeTruthy()
  expect(screen.getByRole("button", { name: "登录" })).toBeInTheDocument()
})

test("round 3 motion primitives render", () => {
  render(
    <>
      <SlidingNumber value={12} />
      <TextShimmerWave>生成中</TextShimmerWave>
    </>,
  )

  expect(document.querySelector(".tabular-nums, [class*='tabular']") || document.body.textContent?.includes("1")).toBeTruthy()
  expect(screen.getByText((_, node) => node?.textContent === "生成中")).toBeInTheDocument()
})
