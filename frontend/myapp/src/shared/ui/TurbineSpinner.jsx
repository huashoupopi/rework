import * as React from "react"

// 加载指示器用自家的三叶风机，而不是通用转圈 —— 和产品主题对上。
// 纯 SVG + CSS 旋转，无依赖；遵守 prefers-reduced-motion（批次 1 的彩蛋纪律②）。
export function TurbineSpinner({ className = "", size = 14, title = "生成中" }) {
  return (
    <svg
      aria-hidden={title ? undefined : "true"}
      className={`turbine-spinner ${className}`.trim()}
      fill="none"
      height={size}
      role={title ? "img" : undefined}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {/* 塔筒与机舱不转 */}
      <path
        d="M11.3 13.4 10.4 21h3.2l-.9-7.6z"
        fill="currentColor"
        opacity="0.45"
      />
      {/* 三叶轮：绕轮毂 (12,11) 旋转 */}
      <g className="turbine-spinner__rotor">
        <path
          d="M12 11 11.4 3.2a.6.6 0 0 1 1.2 0L12 11z"
          fill="currentColor"
        />
        <path
          d="M12 11 18.8 14.7a.6.6 0 0 1-.6 1.04L12 11z"
          fill="currentColor"
        />
        <path
          d="M12 11 5.8 15.74a.6.6 0 0 1-.6-1.04L12 11z"
          fill="currentColor"
        />
        <circle cx="12" cy="11" fill="currentColor" r="1.4" />
      </g>
    </svg>
  )
}
