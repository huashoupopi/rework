import * as React from "react"

/**
 * 指标格。
 *
 * 2026-08-21 两处改动：
 *   ① 去掉 SlidingNumber —— 它在浅底下渲染不出数字（本页五个指标里
 *      只有字符串型的「69%」显示得出来，三个 number 型全是空的）。
 *      工程界面的数字要能被对照读取，滚动动画反而妨碍这件事。
 *   ② 去掉 GlassPanel 卡片外壳与 Spotlight 光斑，改为线分隔的表格单元，
 *      与工作台的 .stat-row 是同一套语言。
 */
export function MetricCard({ eyebrow, title, value, description, icon }) {
  return (
    <div className="metric-cell">
      <div className="metric-cell__head">
        {icon ? <span className="metric-cell__icon">{icon}</span> : null}
        {eyebrow ? <span className="metric-cell__eyebrow">{eyebrow}</span> : null}
      </div>
      <strong className="metric-cell__value">{value}</strong>
      <span className="metric-cell__title">{title}</span>
      {description ? <p className="metric-cell__description">{description}</p> : null}
    </div>
  )
}
