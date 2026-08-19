import { expect, test } from "vitest"

import { isNightSkyHour } from "./nightSky"

test("treats 22:00-06:00 as night sky", () => {
  expect(isNightSkyHour(new Date(2026, 0, 1, 22, 0, 0))).toBe(true)
  expect(isNightSkyHour(new Date(2026, 0, 1, 5, 59, 0))).toBe(true)
  expect(isNightSkyHour(new Date(2026, 0, 1, 6, 0, 0))).toBe(false)
  expect(isNightSkyHour(new Date(2026, 0, 1, 12, 0, 0))).toBe(false)
})
