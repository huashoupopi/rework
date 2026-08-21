import * as React from "react"
import { documentStatusName } from "@/shared/lib/labels"
import { Popconfirm, Table, Tag, Typography } from "antd"
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
  // 2026-08-21 六列合成三列。原本「标题 / Doc Key」是同一份东西的两种写法，
  // 「当前版本 / 当前文件」也是 —— 六列各占一格，横向挤满却没多少信息。
  // 现在主行放文档名，副行放 doc_key 与版本、文件名，跟评测页跑批列同一个手法。
  const columns = [
    {
      dataIndex: "title",
      title: "文档",
      render: (_, document) => {
        const version =
          document?.latest_version === null || document?.latest_version === undefined
            ? null
            : `v${document.latest_version}`
        const file = document.current_version?.file_name
        const meta = [document.doc_key, version, file].filter(Boolean).join(" · ")
        return (
          <span className="doc-name">
            <strong className="doc-name__title">{document.title ?? document.doc_key ?? "-"}</strong>
            {meta ? <span className="doc-name__meta">{meta}</span> : null}
          </span>
        )
      },
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
      key: "actions",
      title: "操作",
      render: (_, document) => (
        <Popconfirm
          cancelText="取消"
          description="连同文件一起彻底删除，不可恢复。"
          okButtonProps={{ danger: true }}
          okText="删除"
          onConfirm={() => onDeleteDocument?.(document.doc_key, { physicalDelete: true })}
          title={`删除文档 ${document.title ?? document.doc_key}？`}
        >
          <button className="table-btn table-btn--danger" type="button">
            删除
          </button>
        </Popconfirm>
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
