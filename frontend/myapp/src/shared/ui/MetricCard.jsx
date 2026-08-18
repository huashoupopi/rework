import * as React from "react"

import { GlassPanel } from "./GlassPanel"

export function MetricCard({ eyebrow, title, value, description, icon }) {
  return (
    <GlassPanel className="metric-card">
      <div className="metric-card__header">
        {icon ? <div className="metric-card__icon">{icon}</div> : null}
        {eyebrow ? <p className="metric-card__eyebrow">{eyebrow}</p> : null}
      </div>
      <strong className="metric-card__value">{value}</strong>
      <h2 className="metric-card__title">{title}</h2>
      {description ? <p className="metric-card__description">{description}</p> : null}
    </GlassPanel>
  )
}
