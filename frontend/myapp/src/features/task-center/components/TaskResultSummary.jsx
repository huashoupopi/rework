import * as React from "react"

import { DEFECT_COLORS, defectName } from "@/shared/lib/labels"

function formatObjectLabel(object, index) {
  return object?.class ? defectName(object.class) : `对象 ${index + 1}`
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
          {/* 2026-08-21 原本这里并排两个指标：「发现 N 处目标」与「对象 N 个」。
              它们说的是同一件事(total 与 objects.length)，而且数字都埋在句子里。
              现在只留一个大数，两者对不上时才单独提示 —— 那是数据不一致，
              不是两个指标。 */}
          <div className="detect-count">
            <span className="detect-count__num">{objects.length}</span>
            <span className="detect-count__unit">处缺陷</span>
            {total !== null && total !== objects.length ? (
              <span className="detect-count__mismatch">
                模型报告 {total} 处，结构化明细 {objects.length} 条
              </span>
            ) : null}
          </div>

          {objects.length > 0 ? (
            <ul className="defect-list">
              {objects.map((object, index) => {
                const conf = typeof object?.confidence === "number" ? object.confidence : null
                const pct = conf === null ? null : Math.round(conf * 100)
                const cls = object?.class
                return (
                  <li className="defect-list__row" key={`${formatObjectLabel(object, index)}-${index}`}>
                    <span
                      className="defect-list__dot"
                      style={{ background: (cls && DEFECT_COLORS[cls]) || "#7c6f64" }}
                    />
                    <span className="defect-list__name">{formatObjectLabel(object, index)}</span>
                    {pct === null ? (
                      <span className="defect-list__none">置信度未提供</span>
                    ) : (
                      <>
                        <span className="defect-list__track">
                          <span
                            className="defect-list__fill"
                            style={{
                              background: (cls && DEFECT_COLORS[cls]) || "#7c6f64",
                              width: `${pct}%`,
                            }}
                          />
                        </span>
                        {/* 原本直接打印 0.9231 这种原始浮点，读的人要自己换算 */}
                        <span className="defect-list__pct">{pct}%</span>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="task-summary__hint">这张图没有检出缺陷。</p>
          )}

          {onDownload || onExportJson || onExportCsv ? (
            <div className="task-summary__actions">
              {onDownload ? (
                <button className="table-btn" type="button" onClick={onDownload}>
                  下载单张
                </button>
              ) : null}
              {onExportJson ? (
                <button className="table-btn" type="button" onClick={onExportJson}>
                  导出 JSON
                </button>
              ) : null}
              {onExportCsv ? (
                <button className="table-btn" type="button" onClick={onExportCsv}>
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
