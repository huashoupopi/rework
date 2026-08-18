import * as React from "react"

import { cn } from "@/shared/lib/utils"

type GlassCardProps = React.HTMLAttributes<HTMLElement> & {
  as?: React.ElementType
}

export const GlassCard = React.forwardRef<HTMLElement, GlassCardProps>(function GlassCard(
  { as = "section", children, className = "", ...props },
  ref,
) {
  return React.createElement(
    as,
    { ...props, ref, className: cn("glass-panel", className) },
    children,
  )
})
