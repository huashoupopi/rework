import * as React from "react"
import { documentStatusName } from "@/shared/lib/labels"
import { Button, Popconfirm, Space, Table, Tag, Typography } from "antd"
import { ProgressiveBlur } from "@/shared/ui/motion-primitives/progressive-blur"
import { GlassPanel } from "@/shared/ui/GlassPanel"

function formatVersion(document) {
  if (document?.latest_version === null || document?.latest_version === undefined) {
    return "-"
  }

  return `v${document.latest_version}`
}

function getStatusTagColor(status) {
  if (status === "active") {
    return "green"
  }

  if (status === "deleted") {
    return "default"
  }

  if (status === "failed" || status === "error") {
    return "red"
  }

  return "blue"
}

export function KnowledgeDocumentTable({
  documents = [],
  onDeleteDocument,
  onPageChange,
  onPageSizeChange,
  page = 1,
  pageSize = 10,
  total = 0,
}) {
  const columns = [
    {
      dataIndex: "title",
      title: "标题",
      render: (_, document) => document.title ?? "-",
    },
    {
      dataIndex: "doc_key",
      title: "Doc Key",
    },
    {
      dataIndex: "status",
      title: "状态",
      render: (_, document) => (
        <Tag color={getStatusTagColor(document.status)}>
          {documentStatusName(document.status) || "-"}
        </Tag>
      ),
    },
    {
      dataIndex: "latest_version",
      title: "当前版本",
      render: (_, document) => formatVersion(document),
    },
    {
      dataIndex: ["current_version", "file_name"],
      title: "当前文件",
      render: (_, document) => document.current_version?.file_name ?? "-",
    },
    {
      key: "actions",
      title: "操作",
      render: (_, document) => (
        <Space size="small">
          <Popconfirm
            title={`删除文档: ${document.title ?? document.doc_key}`}
            description="此操作将彻底删除文档及其文件，不可恢复。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onDeleteDocument?.(document.doc_key, { physicalDelete: true })}
          >
            <Button danger type="link">
              删除 {document.title ?? document.doc_key}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <GlassPanel aria-label="知识库文档表格" className="data-surface">
      <div className="data-surface__toolbar">
        <div>
          <p className="data-surface__eyebrow">文档列表</p>
          <h2>当前知识文档</h2>
          <Typography.Text type="secondary">按文档状态、版本和文件名快速定位入库结果。</Typography.Text>
        </div>
      </div>
      <div className="table-fade">
        <ProgressiveBlur blurIntensity={0.2} className="table-fade__blur table-fade__blur--bottom" direction="bottom" />
      <Table
        columns={columns}
        dataSource={documents.map((document) => ({
          ...document,
          key: document.doc_key,
        }))}
        locale={{
          emptyText: "暂无知识文档",
        }}
        pagination={{
          current: page,
          pageSize,
          showQuickJumper: true,
          showSizeChanger: true,
          showTotal: (currentTotal, range) => `第 ${range[0]}-${range[1]} 条 / 共 ${currentTotal} 条`,
          total,
          pageSizeOptions: ["10", "20", "50"],
          onChange: (nextPage, nextPageSize) => {
            if (nextPage !== page) {
              onPageChange?.(nextPage)
            }

            if (nextPageSize !== pageSize) {
              onPageSizeChange?.(nextPageSize)
            }
          },
        }}
        rowKey="doc_key"
        size="middle"
      />
      </div>
    </GlassPanel>
  )
}
