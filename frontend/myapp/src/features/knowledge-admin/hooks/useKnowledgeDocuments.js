import * as React from "react"

import {
  deleteKnowledgeDocument,
  getKnowledgeDocuments,
  uploadKnowledgeDocument,
} from "../api/knowledge-api"

const DEFAULT_FILTERS = {
  keyword: "",
  status: "active",
}
const DEFAULT_PAGE = 1
const DEFAULT_PAGE_SIZE = 10

function buildListParams({ filters, page, pageSize }) {
  return {
    keyword: filters.keyword,
    limit: pageSize,
    offset: Math.max(0, (page - 1) * pageSize),
    status: filters.status,
  }
}

export function useKnowledgeDocuments() {
  const [documents, setDocuments] = React.useState([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(DEFAULT_PAGE)
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE)
  const [filters, setFilters] = React.useState(DEFAULT_FILTERS)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(null)
  const requestIdRef = React.useRef(0)
  const mountedRef = React.useRef(true)

  const loadDocuments = React.useCallback(
    async (overrides = {}) => {
      const nextPage = overrides.page ?? page
      const nextPageSize = overrides.pageSize ?? pageSize
      const nextFilters = overrides.filters ?? filters
      const requestId = ++requestIdRef.current

      setLoading(true)
      setError(null)

      try {
        const response = await getKnowledgeDocuments(
          buildListParams({
            filters: nextFilters,
            page: nextPage,
            pageSize: nextPageSize,
          }),
        )

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return response
        }

        setDocuments(Array.isArray(response?.documents) ? response.documents : [])
        setTotal(typeof response?.total === "number" ? response.total : 0)

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
    },
    [filters, page, pageSize],
  )

  React.useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    loadDocuments().catch(() => {})
  }, [loadDocuments])

  const refresh = React.useCallback(() => loadDocuments(), [loadDocuments])

  const updateFilters = React.useCallback((updater) => {
    setPage(1)
    setFilters((currentFilters) =>
      typeof updater === "function" ? updater(currentFilters) : { ...currentFilters, ...updater },
    )
  }, [])

  const uploadDocument = React.useCallback(
    async (file) => {
      const response = await uploadKnowledgeDocument(file)
      await loadDocuments()

      return response
    },
    [loadDocuments],
  )

  const removeDocument = React.useCallback(
    async (docKey, options) => {
      const response = await deleteKnowledgeDocument(docKey, options)
      await loadDocuments()

      return response
    },
    [loadDocuments],
  )

  return {
    deleteDocument: removeDocument,
    documents,
    error,
    filters,
    loading,
    page,
    pageSize,
    refresh,
    setFilters: updateFilters,
    setPage,
    setPageSize,
    total,
    uploadDocument,
  }
}
