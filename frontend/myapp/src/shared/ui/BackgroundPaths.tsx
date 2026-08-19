import * as React from "react"
import { motion, useReducedMotion } from "motion/react"

import { tokenDurationSeconds } from "@/shared/lib/utils"

const PATHS = [
  "M-40 80 C 80 10, 200 150, 360 40 S 640 160, 820 60",
  "M-20 160 C 120 40, 240 220, 420 90 S 700 210, 900 120",
  "M0 240 C 140 120, 280 280, 480 160 S 760 300, 980 200",
  "M-30 320 C 160 200, 300 360, 520 240 S 800 380, 1040 280",
  "M40 400 C 200 260, 360 440, 600 300 S 880 460, 1100 340",
]

export function BackgroundPaths() {
  const reduceMotion = useReducedMotion()
  const duration = tokenDurationSeconds("--motion-slow", 220) * 28

  return (
    <svg aria-hidden className="background-paths" fill="none" viewBox="0 0 1000 480">
      {PATHS.map((d, index) => (
        <motion.path
          animate={reduceMotion ? undefined : { pathLength: [0.2, 1, 0.35], opacity: [0.2, 0.55, 0.25] }}
          d={d}
          initial={{ pathLength: 0.35, opacity: 0.25 }}
          key={d}
          stroke="currentColor"
          strokeWidth="1.2"
          transition={
            reduceMotion
              ? { duration: 0 }
              : { delay: index * tokenDurationSeconds("--stagger-step", 50), duration, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY }
          }
        />
      ))}
    </svg>
  )
}
