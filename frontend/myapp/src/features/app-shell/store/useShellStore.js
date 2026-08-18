import { create } from "zustand"

export const useShellStore = create((set) => ({
  sidebarCollapsed: false,
  toggleSidebar: () =>
    set((state) => ({
      sidebarCollapsed: !state.sidebarCollapsed,
    })),
}))
