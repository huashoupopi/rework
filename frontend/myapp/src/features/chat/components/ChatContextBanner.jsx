import * as React from "react"
import { Link2, Orbit } from "lucide-react"

export function ChatContextBanner({ taskId }) {
  const hasTask = taskId !== undefined && taskId !== null

  return (
    <section aria-label="聊天上下文" className="context-banner">
      <div className="context-banner__icon">
        {hasTask ? <Link2 size={16} /> : <Orbit size={16} />}
      </div>
      <span>{hasTask ? `关联任务 #${taskId}` : "通用对话"}</span>
    </section>
  )
}
