import * as React from "react"
import { routes } from "@/app/router"

test("declares the expected public, protected, and admin routes", () => {
  expect(routes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "/login" }),
      expect.objectContaining({ path: "/register" }),
      expect.objectContaining({ path: "*" }),
    ]),
  )

  const protectedTree = routes.find((route) => !route.path)
  const shellTree = protectedTree.children[0]
  const leafPaths = shellTree.children
    .flatMap((route) => route.children ?? [route])
    .map((route) => route.path)
    .filter(Boolean)

  expect(leafPaths).toEqual(
    expect.arrayContaining([
      "/tasks",
      "/tasks/:taskId",
      "/chat",
      "/knowledge/documents",
      "/knowledge/rebuild",
      "/knowledge/chunk-configs",
      "/users",
      "/evals",
    ]),
  )
})
