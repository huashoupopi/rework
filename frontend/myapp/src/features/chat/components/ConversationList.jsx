import * as React from "react"
import { Popconfirm } from "antd"
import { Check, Pencil, Plus, Trash2, X } from "lucide-react"

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
  // 重命名走行内编辑，删除走 Popconfirm。
  // ⛔ 不用 window.prompt / window.confirm —— 原生对话框会阻塞整个 JS 主线程
  // （自动化实测：点删除后页面完全无响应），而且与深色玻璃设计不搭。
  const [editingId, setEditingId] = React.useState(null)
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef(null)

  React.useEffect(() => {
    if (editingId !== null) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editingId])

  function startRename(event, conversation) {
    event.stopPropagation()
    setEditingId(conversation.id)
    setDraft(conversation.title ?? "")
  }

  function cancelRename() {
    setEditingId(null)
    setDraft("")
  }

  function commitRename(conversation) {
    const next = draft.trim()
    if (next && next !== conversation.title) {
      onRename?.(conversation.id, next)
    }
    cancelRename()
  }

  function handleKeyDown(event, conversation) {
    if (event.key === "Enter") {
      event.preventDefault()
      commitRename(conversation)
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancelRename()
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
            const editing = editingId === conversation.id

            return (
              <li key={conversation.id}>
                {editing ? (
                  <div className="chat-sidebar__item chat-sidebar__item--editing">
                    <input
                      aria-label={`会话标题 ${conversation.title}`}
                      className="chat-sidebar__rename-input"
                      ref={inputRef}
                      value={draft}
                      onBlur={() => commitRename(conversation)}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => handleKeyDown(event, conversation)}
                    />
                  </div>
                ) : (
                  <button
                    className={
                      selected
                        ? "chat-sidebar__item chat-sidebar__item--active"
                        : "chat-sidebar__item"
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
                )}
                <div className="chat-sidebar__actions">
                  {editing ? (
                    <>
                      <button
                        aria-label={`保存 ${conversation.title}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => commitRename(conversation)}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        aria-label={`取消重命名 ${conversation.title}`}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={cancelRename}
                      >
                        <X size={13} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        aria-label={`重命名 ${conversation.title}`}
                        type="button"
                        onClick={(event) => startRename(event, conversation)}
                      >
                        <Pencil size={13} />
                      </button>
                      <Popconfirm
                        cancelText="取消"
                        okText="删除"
                        okButtonProps={{ danger: true }}
                        title="删除会话"
                        description={`「${conversation.title || "新对话"}」及其消息将被删除。`}
                        onConfirm={() => onDelete?.(conversation.id)}
                      >
                        <button aria-label={`删除 ${conversation.title}`} type="button">
                          <Trash2 size={13} />
                        </button>
                      </Popconfirm>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </GlassPanel>
  )
}
