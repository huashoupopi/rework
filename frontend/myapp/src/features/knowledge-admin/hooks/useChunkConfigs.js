import * as React from "react"

import {
  createChunkConfig,
  deleteChunkConfig,
  getChunkConfigs,
  updateChunkConfig,
} from "../api/knowledge-api"

function validateChunkPayload(payload) {
  const chunkSize = Number(payload?.chunk_size)
  const chunkOverlap = Number(payload?.chunk_overlap)

  if (!Number.isNaN(chunkSize) && !Number.isNaN(chunkOverlap) && chunkOverlap >= chunkSize) {
    throw new Error("chunk_overlap 必须小于 chunk_size")
  }
}

export function useChunkConfigs() {
  const [configs, setConfigs] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const requestIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const loadConfigs = React.useCallback(async () => {
    const requestId = ++requestIdRef.current

    setLoading(true)
    setError(null)

    try {
      const response = await getChunkConfigs()

      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return response
      }

      setConfigs(Array.isArray(response) ? response : [])

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
    loadConfigs().catch(() => {})
  }, [loadConfigs])

  const refresh = React.useCallback(() => loadConfigs(), [loadConfigs])

  const createConfig = React.useCallback(
    async (payload) => {
      validateChunkPayload(payload)
      const response = await createChunkConfig(payload)
      await loadConfigs()

      return response
    },
    [loadConfigs],
  )

  const editConfig = React.useCallback(
    async (configId, payload) => {
      const existingConfig = configs.find((config) => config.id === configId) ?? {}
      validateChunkPayload({
        ...existingConfig,
        ...payload,
      })
      const response = await updateChunkConfig(configId, payload)
      await loadConfigs()

      return response
    },
    [configs, loadConfigs],
  )

  const removeConfig = React.useCallback(
    async (configId) => {
      const response = await deleteChunkConfig(configId)
      await loadConfigs()

      return response
    },
    [loadConfigs],
  )

  return {
    configs,
    createConfig,
    deleteConfig: removeConfig,
    error,
    loading,
    refresh,
    updateConfig: editConfig,
  }
}
