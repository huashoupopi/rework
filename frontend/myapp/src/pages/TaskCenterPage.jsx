import * as React from "react"
import { TaskFilters } from "@/features/task-center/components/TaskFilters"
import { TaskTable, DEFECT_COLORS, DEFECT_NAMES } from "@/features/task-center/components/TaskTable"
import { TaskUploadCard } from "@/features/task-center/components/TaskUploadCard"
import { useTaskList } from "@/features/task-center/hooks/useTaskList"
import { Bug, CircleCheckBig, Filter, Layers3, TrendingUp, Users } from "lucide-react"

import { InView } from "@/shared/ui/motion-primitives/in-view"
import { MetricCard } from "@/shared/ui/MetricCard"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function TaskCenterPage() {
  const {
    fileName,
    page,
    pageSize,
    refresh,
    setFileName,
    setPage,
    setPageSize,
    setStatus,
    status,
    statusCounts,
    tasks,
    total,
  } = useTaskList()

  // 筛选与统计都在服务端做。此前是前端对当前页做本地过滤 ——
  // 实测第 2 页共 6 条，筛「失败」得 5、筛「已完成」得 1，5+1 正好是这一页全部，
  // 说明根本没查全库；完成率也只按当前页算。
  const safeFileName = fileName ?? ""
  const safeStatus = status ?? ""

  const filters = React.useMemo(
    () => ({ fileName: safeFileName, status: safeStatus === "" ? "all" : safeStatus }),
    [safeFileName, safeStatus],
  )

  const handleFiltersChange = React.useCallback(
    (next) => {
      setStatus?.(next.status === "all" ? "" : next.status)
      setFileName?.(next.fileName ?? "")
    },
    [setFileName, setStatus],
  )

  const hasActiveFilters = safeFileName.trim() !== "" || safeStatus !== ""

  // 分母用全量分布之和，指标不随筛选与翻页漂移
  const allStatusTotal = React.useMemo(
    () => Object.values(statusCounts ?? {}).reduce((sum, n) => sum + n, 0),
    [statusCounts],
  )
  const completedCount = statusCounts?.completed ?? 0
  const completionRate =
    allStatusTotal > 0 ? Math.round((completedCount / allStatusTotal) * 100) : 0

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
              { label: "筛选", value: hasActiveFilters ? `命中 ${total} 条` : "关闭" },
            ]}
            label="当前批次"
            title={`${total} 条任务`}
          />
        }
        className="page-workband--operations"
        description={
          hasActiveFilters
            ? `筛选命中 ${total} 条，本页显示 ${tasks.length} 条。`
            : `共 ${total} 条任务，本页显示 ${tasks.length} 条，全部已完成 ${completedCount} 条。`
        }
        eyebrow="检测任务"
        footer={
          <InView once>
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
          </InView>
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
        <TaskFilters filters={filters} onFiltersChange={handleFiltersChange} onRefresh={refresh} />
        {hasActiveFilters ? (
          <p className="toolbar-surface__summary">筛选命中 {total} 条（全库）</p>
        ) : null}
      </GlassPanel>

      <TaskTable
        onPageChange={handlePageChange}
        onPageSizeChange={handlePageSizeChange}
        page={page}
        pageSize={pageSize}
        tasks={tasks}
        total={total}
      />
    </div>
  )
}
