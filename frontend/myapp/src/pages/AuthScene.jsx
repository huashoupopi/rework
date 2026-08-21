import * as React from "react"

import { tokenDurationSeconds } from "@/shared/lib/utils"
import { BladeScanDiagram } from "@/shared/ui/BladeScanDiagram"
import { InView } from "@/shared/ui/motion-primitives/in-view"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

const WindTurbine3D = React.lazy(() =>
  import("@/shared/ui/WindTurbine3D").then((module) => ({ default: module.WindTurbine3D })),
)

// 2026-08-21 两轮改动：
//   ① 三张等宽玻璃卡片 → 工程规格明细栏（卡片横排是 AI 模板的招牌构图）
//   ② 明细栏 → 一张检测示意图 + 一行能力标签（登录页第一屏字太多）
// 登录页不需要解释产品，一张标注图说得比三段文案清楚，也更符合工程图纸的表达。
const CAPABILITIES = ["缺陷识别", "上下文问答", "知识库治理"]

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
      <div className="auth-stage">
        <section className="auth-hero">
          <p className="auth-hero__eyebrow">REWORK / 风电运维</p>
          <h1 className="auth-hero__title">
            {titleLines.map((line) => (
              <span className="auth-hero__title-line" key={line}>
                {line}
              </span>
            ))}
          </h1>
          <p className="auth-hero__description">{description}</p>
          <InView
            once
            transition={{ duration: tokenDurationSeconds("--motion-slow", 180) }}
            variants={{
              hidden: { opacity: 0, y: 6 },
              visible: { opacity: 1, y: 0 },
            }}
          >
            <div className="auth-hero__diagram">
              <BladeScanDiagram />
              <ul className="cap-line">
                {CAPABILITIES.map((cap) => (
                  <li key={cap}>{cap}</li>
                ))}
              </ul>
            </div>
          </InView>
        </section>
        {children}
      </div>
      <div className="auth-page__turbine" aria-hidden="true">
        <React.Suspense fallback={<WindTurbineSvg boost={boost} spinning={spinning} stopped={stopped} />}>
          <WindTurbine3D boost={boost} spinning={spinning} stopped={stopped} />
        </React.Suspense>
      </div>
    </div>
  )
}
