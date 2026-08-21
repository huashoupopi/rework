import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { BackgroundPaths } from "./BackgroundPaths"
import { WindTurbineSvg } from "./WindTurbineSvg"

// 2026-08-21 缩表：这个文件原本还测 DotPattern / InteractiveHoverButton /
// Ripple / SlidingNumber / TextShimmerWave 五个 magicui 门面组件。
// 「工程蓝图」改版把 magicui 的 30 个调用点全部拆掉之后，那批组件在业务代码里
// 零引用，整个 src/shared/ui/magicui 目录已删 —— 测试跟着删，
// 否则就是绿灯只保护死代码（这个坑本项目在 CI 上栽过一次）。

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
