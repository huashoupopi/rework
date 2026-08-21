import * as React from "react"

/**
 * 叶片检测示意图 —— 登录页第一屏的图形锚点。
 *
 * 2026-08-21 用它替换掉原来的三行规格文案：登录页不需要解释产品，
 * 需要一眼说明「这是给风机叶片找缺陷的」。一张标注图比三段文字省字也更准。
 *
 * 画的是叶片翼型剖面 + 两个检测框 + 引线编号，是工程检测报告里的标注方式，
 * 不是装饰插画。纯 SVG，无外部依赖，颜色全走 CSS 变量。
 */
export function BladeScanDiagram({ className = "" }) {
  return (
    <svg
      aria-hidden="true"
      className={`blade-diagram ${className}`.trim()}
      fill="none"
      viewBox="0 0 620 210"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 基准线：制图里的中心轴 */}
      <line className="blade-diagram__axis" x1="16" x2="604" y1="118" y2="118" />

      {/* 叶片翼型剖面：根部厚、叶尖薄 */}
      <path
        className="blade-diagram__blade"
        d="M28 96 C120 74, 268 66, 392 84 C470 95, 536 108, 592 118 C536 128, 470 138, 392 148 C268 162, 120 156, 28 140 Z"
      />

      {/* 展向分隔：叶片分段检查的位置 */}
      {[150, 272, 394, 500].map((x) => (
        <line className="blade-diagram__rib" key={x} x1={x} x2={x} y1="80" y2="156" />
      ))}

      {/* 检测框 01：前缘腐蚀 */}
      <rect className="blade-diagram__box" height="42" rx="2" width="70" x="176" y="88" />
      <line className="blade-diagram__lead" x1="211" x2="211" y1="88" y2="52" />
      <text className="blade-diagram__tag" x="211" y="44">01</text>

      {/* 检测框 02：叶尖裂纹 */}
      <rect className="blade-diagram__box" height="30" rx="2" width="54" x="452" y="104" />
      <line className="blade-diagram__lead" x1="479" x2="479" y1="134" y2="172" />
      <text className="blade-diagram__tag" x="479" y="188">02</text>

      {/* 根部标记：图纸里的定位块 */}
      <rect className="blade-diagram__root" height="52" width="7" x="21" y="92" />
    </svg>
  )
}
