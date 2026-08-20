import * as React from "react"
import { Link, useParams } from "react-router-dom"
import { Bot, RefreshCw } from "lucide-react"

import { exportTask } from "@/features/task-center/api/task-api"
import { extractErrorMessage } from "@/shared/api/http"
import { taskStatusName } from "@/shared/lib/labels"
import { TaskImagePreview } from "@/features/task-center/components/TaskImagePreview"
import { TaskResultSummary } from "@/features/task-center/components/TaskResultSummary"
import { useTaskDetail } from "@/features/task-center/hooks/useTaskDetail"
import { AnimatedShinyText } from "@/shared/ui/magicui/animated-shiny-text"
import { RippleButton } from "@/shared/ui/magicui/ripple-button"
import { InView } from "@/shared/ui/motion-primitives/in-view"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

function getErrorMessage(error) {
  return extractErrorMessage(error, "加载失败，请重试")
}

export function TaskDetailPage() {
  const { taskId } = useParams()
  const { download, error, loading, refresh, task } = useTaskDetail(taskId)
  const currentTaskId = Number(taskId)
  const resolvedTaskId = Number.isFinite(currentTaskId) ? currentTaskId : taskId
  const activeTask = task?.id === currentTaskId ? task : null

  return (
    <main className="page-stack">
      <PageWorkband
        actions={
          <Link className="secondary-action" to={`/chat?taskId=${resolvedTaskId}`}>
            <Bot size={16} />
            关联问答
          </Link>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "状态", value: taskStatusName(activeTask?.status) || "加载中" },
              { label: "图片", value: activeTask?.file_name ?? `任务 #${resolvedTaskId}` },
            ]}
            label={`任务 #${resolvedTaskId}`}
            title="检测分析面板"
          />
        }
        compact
        eyebrow={`任务 #${resolvedTaskId}`}
        title="任务详情"
      />

      <div className="task-detail-layout">
        <GlassPanel className="task-detail-stage">
          <div className="task-detail-stage__meta">
            <h2>{`任务 #${resolvedTaskId}`}</h2>
            <p>查看原图预览、检测标框，并进入关联问答进行深度分析。</p>
          </div>
          <TaskImagePreview task={activeTask} />
        </GlassPanel>

        <GlassPanel className="task-detail-analysis">
          {loading && !activeTask ? <AnimatedShinyText>加载中...</AnimatedShinyText> : null}
          {error ? (
            <div className="task-detail-error" role="alert">
              <p>{getErrorMessage(error)}</p>
              <RippleButton className="secondary-action border-0" onClick={refresh} rippleColor="rgba(77,141,255,0.28)" type="button">
                <RefreshCw size={14} />
                重试
              </RippleButton>
            </div>
          ) : null}
          {activeTask ? (
            <InView once>
              <TaskResultSummary
                onDownload={activeTask.status === "completed" ? download : undefined}
                onExportCsv={
                  activeTask.status === "completed"
                    ? () => exportTask(activeTask.id, "csv")
                    : undefined
                }
                onExportJson={
                  activeTask.status === "completed"
                    ? () => exportTask(activeTask.id, "json")
                    : undefined
                }
                task={activeTask}
              />
            </InView>
          ) : null}
        </GlassPanel>
      </div>
    </main>
  )
}
