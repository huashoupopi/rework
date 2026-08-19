import { useCallback, useEffect, useState } from "react"

import {
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
} from "../api/conversation-api"

export function useConversations() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const payload = await listConversations()
      setItems(Array.isArray(payload?.items) ? payload.items : [])
    } catch (loadError) {
      setError(loadError)
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const create = useCallback(
    async ({ taskId, title } = {}) => {
      const created = await createConversation({ taskId, title })
      await refresh()
      return created
    },
    [refresh],
  )

  const rename = useCallback(
    async (conversationId, title) => {
      const updated = await renameConversation(conversationId, title)
      await refresh()
      return updated
    },
    [refresh],
  )

  const remove = useCallback(
    async (conversationId) => {
      await deleteConversation(conversationId)
      await refresh()
    },
    [refresh],
  )

  return {
    create,
    error,
    items,
    loading,
    refresh,
    remove,
    rename,
  }
}
