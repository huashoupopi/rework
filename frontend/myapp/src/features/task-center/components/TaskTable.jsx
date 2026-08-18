import * as React from "react"
import { Download, ListChecks } from "lucide-react"

import { downloadTaskBatch, downloadTaskImage } from "../api/task-api"
import { TaskStatusTag } from "./TaskStatusTag"
import { GlassPanel } from "@/shared/ui/GlassPanel"

function isCompleted(task) {
  return task?.status === "completed"
}

function formatCreatedAt(value) {
  if (!value) {
    return "-"
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }

  return date.toLocaleString("zh-CN", {
    hour12: false,
  })
}

export const DEFECT_COLORS = {
  corrosion: "#d35400",
  craze: "#ff4d4f",
  hide_craze: "#722ed1",
  surface_attach: "#1890ff",
  surface_corrosion: "#fa8c16",
  surface_eye: "#13c2c2",
  surface_injure: "#eb2f96",
  surface_oil: "#52c41a",
  thunderstrike: "#faad14",
}

export const DEFECT_NAMES = {
  corrosion: "腐蚀",
  craze: "裂纹",
  hide_craze: "隐裂",
  surface_attach: "附着物",
  surface_corrosion: "表面腐蚀",
  surface_eye: "气孔",
  surface_injure: "表面损伤",
  surface_oil: "油污",
  thunderstrike: "雷击",
}

function DetectSummary({ task }) {
  if (!task?.detect_result?.objects?.length) {
    return <span className="text-muted">{task?.detect_result?.total === 0 ? "未发现缺陷" : "-"}</span>
  }
  const typeCount = {}
  for (const obj of task.detect_result.objects) {
    const cls = obj.class || "unknown"
    typeCount[cls] = (typeCount[cls] || 0) + 1
  }
  return (
    <div className="defect-tags">
      {Object.entries(typeCount).map(([cls, count]) => (
        <span
          className="defect-tag"
          key={cls}
          style={{ "--tag-color": DEFECT_COLORS[cls] || "#999" }}
        >
          {DEFECT_NAMES[cls] || cls} {count}
        </span>
      ))}
    </div>
  )
}

function getTotalPages(total, pageSize) {
  if (pageSize <= 0) {
    return 1
  }

  return Math.max(1, Math.ceil(total / pageSize))
}

export function TaskTable({
  tasks = [],
  page = 1,
  pageSize = 10,
  total = 0,
  onPageChange,
  onPageSizeChange,
}) {
  const [selectedIds, setSelectedIds] = React.useState([])

  React.useEffect(() => {
    setSelectedIds((currentSelectedIds) =>
      currentSelectedIds.filter((taskId) => tasks.some((task) => task.id === taskId)),
    )
  }, [tasks])

  const selectedTasks = tasks.filter((task) => selectedIds.includes(task.id))
  const canBatchDownload = selectedTasks.length > 0 && selectedTasks.every(isCompleted)
  const totalPages = getTotalPages(total, pageSize)
  const canGoPrevious = typeof onPageChange === "function" && page > 1
  const canGoNext = typeof onPageChange === "function" && page < totalPages

  const toggleSelected = (taskId) => {
    setSelectedIds((currentSelectedIds) =>
      currentSelectedIds.includes(taskId)
        ? currentSelectedIds.filter((currentTaskId) => currentTaskId !== taskId)
        : [...currentSelectedIds, taskId],
    )
  }

  const handleBatchDownload = async () => {
    if (!canBatchDownload) {
      return
    }

    await downloadTaskBatch(selectedTasks.map((task) => task.id))
  }

  const handleSingleDownload = async (task) => {
    if (!isCompleted(task)) {
      return
    }

    await downloadTaskImage(task.id)
  }

  const handlePageSizeChange = (event) => {
    if (typeof onPageSizeChange !== "function") {
      return
    }

    const nextPageSize = Number(event.target.value)
    if (Number.isNaN(nextPageSize)) {
      return
    }

    onPageSizeChange(nextPageSize)
  }

  return (
    <GlassPanel aria-label="任务表格" className="data-surface">
      <div className="data-surface__toolbar">
        <div>
          <p className="data-surface__eyebrow">任务列表</p>
          <h2>检测任务总览</h2>
        </div>
        <div className="data-surface__actions">
          <p className="selection-pill">
            <ListChecks size={16} />
            <span>{`已选 ${selectedIds.length} 项`}</span>
          </p>
          <button className="secondary-action" disabled={!canBatchDownload} type="button" onClick={handleBatchDownload}>
            <Download size={16} />
            <span>批量下载</span>
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>文件名</th>
              <th>检测人</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>检测结果</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const completed = isCompleted(task)

              return (
                <tr key={task.id}>
                  <td>
                    <input
                      aria-label={`选择 ${task.file_name ?? task.id}`}
                      checked={selectedIds.includes(task.id)}
                      type="checkbox"
                      onChange={() => toggleSelected(task.id)}
                    />
                  </td>
                  <td>{task.file_name ?? "-"}</td>
                  <td>{task.owner?.username ?? "-"}</td>
                  <td>
                    <TaskStatusTag status={task.status} />
                  </td>
                  <td>{formatCreatedAt(task.created_at)}</td>
                  <td><DetectSummary task={task} /></td>
                  <td className="table-actions">
                    <a href={`/tasks/${task.id}`}>查看详情</a>
                    <button disabled={!completed} type="button" onClick={() => handleSingleDownload(task)}>
                      下载单张
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div aria-label="分页控制" className="pagination-bar">
        <button disabled={!canGoPrevious} type="button" onClick={() => onPageChange?.(page - 1)}>
          上一页
        </button>
        <span>
          第 {page} / {totalPages} 页
        </span>
        <button disabled={!canGoNext} type="button" onClick={() => onPageChange?.(page + 1)}>
          下一页
        </button>
        <label>
          每页条数
          <select aria-label="每页条数" value={pageSize} onChange={handlePageSizeChange}>
            {[10, 20, 50].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>
    </GlassPanel>
  )
}
