import * as React from "react"


export function PageWorkband({
  actions,
  aside,
  className = "",
  compact = false,
  description,
  eyebrow,
  footer,
  supporting,
  title,
}) {
  const classes = ["page-workband", compact ? "page-workband--compact" : "", className]
    .filter(Boolean)
    .join(" ")

  return (
    <header className={classes}>
      <div className="page-workband__main">
        <div className="page-workband__copy">
          {eyebrow ? <p className="page-workband__eyebrow">{eyebrow}</p> : null}
          {/* 原本 string 分支要套 LineShadowText 做描边阴影，去掉后两个分支等价 */}
          <h1>{title}</h1>
          {description ? <p className="page-workband__description">{description}</p> : null}
          {supporting ? <p className="page-workband__supporting">{supporting}</p> : null}
        </div>
        {actions ? <div className="page-workband__actions">{actions}</div> : null}
      </div>
      {aside ? <aside className="page-workband__aside">{aside}</aside> : null}
      {footer ? <div className="page-workband__footer">{footer}</div> : null}
    </header>
  )
}
