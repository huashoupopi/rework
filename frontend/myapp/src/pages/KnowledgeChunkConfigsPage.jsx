import * as React from "react"
import { ChunkConfigFormModal } from "@/features/knowledge-admin/components/ChunkConfigFormModal"
import { ChunkConfigTable } from "@/features/knowledge-admin/components/ChunkConfigTable"
import { useChunkConfigs } from "@/features/knowledge-admin/hooks/useChunkConfigs"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

export function KnowledgeChunkConfigsPage() {
  const { configs, createConfig, deleteConfig, error, updateConfig } = useChunkConfigs()
  const [dialogMode, setDialogMode] = React.useState("create")
  const [editingConfig, setEditingConfig] = React.useState(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  const handleCreate = () => {
    setDialogMode("create")
    setEditingConfig(null)
    setDialogOpen(true)
  }

  const handleEdit = (config) => {
    setDialogMode("edit")
    setEditingConfig(config)
    setDialogOpen(true)
  }

  const handleSubmit = async (payload) => {
    if (dialogMode === "edit" && editingConfig) {
      await updateConfig(editingConfig.id, payload)
    } else {
      await createConfig(payload)
    }

    setDialogOpen(false)
  }

  return (
    <div className="page-stack">
      <PageWorkband
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "配置数量", value: `${configs.length} 套` },
              { label: "目标", value: "质量 / 召回率" },
            ]}
            label="策略摘要"
            title="分块配置"
          />
        }
        compact
        description="维护分块参数，平衡入库质量与检索召回率。"
        eyebrow="切分策略"
        title="分块配置"
      />
      {error ? <p role="alert">{error.message}</p> : null}
      <ChunkConfigTable configs={configs} onCreate={handleCreate} onDelete={deleteConfig} onEdit={handleEdit} />
      <ChunkConfigFormModal
        initialValues={editingConfig}
        mode={dialogMode}
        open={dialogOpen}
        onCancel={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
      />
    </div>
  )
}
