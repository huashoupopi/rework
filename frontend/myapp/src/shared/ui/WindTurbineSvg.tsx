import * as React from "react"

import { cn } from "@/shared/lib/utils"

type WindTurbineSvgProps = {
  boost?: boolean
  className?: string
  sign?: string
  spinning?: boolean
  stopped?: boolean
}

export function WindTurbineSvg({
  boost = false,
  className,
  sign,
  spinning = true,
  stopped = false,
}: WindTurbineSvgProps) {
  return (
    <svg
      aria-hidden={sign ? undefined : true}
      className={cn("wind-turbine-svg", className)}
      data-boost={boost ? "true" : "false"}
      data-spinning={spinning ? "true" : "false"}
      data-stopped={stopped ? "true" : "false"}
      role={sign ? "img" : undefined}
      viewBox="0 0 120 170"
    >
      {sign ? <title>{sign}</title> : null}
      <rect fill="var(--surface-muted)" height="78" rx="4" width="10" x="55" y="78" />
      <rect fill="var(--surface-strong)" height="14" rx="3" width="22" x="49" y="68" />
      <g className="wind-turbine-svg__blades">
        <path d="M60 75 L64 14 L56 14 Z" fill="var(--accent)" />
        <path d="M60 75 L112 102 L106 108 Z" fill="var(--accent-strong)" />
        <path d="M60 75 L8 102 L14 108 Z" fill="var(--accent-strong)" />
      </g>
      <circle cx="60" cy="75" fill="var(--surface-strong)" r="5" />
      {sign ? (
        <g>
          <rect fill="var(--surface-solid)" height="22" rx="4" stroke="var(--accent)" width="72" x="24" y="4" />
          <text fill="var(--accent-strong)" fontSize="8" textAnchor="middle" x="60" y="18">
            {sign}
          </text>
        </g>
      ) : null}
    </svg>
  )
}
