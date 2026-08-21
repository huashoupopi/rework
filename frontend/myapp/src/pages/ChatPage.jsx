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

// 2026-08-21 重做。原版右侧是三条纯装饰的「线程条」，浅底下就是一个空白圆角框，
// 页头因此只有标题和三行静态文案 —— 看起来朴素是因为它确实什么都没说。
// 现在换成对话流示意：每一轮一根竖条，用户与助手分色，高度按内容长度走，
// 像检测记录的走纸图。数据全部来自当前会话，不是装饰。
function ChatFlowStrip({ messages }) {
  const recent = messages.slice(-22)
  if (recent.length === 0) {
    return <div className="chat-flow chat-flow--empty">还没有对话</div>
  }

  // 固定 600 字封顶时实测高度两极化：用户提问普遍很短(压到 12%)、
  // 助手回答普遍超过 600 字(全部顶到 100%)，条形失去层次。
  // 改成按【当前这批】的最长一条归一化，再套平方根压缩长尾，
  // 短消息因此抬得起来，一条超长回答也不会把其余压平。
  const maxLen = Math.max(1, ...recent.map((m) => String(m?.content ?? "").length))

  return (
    <div aria-hidden="true" className="chat-flow">
      {recent.map((message, index) => {
        const len = String(message?.content ?? "").length
        const height = 14 + Math.sqrt(len / maxLen) * 86
        return (
          <span
            className="chat-flow__bar"
            data-role={message?.role === "user" ? "user" : "assistant"}
            key={`${message?.id ?? index}-${index}`}
            style={{ height: `${height}%` }}
          />
        )
      })}
    </div>
  )
}

function ChatHeroScene({ conversationTitle, messages = [], sending, taskId }) {
  const turns = messages.length
  const sourceCount = messages.reduce(
    (sum, message) => sum + (Array.isArray(message?.meta?.sources) ? message.meta.sources.length : 0),
    0,
  )

  return (
    <div className="chat-hero-scene">
      <div className="chat-hero-scene__identity">
        <p>当前会话</p>
        <strong title={conversationTitle}>{conversationTitle || (taskId === undefined ? "本轮会话" : "任务推理会话")}</strong>
        <span>{taskId === undefined ? "自由问答" : `任务 #${taskId} 上下文已连接`}</span>
      </div>

      <ChatFlowStrip messages={messages} />

      <div className="chat-hero-scene__facts">
        <div className="chat-hero-scene__fact">
          <span>消息</span>
          <strong>{turns}</strong>
        </div>
        <div className="chat-hero-scene__fact">
          <span>引用</span>
          <strong>{sourceCount}</strong>
        </div>
        <div className="chat-hero-scene__fact">
          <span>状态</span>
          <strong data-live={sending ? "true" : "false"}>{sending ? "生成中" : "可追问"}</strong>
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
        aside={
          <ChatHeroScene
            conversationTitle={activeConversation?.title}
            messages={messages}
            sending={sending}
            taskId={taskId}
          />
        }
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
