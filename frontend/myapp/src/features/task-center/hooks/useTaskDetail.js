import * as React from "react"

import { downloadTaskImage, getTaskDetail } from "../api/task-api"

const DEFAULT_POLL_INTERVAL_MS = 5000
const RUNNING_STATUSES = new Set(["pending", "progressing"])

function normalizeTaskId(taskId) {
  if (typeof taskId === "string") {
    const parsedTaskId = Number(taskId)

    return Number.isNaN(parsedTaskId) ? taskId : parsedTaskId
  }

  return taskId
}

export function useTaskDetail(taskId, { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const normalizedTaskId = normalizeTaskId(taskId)
  const [task, setTask] = React.useState(null)
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

  const loadTask = React.useCallback(
    async (nextTaskId = normalizedTaskId) => {
      if (nextTaskId === null || nextTaskId === undefined || nextTaskId === "") {
        return null
      }

      const requestId = ++requestIdRef.current

      clearPollingTimer()
      setLoading(true)
      setError(null)

      try {
        const response = await getTaskDetail(nextTaskId)

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return response
        }

        setTask(response ?? null)

        if (RUNNING_STATUSES.has(response?.status)) {
          pollingTimerRef.current = setTimeout(() => {
            loadTask(nextTaskId)
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
    [clearPollingTimer, normalizedTaskId, pollIntervalMs],
  )

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      clearPollingTimer()
    }
  }, [clearPollingTimer])

  React.useEffect(() => {
    setTask(null)
    setError(null)
    loadTask(normalizedTaskId)
  }, [loadTask, normalizedTaskId])

  const refresh = React.useCallback(() => {
    return loadTask(normalizedTaskId)
  }, [loadTask, normalizedTaskId])

  const download = React.useCallback(() => {
    if (normalizedTaskId === null || normalizedTaskId === undefined || normalizedTaskId === "") {
      return Promise.resolve(null)
    }

    return downloadTaskImage(normalizedTaskId)
  }, [normalizedTaskId])

  return {
    download,
    error,
    loading,
    refresh,
    task,
  }
}
