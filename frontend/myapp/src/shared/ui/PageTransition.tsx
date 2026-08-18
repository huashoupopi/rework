import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { cn, tokenDurationSeconds } from "@/shared/lib/utils"

type PageTransitionProps = {
  children: React.ReactNode
  className?: string
}

export function PageTransition({ children, className }: PageTransitionProps) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className={cn("page-transition", className)}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
      transition={{
        duration: tokenDurationSeconds(reduceMotion ? "--motion-fast" : "--motion-slow", 220),
      }}
    >
      {children}
    </motion.div>
  )
}
