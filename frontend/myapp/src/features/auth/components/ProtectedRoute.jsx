import * as React from "react"
import { Navigate, Outlet, useLocation } from "react-router-dom"

import { useAuthStore } from "@/features/auth/store/auth-store"

export function ProtectedRoute() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)
  const location = useLocation()

  if (!hydrated) {
    return <div role="status">正在验证登录状态...</div>
  }

  if (!token) {
    return <Navigate replace state={{ from: location }} to="/login" />
  }

  return <Outlet />
}
