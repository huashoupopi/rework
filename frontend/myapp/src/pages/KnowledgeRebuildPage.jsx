import * as React from "react"
import { KnowledgeStatusSummary } from "@/features/knowledge-admin/components/KnowledgeStatusSummary"
import { useKnowledgeStatus } from "@/features/knowledge-admin/hooks/useKnowledgeStatus"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

export function KnowledgeRebuildPage() {
  const {
    actionLoading,
    actionMessage,
    error,
    loading,
    refresh,
    status,
    triggerFullRebuild,
    triggerIncrementalRebuild,
  } = useKnowledgeStatus()

  return (
    <div className="page-stack">
      <PageWorkband
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "任务状态", value: status?.rebuild_running ? "执行中" : "空闲" },
              { label: "索引路线", value: "增量 / 全量" },
            ]}
            label="重建态势"
            title="知识库重建"
          />
        }
        compact
        description="查看索引状态，触发全量或增量重建。"
        eyebrow="索引维护"
        title="知识库重建"
      />
      {error ? <p role="alert">{error.message}</p> : null}
      <KnowledgeStatusSummary
        actionLoading={actionLoading}
        actionMessage={actionMessage}
        loading={loading}
        onRefresh={refresh}
        onTriggerFull={() => triggerFullRebuild()}
        onTriggerIncremental={() => triggerIncrementalRebuild()}
        status={status}
      />
    </div>
  )
}
