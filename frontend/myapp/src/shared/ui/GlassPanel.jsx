import * as React from "react"

import { GlassCard } from "./GlassCard"

/** @deprecated Use GlassCard. Kept as a forwarding shell so existing pages stay stable. */
export const GlassPanel = React.forwardRef(function GlassPanel(props, ref) {
  return <GlassCard ref={ref} {...props} />
})
