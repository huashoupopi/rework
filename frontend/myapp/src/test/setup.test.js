import { expect, test, vi } from "vitest"

test("supports getComputedStyle calls with pseudo-element selectors in jsdom", () => {
  const element = document.createElement("div")
  document.body.appendChild(element)
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

  expect(() => window.getComputedStyle(element, "::before")).not.toThrow()
  expect(errorSpy).not.toHaveBeenCalled()

  errorSpy.mockRestore()
})
