import * as React from "react"
import { Bot } from "lucide-react"

import { ChatMessageCard } from "./ChatMessageCard"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function ChatMessageList({ messages = [] }) {
  const containerRef = React.useRef(null)
  const bottomRef = React.useRef(null)
  const isNearBottomRef = React.useRef(true)

  const handleScroll = React.useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // 距离底部 100px 以内视为"在底部"
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  React.useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  return (
    <GlassPanel
      ref={containerRef}
      aria-label="聊天消息列表"
      aria-live="polite"
      aria-relevant="additions text"
      className="chat-stream"
      onScroll={handleScroll}
      role="log"
    >
      {messages.length === 0 ? (
        <div className="chat-empty-state">
          <div className="chat-empty-state__icon">
            <Bot size={28} />
          </div>
          <h2>开始对话</h2>
          <p>随便问点什么</p>
          <p>发送问题或上传图片，AI 将为你提供分析与建议。</p>
        </div>
      ) : null}
      {messages.map((message) => (
        <ChatMessageCard key={message.id} message={message} />
      ))}
      <div ref={bottomRef} />
    </GlassPanel>
  )
}
