import * as React from "react"

export function TaskStatusTag({ status }) {
  return <span data-status={status}>{status ?? "-"}</span>
}
