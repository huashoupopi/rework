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
export function AuthScene({
  boost = false,
  children,
  description,
  titleLines,
  spinning = true,
  stopped = false,
}) {
  // 彩蛋：点风机让它加速转几圈。外部传进来的 boost（登录成功/密码错误）
  // 与这里的点击取或，两个来源互不干扰。
  const [clickBoost, setClickBoost] = React.useState(false)
  const timerRef = React.useRef(null)

  React.useEffect(() => () => window.clearTimeout(timerRef.current), [])

  function handleSpin() {
    window.clearTimeout(timerRef.current)
    setClickBoost(true)
    timerRef.current = window.setTimeout(() => setClickBoost(false), 2600)
  }

  const spinFast = boost || clickBoost

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
            </div>
          </InView>
        </section>
        {children}
      </div>
      <button
        aria-label="让风机转快一点"
        className="auth-page__turbine"
        onClick={handleSpin}
        title="点一下试试"
        type="button"
      >
        <React.Suspense fallback={<WindTurbineSvg boost={spinFast} spinning={spinning} stopped={stopped} />}>
          <WindTurbine3D boost={spinFast} spinning={spinning} stopped={stopped} />
        </React.Suspense>
      </button>
    </div>
  )
}
