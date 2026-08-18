import * as React from "react"
import { PageWorkband } from "./PageWorkband"

export function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <PageWorkband
      actions={actions}
      compact
      description={description}
      eyebrow={eyebrow}
      title={title}
    />
  )
}
