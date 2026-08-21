import * as React from "react"
import { UserTable } from "@/features/user-admin/components/UserTable"
import { useUserAdmin } from "@/features/user-admin/hooks/useUserAdmin"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

export function UsersPage() {
  const { currentUserId, deleteUserById, error, loading, refresh, users } = useUserAdmin()

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <button className="secondary-action" disabled={loading} type="button" onClick={refresh}>
            刷新
          </button>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "当前用户", value: String(currentUserId ?? "-") },
              { label: "账号数量", value: `${users.length} 个` },
            ]}
            label="治理摘要"
            title="用户治理区"
          />
        }
        compact
        description="查看用户角色与权限，管理账号生命周期。"
        eyebrow="系统管理"
        title="用户管理"
      />
      {error ? <p role="alert">{error.message}</p> : null}
      <UserTable currentUserId={currentUserId} onDeleteUser={deleteUserById} users={users} />
    </div>
  )
}
