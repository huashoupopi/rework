import * as React from "react"
import { Link } from "react-router-dom"

import { BackgroundPaths } from "@/shared/ui/BackgroundPaths"
import { GlassCard } from "@/shared/ui/GlassCard"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

export function NotFoundPage() {
  return (
    <main className="not-found-page">
      <BackgroundPaths />
      <GlassCard className="not-found-card">
        <WindTurbineSvg sign="停机检修中" spinning={false} stopped />
        <h1>线路不通</h1>
        <p>这条线路暂时不通。风机挂了牌子，先回工作台。</p>
        <Link to="/">
          <button className="primary-action" type="button">返回首页</button>
        </Link>
      </GlassCard>
    </main>
  )
}
