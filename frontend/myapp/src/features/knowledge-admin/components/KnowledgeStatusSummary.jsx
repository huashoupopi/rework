import * as React from "react"
import { Button, Card, List, Space, Statistic, Tag, Typography } from "antd"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function KnowledgeStatusSummary({
  actionLoading = false,
  actionMessage = "",
  loading = false,
  onRefresh,
  onTriggerFull,
  onTriggerIncremental,
  status,
}) {
  const documents = Array.isArray(status?.documents) ? status.documents : []

  return (
    <GlassPanel aria-label="知识库重建状态" className="data-surface">
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text type="secondary">索引状态与重建任务的实时概览。</Typography.Text>
          <Space wrap>
            <Button disabled={loading} type="default" onClick={onRefresh}>
              刷新状态
            </Button>
            <Button disabled={actionLoading} type="primary" onClick={onTriggerFull}>
              全量重建
            </Button>
            <Button disabled={actionLoading} onClick={onTriggerIncremental}>
              增量重建
            </Button>
          </Space>
        </Space>
        <div className="status-grid">
          <Card size="small">
            <Statistic title="文档总数" value={status?.total_documents ?? 0} />
          </Card>
          <Card size="small">
            <Statistic title="已索引" value={status?.indexed ?? 0} />
          </Card>
          <Card size="small">
            <Statistic title="待处理" value={status?.pending ?? 0} />
          </Card>
          <Card size="small">
            <Statistic title="失败" value={status?.failed ?? 0} />
          </Card>
          <Card size="small">
            <Statistic title="重建执行中" value={status?.rebuild_running ? "是" : "否"} />
          </Card>
        </div>
        {actionMessage ? <Typography.Text type="secondary">{actionMessage}</Typography.Text> : null}
        <Card size="small" title="文档状态">
          <List
            dataSource={documents}
            locale={{
              emptyText: "暂无文档状态",
            }}
            renderItem={(document) => (
              <List.Item key={document.doc_key}>
                <Space>
                  <span>{document.title}</span>
                  <Tag color={document.index_status === "indexed" ? "green" : "gold"}>
                    {document.index_status ?? "-"}
                  </Tag>
                </Space>
              </List.Item>
            )}
            size="small"
          />
        </Card>
      </Space>
    </GlassPanel>
  )
}
