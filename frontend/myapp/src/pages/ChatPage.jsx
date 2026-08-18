import * as React from "react"
import { useSearchParams } from "react-router-dom"

import { ChatComposer } from "@/features/chat/components/ChatComposer"
import { ChatContextBanner } from "@/features/chat/components/ChatContextBanner"
import { ChatMessageList } from "@/features/chat/components/ChatMessageList"
import { useChatSession } from "@/features/chat/hooks/useChatSession"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { PageWorkband } from "@/shared/ui/PageWorkband"

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
  const [searchParams] = useSearchParams()
  const taskIdParam = searchParams.get("taskId")
  const numericTaskId = taskIdParam === null ? undefined : Number(taskIdParam)
  const taskId = taskIdParam === null || Number.isNaN(numericTaskId) ? undefined : numericTaskId
  const { error, loadingHistory, messages, sendMessage, sending, stopChat } = useChatSession({
    taskId,
  })

  return (
    <div className="page-stack">
      <PageWorkband
        aside={<ChatHeroScene sending={sending} taskId={taskId} />}
        className="page-workband--immersive"
        description="围绕当前任务继续推理、追问和记录处理判断。"
        eyebrow="智能问答"
        supporting="从任务详情带上下文进入，或在这里直接发起自由追问。"
        title="智能问答"
      />
      <div className="chat-layout">
        <GlassPanel className="chat-workspace">
          <div className="chat-workspace__header">
            <ChatContextBanner taskId={taskId} />
          </div>
          {error ? <p role="alert" className="chat-error">{error.message}</p> : null}
          {loadingHistory ? (
            <div className="chat-loading">
              <p>加载历史消息...</p>
            </div>
          ) : null}
          <ChatMessageList messages={messages} />
        </GlassPanel>
        <ChatComposer onSend={sendMessage} onStop={stopChat} sending={sending} />
      </div>
    </div>
  )
}
