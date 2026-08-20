import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, test } from "vitest"

const SRC = resolve(process.cwd(), "src")

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.(jsx?|tsx?)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full)
    }
  }
  return out
}

// 回归钉：批次 2 修 IDOR 时关掉了 /static 的匿名访问，图片必须走
// GET /tasks/{id}/image 或 /chat/images/{id} 带 token 取 Blob。
// 任何一处改回直连 /static，页面上的图会静默变成 404 —— 后端 200、前端不报错，
// 只是显示"不可用"，测试不盯着就发现不了。
test("no source file builds a bare /static image URL", () => {
  const offenders = []

  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf-8")
    for (const [index, line] of text.split("\n").entries()) {
      if (/["'`]\/static\//.test(line)) {
        offenders.push(`${file.replace(SRC, "src")}:${index + 1}: ${line.trim()}`)
      }
    }
  }

  expect(offenders).toEqual([])
})
