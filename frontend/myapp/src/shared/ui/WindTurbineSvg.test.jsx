import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { render } from "@testing-library/react"
import * as React from "react"
import { expect, test } from "vitest"

import { WindTurbineSvg } from "./WindTurbineSvg"

// 只取真正的声明行 —— 注释里为了解释成因也会出现 "fill-box"
function turbineDeclarations() {
  const css = readFileSync(join(resolve(process.cwd(), "src"), "index.css"), "utf-8")
  const start = css.indexOf(".wind-turbine-svg__blades {")
  const block = css.slice(start, css.indexOf("}", start) + 1)

  return block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(":"))
    .join("\n")
}

// 回归钉：叶片必须绕轮毂 (60,75) 转。
// transform-box:fill-box 会让 origin 从叶片组自身 bbox 左上角 (8,14) 起算，
// "60 75" 落到 (68,89)，偏心 8×14 —— 实测叶尖到轮毂的距离在
// [30.5, 52.8, 60.6, 42.6] 之间摆动（波动 30.1px），肉眼就是上下晃。
test("blades rotate around the hub, not around their own bounding box", () => {
  const block = turbineDeclarations()

  expect(block).toContain("transform-box: view-box")
  expect(block).not.toContain("fill-box")
  expect(block).toContain("transform-origin: 60px 75px")
})

test("the hub sits exactly at the rotation origin", () => {
  const { container } = render(<WindTurbineSvg />)

  const hub = container.querySelector("circle")
  expect(hub?.getAttribute("cx")).toBe("60")
  expect(hub?.getAttribute("cy")).toBe("75")

  // 三片叶子都从轮毂出发，否则旋转时会散开
  const blades = [...container.querySelectorAll(".wind-turbine-svg__blades path")]
  expect(blades).toHaveLength(3)
  for (const blade of blades) {
    expect(blade.getAttribute("d")).toMatch(/^M60 75/)
  }
})

test("spinning is driven by data attributes, not inline style", () => {
  const { container, rerender } = render(<WindTurbineSvg spinning />)
  expect(container.querySelector("svg")?.getAttribute("data-spinning")).toBe("true")

  rerender(<WindTurbineSvg spinning={false} />)
  expect(container.querySelector("svg")?.getAttribute("data-spinning")).toBe("false")
})
