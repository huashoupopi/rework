import * as React from "react"

import { getCurrentUser } from "@/features/auth/api/auth-api"
import { useAuthStore } from "@/features/auth/store/auth-store"

export function AuthBootstrap({ children }) {
  const token = useAuthStore((state) => state.token)
  const setHydrated = useAuthStore((state) => state.setHydrated)
  const setUserInfo = useAuthStore((state) => state.setUserInfo)
  const clearAuth = useAuthStore((state) => state.clearAuth)

  React.useEffect(() => {
    let active = true

    async function bootstrap() {
      if (!token) {
        if (active) {
          setHydrated(true)
        }
        return
      }

      try {
        const currentUser = await getCurrentUser()

        if (active) {
          setUserInfo(currentUser)
          setHydrated(true)
        }
      } catch {
        if (active) {
          clearAuth()
        }
      }
    }

    bootstrap()

    return () => {
      active = false
    }
  }, [clearAuth, setHydrated, setUserInfo, token])

  return children
}
