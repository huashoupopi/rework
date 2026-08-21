import * as React from "react"
import { useSearchParams } from "react-router-dom"

import { ChatComposer } from "@/features/chat/components/ChatComposer"
import { ChatContextBanner } from "@/features/chat/components/ChatContextBanner"
import { ChatMessageList } from "@/features/chat/components/ChatMessageList"
import { ConversationList } from "@/features/chat/components/ConversationList"
import { useChatSession } from "@/features/chat/hooks/useChatSession"
import { useConversations } from "@/features/chat/hooks/useConversations"
import { useTaskDetail } from "@/features/task-center/hooks/useTaskDetail"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { PageWorkband } from "@/shared/ui/PageWorkband"

function parseOptionalInt(value) {
  if (value === null || value === undefined || value === "") {
    return undefined
  }

  const parsed = Number(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function ChatHeroScene({ sending, taskId }) {
  return (
    <div className="chat-hero-scene">
      <div className="chat-hero-scene__identity">
        <p>当前会话</p>
        <strong>{taskId === undefined ? "本轮会话" : "任务推理会话"}</strong>
        <span>{taskId === undefined ? "自由问答" : `任务 #${taskId} 上下文已连接`}</span>
      </div>
      <div aria-hidden="true" className="chat-hero-scene__threads">
        <div className="chat-hero-scene__thread chat-hero-scene__thread--assistant" />
        <div className="chat-hero-scene__thread chat-hero-scene__thread--user" />
        <div className="chat-hero-scene__thread chat-hero-scene__thread--assistant-soft" />
      </div>
      <div className="chat-hero-scene__facts">
        <div className="chat-hero-scene__fact">
          <span>上下文</span>
          <strong>{taskId === undefined ? "自由问答" : "带任务上下文"}</strong>
        </div>
        <div className="chat-hero-scene__fact">
          <span>模式</span>
          <strong>{taskId === undefined ? "自由模式" : "任务推理"}</strong>
        </div>
        <div className="chat-hero-scene__fact">
          <span>状态</span>
          <strong>{sending ? "生成中" : "可继续追问"}</strong>
        </div>
      </div>
    </div>
  )
}

export function ChatPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const conversationId = parseOptionalInt(searchParams.get("conversationId"))
  const taskIdFromUrl = parseOptionalInt(searchParams.get("taskId"))
  const conversations = useConversations()
  const activeConversation = conversations.items.find((item) => item.id === conversationId)
  const taskId = activeConversation?.task_id ?? taskIdFromUrl
  const { error, loadingHistory, messages, sendMessage, sending, stopChat } = useChatSession({
    conversationId,
    taskId,
  })
  const { task } = useTaskDetail(taskId)

  const selectConversation = React.useCallback(
    (conversation) => {
      const next = new URLSearchParams()
      next.set("conversationId", String(conversation.id))

      if (conversation.task_id != null) {
        next.set("taskId", String(conversation.task_id))
      }

      setSearchParams(next)
    },
    [setSearchParams],
  )

  const handleCreate = React.useCallback(async () => {
    const created = await conversations.create({ taskId: taskIdFromUrl })
    if (created?.id != null) {
      selectConversation(created)
    }
  }, [conversations, selectConversation, taskIdFromUrl])

  const handleDelete = React.useCallback(
    async (id) => {
      await conversations.remove(id)
      if (id === conversationId) {
        setSearchParams(taskIdFromUrl !== undefined ? { taskId: String(taskIdFromUrl) } : {})
      }
    },
    [conversationId, conversations, setSearchParams, taskIdFromUrl],
  )

  const handleSend = React.useCallback(
    async (payload) => {
      await sendMessage(payload)
      await conversations.refresh()
    },
    [conversations, sendMessage],
  )

  return (
    <div className="page-stack page-stack--fill">
      <PageWorkband
        aside={<ChatHeroScene sending={sending} taskId={taskId} />}
        className="page-workband--immersive"
        description="围绕当前任务继续推理、追问和记录处理判断。"
        eyebrow="智能问答"
        supporting="从任务详情带上下文进入，或在这里直接发起自由追问。"
        title="智能问答"
      />
      <div className="chat-layout">
        <ConversationList
          activeId={conversationId}
          creating={conversations.loading}
          items={conversations.items}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onRename={conversations.rename}
          onSelect={selectConversation}
        />
        <GlassPanel className="chat-workspace">
          <div className="chat-workspace__header">
            <ChatContextBanner
              onAsk={(question) => handleSend({ images: [], question })}
              task={task}
              taskId={taskId}
            />
          </div>
          {error ? (
            <p role="alert" className="chat-error">
              {error.message}
            </p>
          ) : null}
          {loadingHistory ? (
            <div className="chat-loading">
              加载历史消息...
            </div>
          ) : null}
          <ChatMessageList messages={messages} />
        </GlassPanel>
        <ChatComposer onSend={handleSend} onStop={stopChat} sending={sending} />
      </div>
    </div>
  )
}
