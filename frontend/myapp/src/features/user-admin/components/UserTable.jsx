import * as React from "react"
import { Popconfirm, Table, Tag } from "antd"
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

        // 删账号不可逆，且删的是别人 —— 确认框里必须带上用户名与角色，
        // 光一句「确认删除？」看不出删的是谁。原先点一下就直接删了。
        return isSelf ? (
          <span className="table-hint">当前登录账号</span>
        ) : (
          <Popconfirm
            cancelText="取消"
            description={`${user.full_name || user.username} · ${user.is_superuser ? "管理员" : "普通用户"}`}
            okButtonProps={{ danger: true }}
            okText="删除"
            onConfirm={() => onDeleteUser?.(user.id)}
            title={`删除账号 ${user.username}？`}
          >
            <button className="table-btn table-btn--danger" type="button">
              删除
            </button>
          </Popconfirm>
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
