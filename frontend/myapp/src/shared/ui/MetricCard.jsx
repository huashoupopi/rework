import * as React from "react"

import { SlidingNumber } from "@/shared/ui/motion-primitives/sliding-number"
import { Spotlight } from "@/shared/ui/motion-primitives/spotlight"

import { GlassPanel } from "./GlassPanel"

export function MetricCard({ eyebrow, title, value, description, icon }) {
  return (
    <GlassPanel className="metric-card">
      <Spotlight className="from-[rgba(77,141,255,0.18)] via-[rgba(77,141,255,0.06)] to-transparent" size={200} />
      <div className="metric-card__header">
        {icon ? <div className="metric-card__icon">{icon}</div> : null}
        {eyebrow ? <p className="metric-card__eyebrow">{eyebrow}</p> : null}
      </div>
      <strong className="metric-card__value">
        {typeof value === "number" ? <SlidingNumber value={value} /> : value}
      </strong>
      <h2 className="metric-card__title">{title}</h2>
      {description ? <p className="metric-card__description">{description}</p> : null}
    </GlassPanel>
  )
}
