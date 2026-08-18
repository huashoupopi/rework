import * as React from "react"

import { useAuthStore } from "@/features/auth/store/auth-store"

import { deleteUser, getUsers } from "../api/user-api"

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 100

export function useUserAdmin() {
  const currentUserId = useAuthStore((state) => state.userInfo?.id ?? null)
  const [users, setUsers] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const requestIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const loadUsers = React.useCallback(async () => {
    const requestId = ++requestIdRef.current

    setLoading(true)
    setError(null)

    try {
      const response = await getUsers({
        page: DEFAULT_PAGE,
        pageSize: DEFAULT_PAGE_SIZE,
      })

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return response
      }

      setUsers(Array.isArray(response) ? response : [])

      return response
    } catch (nextError) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(nextError)
      }

      throw nextError
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    loadUsers().catch(() => {})
  }, [loadUsers])

  const refresh = React.useCallback(() => loadUsers(), [loadUsers])

  const deleteUserById = React.useCallback(
    async (userId) => {
      if (userId === currentUserId) {
        throw new Error("无法删除自己")
      }

      const response = await deleteUser(userId)
      await loadUsers()

      return response
    },
    [currentUserId, loadUsers],
  )

  return {
    currentUserId,
    deleteUserById,
    error,
    loading,
    refresh,
    users,
  }
}
