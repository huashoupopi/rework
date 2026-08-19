import * as React from "react"
import { useReducedMotion } from "motion/react"

import { tokenDurationSeconds } from "@/shared/lib/utils"

type AnimatedNumberProps = {
  className?: string
  value: number
}

export function AnimatedNumber({ className, value }: AnimatedNumberProps) {
  const reduceMotion = useReducedMotion()
  const [display, setDisplay] = React.useState(value)

  React.useEffect(() => {
    if (reduceMotion) {
      setDisplay(value)
      return
    }

    const durationMs = tokenDurationSeconds("--motion-slow", 220) * 1000 * 4
    const start = performance.now()
    const from = display
    let frame = 0

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs)
      setDisplay(Math.round(from + (value - from) * progress))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      }
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reduceMotion, value])

  return <span className={className}>{display}</span>
}
