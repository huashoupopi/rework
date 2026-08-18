import * as React from "react"

import { cn } from "@/shared/lib/utils"

type ShimmerTextProps = {
  as?: "h1" | "h2" | "h3" | "span"
  children: React.ReactNode
  className?: string
}

export function ShimmerText({ as = "span", children, className }: ShimmerTextProps) {
  return React.createElement(as, { className: cn("shimmer-text", className) }, children)
}
