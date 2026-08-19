import { useCallback, useEffect, useRef, useState } from "react"

import { getChatHistory, streamChat } from "../api/chat-api"
import { parseStreamSegments } from "../utils/parseStreamSegments"

function createMessageId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getDraftMessage(content, parsed, createdAt, id) {
  return {
    content,
    created_at: createdAt,
    id,
    meta: {
      sources: parsed.sources,
      think: parsed.think,
    },
    role: "assistant",
    status: "streaming",
  }
}

function getFinalAssistantMessage(content, parsed, createdAt, id) {
  return {
    content,
    created_at: createdAt,
    id,
    meta: {
      sources: parsed.sources,
      think: parsed.think,
    },
    role: "assistant",
    status: "complete",
  }
}

function appendAssistantMessage(messages, nextAssistant, draftId) {
  const draftIndex = messages.findIndex((message) => message.id === draftId)

  if (draftIndex === -1) {
    return [...messages, nextAssistant]
  }

  return messages.map((message) => (message.id === draftId ? nextAssistant : message))
}

function removeAssistantDraft(messages, draftId) {
  return messages.filter((message) => message.id !== draftId)
}

function isLocalMessage(message) {
  if (!message) {
    return false
  }

  if (typeof message.id !== "string") {
    return false
  }

  return message.id.startsWith("user-") || message.id.startsWith("assistant-")
}

function mergeHistoryWithLocalMessages(historyMessages, currentMessages) {
  const localMessages = currentMessages.filter(isLocalMessage)

  if (localMessages.length === 0) {
    return historyMessages
  }

  return [...historyMessages, ...localMessages]
}

export function useChatSession({ conversationId, taskId } = {}) {
  const [messages, setMessages] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  const loadRequestIdRef = useRef(0)
  const mutationVersionRef = useRef(0)
  const sendingRef = useRef(false)
  const rawAssistantRef = useRef("")
  const abortControllerRef = useRef(null)

  const loadHistory = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    const mutationVersion = mutationVersionRef.current

    setLoadingHistory(true)
    setError(null)

    try {
      const history = await getChatHistory({
        conversationId,
        limit: 50,
        order: "asc",
        taskId,
      })

      if (loadRequestIdRef.current !== requestId) {
        return
      }

      const historyMessages = Array.isArray(history?.items) ? history.items : []

      setMessages((currentMessages) => {
        if (sendingRef.current || mutationVersionRef.current !== mutationVersion) {
          return mergeHistoryWithLocalMessages(historyMessages, currentMessages)
        }

        return historyMessages
      })
    } catch (loadError) {
      if (loadRequestIdRef.current !== requestId) {
        return
      }

      setError(loadError)
      setMessages((currentMessages) => {
        if (sendingRef.current || mutationVersionRef.current !== mutationVersion) {
          return mergeHistoryWithLocalMessages([], currentMessages)
        }

        return []
      })
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoadingHistory(false)
      }
    }
  }, [conversationId, taskId])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  const refreshHistory = useCallback(() => loadHistory(), [loadHistory])

  const sendMessage = useCallback(
    async ({ question, images } = {}) => {
      if (sendingRef.current) {
        return
      }

      sendingRef.current = true
      mutationVersionRef.current += 1
      setSending(true)
      setError(null)

      const userMessage = {
        content: question,
        created_at: new Date().toISOString(),
        id: createMessageId("user"),
        images: Array.isArray(images) ? images : images ? [images] : [],
        meta: {},
        role: "user",
      }
      const assistantCreatedAt = new Date().toISOString()
      const assistantDraftId = createMessageId("assistant")

      rawAssistantRef.current = ""

      const controller = new AbortController()
      abortControllerRef.current = controller

      setMessages((currentMessages) => [
        ...currentMessages,
        userMessage,
        getDraftMessage("", { sources: [], think: "" }, assistantCreatedAt, assistantDraftId),
      ])

      try {
        const rawResponse = await streamChat({
          images,
          onChunk: (chunk) => {
            rawAssistantRef.current += chunk
            const parsed = parseStreamSegments(rawAssistantRef.current)
            setMessages((currentMessages) =>
              appendAssistantMessage(
                currentMessages,
                getDraftMessage(parsed.content, parsed, assistantCreatedAt, assistantDraftId),
                assistantDraftId,
              ),
            )
          },
          conversationId,
          question,
          signal: controller.signal,
          taskId,
        })

        if (typeof rawResponse === "string" && rawResponse) {
          rawAssistantRef.current = rawResponse
        }

        const parsed = parseStreamSegments(rawAssistantRef.current)

        setMessages((currentMessages) =>
          appendAssistantMessage(
            currentMessages,
            getFinalAssistantMessage(parsed.content, parsed, assistantCreatedAt, assistantDraftId),
            assistantDraftId,
          ),
        )
      } catch (sendError) {
        if (sendError.name === "AbortError") {
          const parsed = parseStreamSegments(rawAssistantRef.current)
          if (rawAssistantRef.current.trim()) {
            setMessages((currentMessages) =>
              appendAssistantMessage(
                currentMessages,
                getFinalAssistantMessage(parsed.content, parsed, assistantCreatedAt, assistantDraftId),
                assistantDraftId,
              ),
            )
          } else {
            setMessages((currentMessages) => removeAssistantDraft(currentMessages, assistantDraftId))
          }
        } else {
          setError(sendError)
          setMessages((currentMessages) => removeAssistantDraft(currentMessages, assistantDraftId))
        }
      } finally {
        abortControllerRef.current = null
        sendingRef.current = false
        setSending(false)
      }
    },
    [conversationId, taskId],
  )

  const stopChat = useCallback(() => {
    abortControllerRef.current?.abort()
  }, [])

  return {
    error,
    loadingHistory,
    messages,
    refreshHistory,
    sendMessage,
    sending,
    stopChat,
  }
}
