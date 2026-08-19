import * as React from "react"

import { cn } from "@/shared/lib/utils"

type EmptyStateProps = {
  action?: React.ReactNode
  className?: string
  description?: string
  title: string
}

export function EmptyState({ action, className, description, title }: EmptyStateProps) {
  return (
    <div className={cn("empty-state", className)}>
      <svg aria-hidden className="empty-state__art" fill="none" viewBox="0 0 96 96">
        <rect fill="var(--surface-solid)" height="28" rx="4" width="10" x="43" y="52" />
        <rect fill="var(--accent)" height="10" rx="3" width="18" x="39" y="44" />
        <g stroke="var(--accent-strong)" strokeLinecap="round" strokeWidth="4">
          <path d="M48 46 L48 18" />
          <path d="M48 46 L72 58" />
          <path d="M48 46 L24 58" />
        </g>
      </svg>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  )
}
