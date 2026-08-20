import * as React from "react"
import { render } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { expect, test } from "vitest"

import { TurbineSpinner } from "./TurbineSpinner"

test("renders a rotor group that the stylesheet animates", () => {
  const { container } = render(<TurbineSpinner />)

  const rotor = container.querySelector(".turbine-spinner__rotor")
  expect(rotor).not.toBeNull()
})

test("stays decorative when no title is given", () => {
  const { container } = render(<TurbineSpinner title="" />)

  const svg = container.querySelector("svg")
  expect(svg?.getAttribute("aria-hidden")).toBe("true")
  expect(svg?.getAttribute("role")).toBeNull()
})

// 批次 1 的彩蛋纪律②：一切动效受 prefers-reduced-motion 约束。
test("the spin animation is disabled under prefers-reduced-motion", () => {
  const css = readFileSync(join(resolve(process.cwd(), "src"), "index.css"), "utf-8")

  const reducedBlocks = css.split("@media (prefers-reduced-motion: reduce)").slice(1)
  const guardsRotor = reducedBlocks.some((block) =>
    /\.turbine-spinner__rotor\s*\{[^}]*animation:\s*none/.test(block),
  )

  expect(guardsRotor).toBe(true)
})
