import { afterEach, expect, test } from "vitest"

import { useShellStore } from "./useShellStore"

afterEach(() => {
  useShellStore.setState({
    sidebarCollapsed: false,
  })
})

test("starts with an expanded sidebar", () => {
  expect(useShellStore.getState().sidebarCollapsed).toBe(false)
})

test("toggles the sidebar collapsed state", () => {
  useShellStore.getState().toggleSidebar()

  expect(useShellStore.getState().sidebarCollapsed).toBe(true)
})
