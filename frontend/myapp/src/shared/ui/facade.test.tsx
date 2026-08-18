import { render, screen } from "@testing-library/react"
import { expect, test, vi } from "vitest"

import { AuroraBackground } from "./AuroraBackground"
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

test("night aurora sets data-night", () => {
  render(<AuroraBackground night>夜空</AuroraBackground>)
  expect(screen.getByText("夜空").closest("[data-night]")).toHaveAttribute("data-night", "true")
})
