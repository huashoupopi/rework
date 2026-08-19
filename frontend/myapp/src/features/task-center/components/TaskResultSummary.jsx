import * as React from "react"

function formatObjectLabel(object, index) {
  return object?.class ?? `对象 ${index + 1}`
}

function formatStatus(status) {
  if (status === "completed") {
    return "任务已完成"
  }

  if (status === "progressing" || status === "pending") {
    return "任务处理中"
  }

  if (status === "failed") {
    return "任务处理失败"
  }

  return status ?? "未知状态"
}

export function TaskResultSummary({ onDownload, onExportJson, onExportCsv, task }) {
  if (!task) {
    return null
  }

  const detectResult = task.detect_result
  const objects = Array.isArray(detectResult?.objects) ? detectResult.objects : []
  const total = typeof detectResult?.total === "number" ? detectResult.total : null

  return (
    <section aria-label="任务结果摘要" className="task-summary">
      <div className="task-summary__hero">
        <div>
          <p className="page-header__eyebrow">检测摘要</p>
          <h2>结果概览</h2>
        </div>
        {task.status === "failed" ? (
          <p className="task-summary__status task-summary__status--error" role="alert">
            {formatStatus(task.status)}
          </p>
        ) : (
          <p className="task-summary__status">{formatStatus(task.status)}</p>
        )}
      </div>
      {task.status === "completed" ? (
        <div className="task-summary__grid">
          <div className="task-summary__metric">
            <span>识别结果</span>
            <strong>{total === null ? "-" : `发现 ${total} 处目标`}</strong>
          </div>
          <div className="task-summary__metric">
            <span>结构化对象</span>
            <strong>{`对象 ${objects.length} 个`}</strong>
          </div>
          {objects.length > 0 ? (
            <ul className="task-summary__objects">
              {objects.map((object, index) => (
                <li key={`${formatObjectLabel(object, index)}-${index}`}>
                  {formatObjectLabel(object, index)}
                  {typeof object?.confidence === "number" ? ` · 置信度 ${object.confidence}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          {onDownload || onExportJson || onExportCsv ? (
            <div className="task-summary__actions">
              {onDownload ? (
                <button type="button" onClick={onDownload}>
                  下载单张
                </button>
              ) : null}
              {onExportJson ? (
                <button type="button" onClick={onExportJson}>
                  导出 JSON
                </button>
              ) : null}
              {onExportCsv ? (
                <button type="button" onClick={onExportCsv}>
                  导出 CSV
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {task.status === "pending" || task.status === "progressing" ? (
        <p className="task-summary__hint">任务仍在处理中，页面会继续轮询。</p>
      ) : null}
    </section>
  )
}
