import * as React from "react"
import { TaskFilters } from "@/features/task-center/components/TaskFilters"
import { TaskTable, DEFECT_COLORS, DEFECT_NAMES } from "@/features/task-center/components/TaskTable"
import { TaskUploadCard } from "@/features/task-center/components/TaskUploadCard"
import { useTaskList } from "@/features/task-center/hooks/useTaskList"
import { Bug, CircleCheckBig, Filter, Layers3, TrendingUp, Users } from "lucide-react"

import { MetricCard } from "@/shared/ui/MetricCard"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"
import { GlassPanel } from "@/shared/ui/GlassPanel"

const DEFAULT_FILTERS = {
  fileName: "",
  status: "all",
}

export function TaskCenterPage() {
  const { page, pageSize, refresh, setPage, setPageSize, tasks, total } = useTaskList()
  const [filters, setFilters] = React.useState(DEFAULT_FILTERS)

  const keyword = filters.fileName.trim().toLowerCase()
  const status = filters.status
  const hasActiveFilters = keyword !== "" || status !== "all"
  const completedCount = tasks.filter((task) => task.status === "completed").length
  const completionRate = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0

  // 聚合缺陷统计
  const defectStats = React.useMemo(() => {
    const stats = {}
    let totalDefects = 0
    const owners = new Set()

    for (const task of tasks) {
      if (task.owner?.username) {
        owners.add(task.owner.username)
      }
      if (!task.detect_result?.objects?.length) continue
      for (const obj of task.detect_result.objects) {
        const cls = obj.class || "unknown"
        if (!stats[cls]) {
          stats[cls] = { count: 0, totalConf: 0 }
        }
        stats[cls].count += 1
        stats[cls].totalConf += (obj.confidence ?? 0)
        totalDefects += 1
      }
    }

    const ranked = Object.entries(stats)
      .map(([cls, { count, totalConf }]) => ({
        cls,
        count,
        avgConf: Math.round((totalConf / count) * 100),
        pct: totalDefects > 0 ? Math.round((count / totalDefects) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)

    return { ranked, totalDefects, ownerCount: owners.size }
  }, [tasks])

  const filteredTasks = tasks.filter((task) => {
    const fileName = String(task.file_name ?? "").toLowerCase()
    const matchesKeyword = keyword === "" || fileName.includes(keyword)
    const matchesStatus = status === "all" || task.status === status

    return matchesKeyword && matchesStatus
  })

  const handlePageChange = (nextPage) => {
    setPage(nextPage)
  }

  const handlePageSizeChange = (nextPageSize) => {
    setPage(1)
    setPageSize(nextPageSize)
  }

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <button className="secondary-action" type="button" onClick={refresh}>
            刷新任务列表
          </button>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "完成", value: `${completedCount} 条` },
              { label: "筛选", value: hasActiveFilters ? `${filteredTasks.length}/${tasks.length}` : "关闭" },
            ]}
            label="当前批次"
            title={`${total} 条任务`}
          />
        }
        className="page-workband--operations"
        description={`已加载 ${tasks.length} 条任务，当前页完成 ${completedCount} 条。`}
        eyebrow="检测任务"
        footer={
          <section className="metrics-grid metrics-grid--5" aria-label="任务概览">
            <MetricCard
              eyebrow="当前页"
              icon={<Layers3 size={18} />}
              title="已加载"
              value={tasks.length}
            />
            <MetricCard
              eyebrow="已完成"
              icon={<CircleCheckBig size={18} />}
              title="检测完成"
              value={completedCount}
            />
            <MetricCard
              eyebrow="完成率"
              icon={<TrendingUp size={18} />}
              title="完成进度"
              value={`${completionRate}%`}
            />
            <MetricCard
              eyebrow="缺陷总数"
              icon={<Bug size={18} />}
              title="检出缺陷"
              value={defectStats.totalDefects}
            />
            <MetricCard
              eyebrow="检测人员"
              icon={<Users size={18} />}
              title="参与人数"
              value={defectStats.ownerCount}
            />
          </section>
        }
        title="任务中心"
      />

      <TaskUploadCard onUploaded={refresh} />

      {defectStats.ranked.length > 0 && (
        <GlassPanel className="defect-stats-panel">
          <div className="defect-stats-panel__header">
            <div>
              <p className="defect-stats-panel__eyebrow">缺陷分析</p>
              <h2>缺陷类别分布</h2>
            </div>
            <p className="defect-stats-panel__summary">
              共检出 <strong>{defectStats.totalDefects}</strong> 个缺陷，涵盖 <strong>{defectStats.ranked.length}</strong> 个类别
            </p>
          </div>

          <div className="defect-stats-panel__completion">
            <div className="defect-stats-panel__completion-label">
              <span>检测完成率</span>
              <span className="defect-stats-panel__completion-value">{completionRate}%</span>
            </div>
            <div className="progress-bar progress-bar--lg">
              <div
                className="progress-bar__fill progress-bar__fill--accent"
                style={{ width: `${completionRate}%` }}
              />
            </div>
          </div>

          <ul className="defect-rank-list">
            {defectStats.ranked.map(({ cls, count, avgConf, pct }) => (
              <li className="defect-rank-item" key={cls}>
                <div className="defect-rank-item__head">
                  <span
                    className="defect-rank-item__dot"
                    style={{ background: DEFECT_COLORS[cls] || "#999" }}
                  />
                  <span className="defect-rank-item__name">{DEFECT_NAMES[cls] || cls}</span>
                  <span className="defect-rank-item__count">{count} 个</span>
                  <span className="defect-rank-item__pct">{pct}%</span>
                </div>
                <div className="defect-rank-item__bars">
                  <div className="progress-bar">
                    <div
                      className="progress-bar__fill"
                      style={{ width: `${pct}%`, background: DEFECT_COLORS[cls] || "#999" }}
                    />
                  </div>
                  <span
                    className={`defect-rank-item__conf ${
                      avgConf >= 75 ? "defect-rank-item__conf--good" :
                      avgConf >= 65 ? "defect-rank-item__conf--mid" :
                      "defect-rank-item__conf--low"
                    }`}
                  >
                    置信度 {avgConf}%
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      <GlassPanel className="toolbar-surface">
        <TaskFilters filters={filters} onFiltersChange={setFilters} onRefresh={refresh} />
        {hasActiveFilters ? <p className="toolbar-surface__summary">筛选结果：{filteredTasks.length} / {tasks.length}</p> : null}
      </GlassPanel>

      <TaskTable
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        page={page}
        pageSize={pageSize}
        tasks={filteredTasks}
        total={total}
      />
    </div>
  )
}
