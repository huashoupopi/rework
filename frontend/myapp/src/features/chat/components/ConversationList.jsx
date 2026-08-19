import * as React from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"

import { GlassPanel } from "@/shared/ui/GlassPanel"

export function ConversationList({
  activeId,
  creating,
  items,
  onCreate,
  onDelete,
  onRename,
  onSelect,
}) {
  const handleRename = (event, conversation) => {
    event.stopPropagation()
    const nextTitle = window.prompt("会话标题", conversation.title ?? "")

    if (nextTitle && nextTitle.trim() && nextTitle.trim() !== conversation.title) {
      onRename?.(conversation.id, nextTitle.trim())
    }
  }

  const handleDelete = (event, conversation) => {
    event.stopPropagation()

    if (window.confirm(`删除会话「${conversation.title}」及其消息？`)) {
      onDelete?.(conversation.id)
    }
  }

  return (
    <GlassPanel as="aside" className="chat-sidebar" aria-label="会话列表">
      <div className="chat-sidebar__head">
        <h2>会话</h2>
        <button className="secondary-action" type="button" disabled={creating} onClick={onCreate}>
          <Plus size={14} />
          <span>新建</span>
        </button>
      </div>
      {items.length === 0 ? (
        <p className="chat-sidebar__empty">还没有会话，点新建开始。</p>
      ) : (
        <ul className="chat-sidebar__list">
          {items.map((conversation) => {
            const selected = conversation.id === activeId

            return (
              <li key={conversation.id}>
                <button
                  className={
                    selected ? "chat-sidebar__item chat-sidebar__item--active" : "chat-sidebar__item"
                  }
                  type="button"
                  onClick={() => onSelect?.(conversation)}
                >
                  <span className="chat-sidebar__title">{conversation.title || "新对话"}</span>
                  {conversation.task_id != null ? (
                    <span className="chat-sidebar__meta">任务 #{conversation.task_id}</span>
                  ) : (
                    <span className="chat-sidebar__meta">自由问答</span>
                  )}
                </button>
                <div className="chat-sidebar__actions">
                  <button
                    aria-label={`重命名 ${conversation.title}`}
                    type="button"
                    onClick={(event) => handleRename(event, conversation)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    aria-label={`删除 ${conversation.title}`}
                    type="button"
                    onClick={(event) => handleDelete(event, conversation)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </GlassPanel>
  )
}
