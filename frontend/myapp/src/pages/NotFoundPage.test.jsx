import * as React from "react"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { expect, test } from "vitest"

import { NotFoundPage } from "./NotFoundPage"

test("renders the 404 maintenance easter egg", () => {
  render(
    <MemoryRouter>
      <NotFoundPage />
    </MemoryRouter>,
  )

  expect(screen.getByRole("heading", { name: "停机检修中" })).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "返回首页" })).toHaveAttribute("href", "/")
  expect(screen.getByRole("img", { name: "停机检修中" })).toBeInTheDocument()
})
