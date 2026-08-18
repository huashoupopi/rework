import * as React from "react"
import { Link } from "react-router-dom"

import { BackgroundPaths } from "@/shared/ui/BackgroundPaths"
import { DotPattern } from "@/shared/ui/magicui/dot-pattern"
import { InteractiveHoverButton } from "@/shared/ui/magicui/interactive-hover-button"
import { LineShadowText } from "@/shared/ui/magicui/line-shadow-text"
import { GlassCard } from "@/shared/ui/GlassCard"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

export function NotFoundPage() {
  return (
    <main className="not-found-page">
      <DotPattern className="auth-page__dots" cr={0.7} glow={false} height={22} width={22} />
      <BackgroundPaths />
      <GlassCard className="not-found-card">
        <WindTurbineSvg sign="停机检修中" spinning={false} stopped />
        <LineShadowText as="h1" shadowColor="rgba(77,141,255,0.28)">
          停机检修中
        </LineShadowText>
        <p>这条线路暂时不通。风机挂了牌子，先回工作台。</p>
        <Link to="/">
          <InteractiveHoverButton type="button">返回首页</InteractiveHoverButton>
        </Link>
      </GlassCard>
    </main>
  )
}
