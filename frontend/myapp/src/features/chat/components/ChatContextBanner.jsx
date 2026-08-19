import * as React from "react"
import { Link2, Orbit } from "lucide-react"

import { DEFECT_NAMES } from "@/features/task-center/components/TaskTable"

export function countDefects(task) {
  const objects = Array.isArray(task?.detect_result?.objects) ? task.detect_result.objects : []
  const counts = new Map()

  for (const object of objects) {
    const cls = object?.class || "unknown"
    counts.set(cls, (counts.get(cls) ?? 0) + 1)
  }

  return [...counts.entries()].map(([cls, count]) => ({
    cls,
    count,
    name: DEFECT_NAMES[cls] || cls,
  }))
}

export function buildPresetQuestions(defects) {
  if (!defects.length) {
    return ["这类缺陷怎么修?", "修复前要注意什么?", "验收标准是什么?"]
  }

  const questions = defects.slice(0, 2).map((defect) => `${defect.name}怎么修?`)
  questions.push("这类缺陷的验收标准是什么?")
  return questions.slice(0, 3)
}

export function ChatContextBanner({ taskId, task, onAsk }) {
  const hasTask = taskId !== undefined && taskId !== null
  const defects = countDefects(task)
  const presets = hasTask ? buildPresetQuestions(defects) : []

  if (!hasTask) {
    return (
      <section aria-label="聊天上下文" className="context-banner">
        <div className="context-banner__icon">
          <Orbit size={16} />
        </div>
        <span>通用对话</span>
      </section>
    )
  }

  return (
    <section aria-label="当前任务缺陷摘要" className="context-card">
      <div className="context-card__row">
        <div className="context-banner__icon">
          <Link2 size={16} />
        </div>
        <span>关联任务 #{taskId}</span>
      </div>
      <h2 className="context-card__title">当前任务缺陷摘要</h2>
      {defects.length > 0 ? (
        <ul className="context-card__defects">
          {defects.map((defect) => (
            <li key={defect.cls}>
              {defect.name} {defect.count}
            </li>
          ))}
        </ul>
      ) : (
        <p className="context-card__empty">暂无结构化检出，仍可带着任务上下文追问。</p>
      )}
      <div className="context-card__presets">
        {presets.map((question) => (
          <button
            key={question}
            className="context-card__preset"
            type="button"
            onClick={() => onAsk?.(question)}
          >
            {question}
          </button>
        ))}
      </div>
    </section>
  )
}
