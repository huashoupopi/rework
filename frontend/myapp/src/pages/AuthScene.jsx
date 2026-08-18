import * as React from "react"

import { tokenDurationSeconds } from "@/shared/lib/utils"
import { DotPattern } from "@/shared/ui/magicui/dot-pattern"
import { LineShadowText } from "@/shared/ui/magicui/line-shadow-text"
import { Ripple } from "@/shared/ui/magicui/ripple"
import { InView } from "@/shared/ui/motion-primitives/in-view"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

const WindTurbine3D = React.lazy(() =>
  import("@/shared/ui/WindTurbine3D").then((module) => ({ default: module.WindTurbine3D })),
)

const METRICS = [
  {
    label: "检测",
    title: "智能缺陷识别",
    copy: "上传图片即可获得自动化检测结果与结构化分析。",
  },
  {
    label: "问答",
    title: "上下文对话",
    copy: "围绕检测任务展开深度分析，获得精准回答。",
  },
  {
    label: "知识",
    title: "知识库治理",
    copy: "统一管理文档资产、索引构建与检索策略。",
  },
]

export function AuthScene({
  boost = false,
  children,
  description,
  titleLines,
  spinning = true,
  stopped = false,
}) {
  return (
    <div className="auth-page">
      <DotPattern className="auth-page__dots" cr={0.7} glow={false} height={22} width={22} />
      <div className="auth-stage">
        <section className="auth-hero">
          <p className="auth-hero__eyebrow">REWORK</p>
          <h1 className="auth-hero__title">
            {titleLines.map((line) => (
              <span className="auth-hero__title-line" key={line}>
                <LineShadowText as="span" shadowColor="rgba(77,141,255,0.28)">
                  {line}
                </LineShadowText>
              </span>
            ))}
          </h1>
          <p className="auth-hero__description">{description}</p>
          <InView
            once
            transition={{ duration: tokenDurationSeconds("--motion-slow", 220) }}
            variants={{
              hidden: { opacity: 0, y: 8 },
              visible: { opacity: 1, y: 0 },
            }}
          >
            <div className="auth-hero__panel">
              {METRICS.map((metric) => (
                <div className="auth-hero__metric" key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.title}</strong>
                  <p>{metric.copy}</p>
                </div>
              ))}
            </div>
          </InView>
          <div className="auth-hero__turbine">
            <Ripple className="auth-hero__ripple" mainCircleOpacity={0.08} mainCircleSize={180} numCircles={4} />
            <React.Suspense fallback={<WindTurbineSvg boost={boost} spinning={spinning} stopped={stopped} />}>
              <WindTurbine3D boost={boost} spinning={spinning} stopped={stopped} />
            </React.Suspense>
          </div>
        </section>
        {children}
      </div>
    </div>
  )
}
