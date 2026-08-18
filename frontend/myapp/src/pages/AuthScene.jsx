import * as React from "react"

import { isNightSkyHour } from "@/shared/lib/nightSky"
import { AuroraBackground } from "@/shared/ui/AuroraBackground"
import { StaggerList } from "@/shared/ui/StaggerList"
import { ShimmerText } from "@/shared/ui/ShimmerText"
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
  const night = isNightSkyHour()

  return (
    <AuroraBackground className="auth-page" night={night}>
      <div className="auth-stage">
        <section className="auth-hero">
          <p className="auth-hero__eyebrow">REWORK</p>
          <h1 className="auth-hero__title">
            <ShimmerText as="span" className="auth-hero__title-text">
              {titleLines.map((line) => (
                <span className="auth-hero__title-line" key={line}>
                  {line}
                </span>
              ))}
            </ShimmerText>
          </h1>
          <p className="auth-hero__description">{description}</p>
          <StaggerList className="auth-hero__panel">
            {METRICS.map((metric) => (
              <div className="auth-hero__metric" key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.title}</strong>
                <p>{metric.copy}</p>
              </div>
            ))}
          </StaggerList>
          <div className="auth-hero__turbine">
            <React.Suspense fallback={<WindTurbineSvg boost={boost} spinning={spinning} stopped={stopped} />}>
              <WindTurbine3D boost={boost} spinning={spinning} stopped={stopped} />
            </React.Suspense>
          </div>
        </section>
        {children}
      </div>
    </AuroraBackground>
  )
}
