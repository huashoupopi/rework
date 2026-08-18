import * as React from "react"

export function PageWorkbandInfoCard({ items, label, title }) {
  return (
    <div className="workband-info-card">
      <p className="workband-info-card__label">{label}</p>
      <strong className="workband-info-card__title">{title}</strong>
      {items?.length ? (
        <div className="workband-info-card__list">
          {items.map((item) => (
            <div className="workband-info-card__item" key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
