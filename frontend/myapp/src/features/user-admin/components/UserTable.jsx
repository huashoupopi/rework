import * as React from "react"
import { Button, Space, Table, Tag } from "antd"
import { ProgressiveBlur } from "@/shared/ui/motion-primitives/progressive-blur"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function UserTable({ currentUserId, onDeleteUser, users = [] }) {
  const columns = [
    {
      dataIndex: "id",
      title: "ID",
    },
    {
      dataIndex: "username",
      title: "用户名",
    },
    {
      dataIndex: "full_name",
      title: "姓名",
      render: (_, user) => user.full_name ?? "-",
    },
    {
      dataIndex: "is_superuser",
      title: "角色",
      render: (_, user) => <Tag color={user.is_superuser ? "gold" : "blue"}>{user.is_superuser ? "管理员" : "普通用户"}</Tag>,
    },
    {
      key: "actions",
      title: "操作",
      render: (_, user) => {
        const isSelf = user.id === currentUserId

        return isSelf ? (
          <Button disabled type="default">
            不可删除自己
          </Button>
        ) : (
          <Space size="small">
            <Button danger type="link" onClick={() => onDeleteUser?.(user.id)}>
              删除 {user.username}
            </Button>
          </Space>
        )
      },
    },
  ]

  return (
    <GlassPanel aria-label="用户表格" className="data-surface">
      <div className="data-surface__toolbar">
        <div>
          <p className="data-surface__eyebrow">账号列表</p>
          <h2>系统用户</h2>
        </div>
      </div>
      <div className="table-fade">
        <ProgressiveBlur blurIntensity={0.2} className="table-fade__blur table-fade__blur--bottom" direction="bottom" />
        <Table
        columns={columns}
        dataSource={users.map((user) => ({
          ...user,
          key: user.id,
        }))}
        locale={{
          emptyText: "暂无用户",
        }}
        pagination={false}
        rowKey="id"
        size="middle"
      />
      </div>
    </GlassPanel>
  )
}
