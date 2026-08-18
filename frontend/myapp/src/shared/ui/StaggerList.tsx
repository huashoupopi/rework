import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { tokenDurationSeconds } from "@/shared/lib/utils"

type StaggerListProps = {
  children: React.ReactNode
  className?: string
}

export function StaggerList({ children, className }: StaggerListProps) {
  const reduceMotion = useReducedMotion()
  const step = tokenDurationSeconds("--stagger-step", 50)
  const duration = tokenDurationSeconds("--motion-base", 180)

  return (
    <div className={className}>
      {React.Children.map(children, (child, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
          key={index}
          transition={{
            delay: reduceMotion ? 0 : index * step,
            duration: reduceMotion ? tokenDurationSeconds("--motion-fast", 120) : duration,
          }}
        >
          {child}
        </motion.div>
      ))}
    </div>
  )
}
