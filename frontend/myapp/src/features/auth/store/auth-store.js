import { create } from "zustand"
import { persist } from "zustand/middleware"

export const AUTH_STORAGE_KEY = "rework-auth"

const initialState = {
  hydrated: false,
  token: null,
  userInfo: null,
}

const authStorage = {
  getItem: (name) => {
    const storedValue = window.localStorage.getItem(name)

    return storedValue ? JSON.parse(storedValue) : null
  },
  setItem: (name, value) => {
    window.localStorage.setItem(name, JSON.stringify(value))
  },
  removeItem: (name) => {
    window.localStorage.removeItem(name)
  },
}

export const useAuthStore = create(
  persist(
    (set) => ({
      ...initialState,
      setHydrated: (hydrated) =>
        set({
          hydrated,
        }),
      setUserInfo: (userInfo) =>
        set({
          userInfo,
        }),
      clearAuth: () =>
        set({
          hydrated: true,
          token: null,
          userInfo: null,
        }),
      setAuth: ({ token, userInfo }) =>
        set({
          hydrated: true,
          token,
          userInfo,
        }),
    }),
    {
      name: AUTH_STORAGE_KEY,
      storage: authStorage,
      partialize: (state) => ({
        token: state.token,
        userInfo: state.userInfo,
      }),
    },
  ),
)
