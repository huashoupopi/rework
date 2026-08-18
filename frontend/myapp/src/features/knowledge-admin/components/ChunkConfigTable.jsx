import * as React from "react"
import { Button, Space, Table } from "antd"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function ChunkConfigTable({ configs = [], onCreate, onDelete, onEdit }) {
  const columns = [
    {
      dataIndex: "name",
      title: "名称",
    },
    {
      dataIndex: "chunk_size",
      title: "Chunk Size",
    },
    {
      dataIndex: "chunk_overlap",
      title: "Chunk Overlap",
    },
    {
      key: "actions",
      title: "操作",
      render: (_, config) => (
        <Space size="small">
          <Button type="link" onClick={() => onEdit?.(config)}>
            编辑 {config.name}
          </Button>
          <Button danger type="link" onClick={() => onDelete?.(config.id)}>
            删除 {config.name}
          </Button>
        </Space>
      ),
    },
  ]

  return (
    <GlassPanel aria-label="分块配置表格" className="data-surface">
      <div className="data-surface__toolbar">
        <div>
          <p className="data-surface__eyebrow">Chunk 策略</p>
          <h2>分块配置列表</h2>
        </div>
        <Button className="primary-action" type="primary" onClick={onCreate}>
          新建配置
        </Button>
      </div>
      <Table
        columns={columns}
        dataSource={configs.map((config) => ({
          ...config,
          key: config.id,
        }))}
        locale={{
          emptyText: "暂无分块配置",
        }}
        pagination={false}
        rowKey="id"
        size="middle"
      />
    </GlassPanel>
  )
}
