import * as React from "react"

import {
  getKnowledgeStatus,
  triggerFullRebuild as triggerFullRebuildRequest,
  triggerIncrementalRebuild as triggerIncrementalRebuildRequest,
} from "../api/knowledge-api"

const DEFAULT_POLL_INTERVAL_MS = 5000

export function useKnowledgeStatus({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  const [status, setStatus] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const [actionMessage, setActionMessage] = React.useState("")
  const [actionLoading, setActionLoading] = React.useState(false)
  const pollingTimerRef = React.useRef(null)
  const requestIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const clearPollingTimer = React.useCallback(() => {
    if (pollingTimerRef.current !== null) {
      clearTimeout(pollingTimerRef.current)
      pollingTimerRef.current = null
    }
  }, [])

  const loadStatus = React.useCallback(async () => {
    const requestId = ++requestIdRef.current

    clearPollingTimer()
    setLoading(true)
    setError(null)

    try {
      const response = await getKnowledgeStatus()

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return response
      }

      setStatus(response ?? null)

      if (response?.rebuild_running) {
        pollingTimerRef.current = setTimeout(() => {
          loadStatus().catch(() => {})
        }, pollIntervalMs)
      }

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
  }, [clearPollingTimer, pollIntervalMs])

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      clearPollingTimer()
    }
  }, [clearPollingTimer])

  React.useEffect(() => {
    loadStatus().catch(() => {})
  }, [loadStatus])

  const refresh = React.useCallback(() => loadStatus(), [loadStatus])

  const triggerFullRebuild = React.useCallback(
    async (options) => {
      setActionLoading(true)
      setError(null)

      try {
        const response = await triggerFullRebuildRequest(options)
        setActionMessage(response?.message ?? "")
        await loadStatus()

        return response
      } finally {
        if (mountedRef.current) {
          setActionLoading(false)
        }
      }
    },
    [loadStatus],
  )

  const triggerIncrementalRebuild = React.useCallback(
    async (options) => {
      setActionLoading(true)
      setError(null)

      try {
        const response = await triggerIncrementalRebuildRequest(options)
        setActionMessage(response?.message ?? "")
        await loadStatus()

        return response
      } finally {
        if (mountedRef.current) {
          setActionLoading(false)
        }
      }
    },
    [loadStatus],
  )

  return {
    actionLoading,
    actionMessage,
    error,
    loading,
    refresh,
    status,
    triggerFullRebuild,
    triggerIncrementalRebuild,
  }
}
