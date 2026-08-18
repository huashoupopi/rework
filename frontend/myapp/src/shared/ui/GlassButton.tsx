import * as React from "react"

import { cn } from "@/shared/lib/utils"

type GlassButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>

export const GlassButton = React.forwardRef<HTMLButtonElement, GlassButtonProps>(
  function GlassButton({ className, type = "button", children, ...props }, ref) {
    return (
      <button ref={ref} className={cn("glass-button", className)} type={type} {...props}>
        {children}
      </button>
    )
  },
)
