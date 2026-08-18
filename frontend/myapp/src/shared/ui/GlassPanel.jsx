import * as React from "react"

export const GlassPanel = React.forwardRef(function GlassPanel(
  { as = "section", children, className = "", ...props },
  ref,
) {
  return React.createElement(as, { ...props, ref, className: `glass-panel ${className}`.trim() }, children)
})
