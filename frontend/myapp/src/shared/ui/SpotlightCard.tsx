import * as React from "react"

import { cn } from "@/shared/lib/utils"

type SpotlightCardProps = React.HTMLAttributes<HTMLDivElement>

export function SpotlightCard({ children, className, onMouseMove, ...props }: SpotlightCardProps) {
  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty("--spot-x", `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty("--spot-y", `${event.clientY - rect.top}px`)
    onMouseMove?.(event)
  }

  return (
    <div className={cn("spotlight-card glass-panel", className)} onMouseMove={handleMouseMove} {...props}>
      {children}
    </div>
  )
}
