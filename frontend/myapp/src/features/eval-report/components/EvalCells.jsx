import * as React from "react"

import { EVAL_LAYER_LABELS as LAYER_LABELS } from "@/shared/lib/labels"

/**
 * 评测表格的三个单元格组件。
 *
 * 2026-08-21 起因：这三列原本各自把结构化数据压成一个字符串 ——
 *   跑批 → "2026-08-21 00:15:10 · dense-nl-full"
 *   总分 → "36/36"
 *   分层 → "检索 10/10 · 生成 8/8 · 门卫 10/10 · 多轮 4/4 · 路由 4/4"
 * 压平之后哪一层掉了分读不出来，36/36 和 5/10 视觉上一样重，
 * 整张表就是一堵字墙，扫不动。
 *
 * 这里不是给字加装饰，是把数据本来的结构还原成视觉结构。
 */

/** 跑批名：标签是识别项(主),时间戳是定位用(次),分两级排 */
export function EvalRunName({ name }) {
  const match = /^eval30_(\d{8})_(\d{6})(?:_(.+))?\.json$/.exec(name ?? "")
  if (!match) {
    return <span className="run-name__plain">{name ?? "-"}</span>
  }
  const [, date, time, tag] = match
  const stamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`

  return (
    <span className="run-name">
      <strong className="run-name__tag">{tag ?? "未命名跑批"}</strong>
      <span className="run-name__stamp">{stamp}</span>
    </span>
  )
}

/** 总分：数字 + 一条完成度线。满分与掉分要一眼分得开 */
export function PassMeter({ summary }) {
  if (!summary) {
    return <span className="pass-meter__empty">-</span>
  }
  const passed = summary.passed_cases ?? 0
  const total = summary.total_cases ?? 0
  const pct = total > 0 ? (passed / total) * 100 : 0
  const full = total > 0 && passed === total

  return (
    <span className="pass-meter" data-full={full ? "true" : "false"}>
      <span className="pass-meter__nums">
        <b>{passed}</b>
        <i>/{total}</i>
      </span>
      <span className="pass-meter__track">
        <span className="pass-meter__fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

/** 分层：每层一根填充条,满分实心、掉分留缺口。层名只留两个字 */
export function LayerBars({ layers }) {
  const entries = Object.entries(layers ?? {})
  if (entries.length === 0) {
    return <span className="pass-meter__empty">-</span>
  }

  return (
    <span className="layer-bars">
      {entries.map(([key, entry]) => {
        const passed = entry?.passed ?? 0
        const total = entry?.total ?? 0
        const pct = total > 0 ? (passed / total) * 100 : 0
        const label = LAYER_LABELS[key] ?? key
        return (
          <span
            className="layer-bars__item"
            data-full={total > 0 && passed === total ? "true" : "false"}
            key={key}
            title={`${label} ${passed}/${total}`}
          >
            <span className="layer-bars__track">
              <span className="layer-bars__fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="layer-bars__label">{label}</span>
          </span>
        )
      })}
    </span>
  )
}
