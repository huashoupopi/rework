import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { cn, tokenDurationSeconds } from "@/shared/lib/utils"

type AuroraBackgroundProps = {
  children?: React.ReactNode
  className?: string
  night?: boolean
}

export function AuroraBackground({ children, className, night = false }: AuroraBackgroundProps) {
  const reduceMotion = useReducedMotion()
  const duration = tokenDurationSeconds("--motion-slow", 220) * 18

  return (
    <div className={cn("aurora-background", night && "aurora-background--night", className)} data-night={night ? "true" : "false"}>
      {reduceMotion ? (
        <div aria-hidden className="aurora-background__blob aurora-background__blob--static" />
      ) : (
        <motion.div
          animate={{ x: ["-8%", "10%", "-8%"], y: ["-6%", "8%", "-6%"] }}
          aria-hidden
          className="aurora-background__blob"
          transition={{ duration, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }}
        />
      )}
      <div className="aurora-background__content">{children}</div>
    </div>
  )
}
