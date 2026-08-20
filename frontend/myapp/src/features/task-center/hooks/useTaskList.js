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
  // 全量的各状态分布，由后端给 —— 前端自己数只能数到当前页
  const [statusCounts, setStatusCounts] = React.useState({})
  const [status, setStatusState] = React.useState("")
  const [fileName, setFileNameState] = React.useState("")
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
    async (
      nextPage = page,
      nextPageSize = pageSize,
      nextStatus = status,
      nextFileName = fileName,
    ) => {
      const requestId = ++requestIdRef.current

      clearPollingTimer()
      setLoading(true)
      setError(null)

      try {
        const response = await getTasks(nextPage, nextPageSize, nextStatus, nextFileName)

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return response
        }

        const nextTasks = Array.isArray(response?.items) ? response.items : []
        setTasks(nextTasks)
        setTotal(typeof response?.total === "number" ? response.total : 0)
        setStatusCounts(
          response?.status_counts && typeof response.status_counts === "object"
            ? response.status_counts
            : {},
        )

        if (hasRunningTask(nextTasks)) {
          pollingTimerRef.current = setTimeout(() => {
            loadTasks(nextPage, nextPageSize, nextStatus, nextFileName)
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
    [clearPollingTimer, fileName, page, pageSize, pollIntervalMs, status],
  )

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      clearPollingTimer()
    }
  }, [clearPollingTimer])

  React.useEffect(() => {
    loadTasks(page, pageSize, status, fileName)
  }, [fileName, loadTasks, page, pageSize, status])

  const refresh = React.useCallback(() => {
    return loadTasks(page, pageSize, status, fileName)
  }, [fileName, loadTasks, page, pageSize, status])

  // 换筛选条件必须回第一页 —— 否则会停在一个新结果集里不存在的页码上
  const setStatus = React.useCallback((nextStatus) => {
    setStatusState(nextStatus ?? "")
    setPage(DEFAULT_PAGE)
  }, [])

  const setFileName = React.useCallback((nextFileName) => {
    setFileNameState(nextFileName ?? "")
    setPage(DEFAULT_PAGE)
  }, [])

  return {
    error,
    loading,
    page,
    pageSize,
    refresh,
    fileName,
    setFileName,
    setPage,
    setPageSize,
    setStatus,
    status,
    statusCounts,
    tasks,
    total,
  }
}
