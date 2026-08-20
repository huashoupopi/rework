import { expect, test } from "vitest"

import {
  DEFECT_NAMES,
  defectColor,
  defectName,
  documentStatusName,
  indexStatusName,
  taskStatusName,
} from "./labels"

test("maps backend enums to Chinese", () => {
  expect(defectName("corrosion")).toBe("腐蚀")
  expect(taskStatusName("completed")).toBe("已完成")
  expect(documentStatusName("active")).toBe("生效中")
  expect(indexStatusName("indexed")).toBe("已索引")
})

// 后端新增枚举时宁可露出英文，也不能显示空白或 "undefined"
test("falls back to the raw value for unknown enums", () => {
  expect(defectName("brand_new_defect")).toBe("brand_new_defect")
  expect(taskStatusName("queued")).toBe("queued")
  expect(indexStatusName("rebuilding")).toBe("rebuilding")
})

test("empty input yields empty string, never 'undefined'", () => {
  for (const fn of [defectName, taskStatusName, documentStatusName, indexStatusName]) {
    expect(fn(null)).toBe("")
    expect(fn(undefined)).toBe("")
    expect(fn("")).toBe("")
  }
})

test("every defect type has a colour", () => {
  for (const key of Object.keys(DEFECT_NAMES)) {
    expect(defectColor(key)).toMatch(/^#[0-9a-f]{6}$/i)
  }
})
