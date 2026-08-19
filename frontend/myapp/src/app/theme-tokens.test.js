import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

import { antdTheme } from "./theme"

const here = path.dirname(fileURLToPath(import.meta.url))

function readCssCustomProperty(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*([^;]+);`))
  if (!match) {
    throw new Error(`missing CSS token ${name}`)
  }
  return match[1].trim()
}

test("antd seed colors stay in sync with CSS tokens", () => {
  const css = readFileSync(path.join(here, "../index.css"), "utf8")

  expect(antdTheme.token.colorPrimary).toBe(readCssCustomProperty(css, "--accent"))
  expect(antdTheme.token.colorBgContainer).toBe(readCssCustomProperty(css, "--surface-solid"))
})
