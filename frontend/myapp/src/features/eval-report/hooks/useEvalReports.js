import * as React from "react"

import { getEvalReport, listEvalReports } from "../api/eval-api"

export function useEvalReports() {
  const [items, setItems] = React.useState([])
  const [report, setReport] = React.useState(null)
  const [selectedName, setSelectedName] = React.useState(null)
  // 跨跑批对比要同时持有两份报告 —— 逐题比 MRR 才能看出哪些题在抖
  const [compareReport, setCompareReport] = React.useState(null)
  const [compareName, setCompareName] = React.useState(null)
  const [compareLoading, setCompareLoading] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const requestIdRef = React.useRef(0)
  const detailIdRef = React.useRef(0)
  const compareIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const loadList = React.useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError(null)

    try {
      const response = await listEvalReports()
      if (!mountedRef.current || requestId !== requestIdRef.current) {
        return response
      }
      setItems(Array.isArray(response?.items) ? response.items : [])
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

  const openReport = React.useCallback(async (name) => {
    const requestId = ++detailIdRef.current
    setSelectedName(name)
    setDetailLoading(true)
    setError(null)

    try {
      const response = await getEvalReport(name)
      if (!mountedRef.current || requestId !== detailIdRef.current) {
        return response
      }
      setReport(response)
      return response
    } catch (nextError) {
      if (mountedRef.current && requestId === detailIdRef.current) {
        setError(nextError)
        setReport(null)
      }
      throw nextError
    } finally {
      if (mountedRef.current && requestId === detailIdRef.current) {
        setDetailLoading(false)
      }
    }
  }, [])

  const openCompare = React.useCallback(async (name) => {
    if (!name) {
      setCompareName(null)
      setCompareReport(null)
      return null
    }

    const requestId = ++compareIdRef.current
    setCompareName(name)
    setCompareLoading(true)

    try {
      const response = await getEvalReport(name)
      if (!mountedRef.current || requestId !== compareIdRef.current) {
        return response
      }
      setCompareReport(response)
      return response
    } catch (nextError) {
      if (mountedRef.current && requestId === compareIdRef.current) {
        setCompareReport(null)
      }
      throw nextError
    } finally {
      if (mountedRef.current && requestId === compareIdRef.current) {
        setCompareLoading(false)
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
    loadList().catch(() => {})
  }, [loadList])

  return {
    compareLoading,
    compareName,
    compareReport,
    detailLoading,
    error,
    items,
    loading,
    openCompare,
    openReport,
    refresh: loadList,
    report,
    selectedName,
  }
}
