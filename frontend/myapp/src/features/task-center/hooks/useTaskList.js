import * as React from "react"

import { getTasks } from "../api/task-api"

const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 10
const DEFAULT_POLL_INTERVAL_MS = 5000

function hasRunningTask(tasks) {
  return tasks.some((task) => task?.status === "pending" || task?.status === "progressing")
}

export function useTaskList({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const [page, setPage] = React.useState(DEFAULT_PAGE)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const [tasks, setTasks] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const pollingTimerRef = React.useRef(null)
  const requestIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const clearPollingTimer = React.useCallback(() => {
    if (pollingTimerRef.current !== null) {
      clearTimeout(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }, [])

  const loadTasks = React.useCallback(
    async (nextPage = page, nextPageSize = pageSize) => {
      const requestId = ++requestIdRef.current

      clearPollingTimer()
      setLoading(true)
      setError(null)

      try {
        const response = await getTasks(nextPage, nextPageSize)

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return response
        }

        const nextTasks = Array.isArray(response?.items) ? response.items : []
        setTasks(nextTasks)
        setTotal(typeof response?.total === "number" ? response.total : 0)

        if (hasRunningTask(nextTasks)) {
          pollingTimerRef.current = setTimeout(() => {
            loadTasks(nextPage, nextPageSize)
          }, pollIntervalMs)
        }

        return response
      } catch (nextError) {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setError(nextError)
        }

        return null
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [clearPollingTimer, page, pageSize, pollIntervalMs],
  )

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      clearPollingTimer()
    }
  }, [clearPollingTimer])

  React.useEffect(() => {
    loadTasks(page, pageSize)
  }, [loadTasks, page, pageSize])

  const refresh = React.useCallback(() => {
    return loadTasks(page, pageSize)
  }, [loadTasks, page, pageSize])

  return {
    error,
    loading,
    page,
    pageSize,
    refresh,
    setPage,
    setPageSize,
    tasks,
    total,
  }
}
