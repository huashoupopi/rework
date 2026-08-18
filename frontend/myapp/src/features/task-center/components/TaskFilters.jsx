import * as React from "react"

const DEFAULT_FILTERS = {
  fileName: "",
  status: "all",
}

const STATUS_OPTIONS = [
  { label: "全部状态", value: "all" },
  { label: "已完成", value: "completed" },
  { label: "处理中", value: "progressing" },
  { label: "待处理", value: "pending" },
  { label: "失败", value: "failed" },
]

export function TaskFilters({ filters = DEFAULT_FILTERS, onFiltersChange, onRefresh }) {
  const currentFilters = {
    ...DEFAULT_FILTERS,
    ...filters,
  }

  const updateFilters = (nextFilters) => {
    onFiltersChange?.({
      ...currentFilters,
      ...nextFilters,
    })
  }

  return (
    <section aria-label="任务筛选" className="toolbar-panel">
      <label>
        文件名关键词
        <input
          aria-label="文件名关键词"
          value={currentFilters.fileName}
          onChange={(event) => updateFilters({ fileName: event.target.value })}
        />
      </label>
      <label>
        状态
        <select
          aria-label="状态"
          value={currentFilters.status}
          onChange={(event) => updateFilters({ status: event.target.value })}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={onRefresh}>
        刷新
      </button>
      <p className="toolbar-panel__hint">仅筛选当前页已加载任务，不跨页检索。</p>
    </section>
  )
}
