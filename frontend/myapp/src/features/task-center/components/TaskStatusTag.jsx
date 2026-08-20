import * as React from "react"

import { taskStatusName } from "@/shared/lib/labels"

export function TaskStatusTag({ status }) {
  // data-status 保留英文原值 —— CSS 与测试按它选色，改中文会一起断
  return <span data-status={status}>{taskStatusName(status) || "-"}</span>
}
