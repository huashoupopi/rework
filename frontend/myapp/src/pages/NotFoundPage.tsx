import * as React from "react"
import { Link } from "react-router-dom"

import { BackgroundPaths } from "@/shared/ui/BackgroundPaths"
import { GlassButton } from "@/shared/ui/GlassButton"
import { GlassCard } from "@/shared/ui/GlassCard"
import { ShimmerText } from "@/shared/ui/ShimmerText"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

export function NotFoundPage() {
  return (
    <main className="not-found-page">
      <BackgroundPaths />
      <GlassCard className="not-found-card">
        <WindTurbineSvg sign="停机检修中" spinning={false} stopped />
        <ShimmerText as="h1">停机检修中</ShimmerText>
        <p>这条线路暂时不通。风机挂了牌子，先回工作台。</p>
        <Link to="/">
          <GlassButton type="button">返回首页</GlassButton>
        </Link>
      </GlassCard>
    </main>
  )
}
