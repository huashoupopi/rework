import * as React from "react"
import { Navigate, Outlet } from "react-router-dom"

import { useAuthStore } from "@/features/auth/store/auth-store"

export function AdminRoute() {
  const isSuperuser = useAuthStore((state) => state.userInfo?.is_superuser)

  if (!isSuperuser) {
    return <Navigate replace to="/" />
  }

  return <Outlet />
}
