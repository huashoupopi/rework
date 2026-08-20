// 评测报告的分析函数。全部是纯函数 —— 页面只负责画，算在这里，可单测。
//
// 这几个分析不是凭空想的功能：它们是架构台 2026-08-20/21 验收 P1-P3 时
// 靠手写一次性脚本才算出来的东西。既然每次都要算，就该做进页面。

const LAYER_ORDER = ["retrieval", "generation", "guardrail", "multi_turn", "routing"]
const STEP_ORDER = ["rewrite", "retrieve", "rerank", "route", "generate"]

/** 各跳耗时汇总。回答「时间花在哪一跳」。
 *  实例：P1 验收发现 rewrite 占链路总时长 39%，而那些题绝大多数不是多轮题。 */
export function stepTimings(report) {
  const totals = new Map()
  let grand = 0

  for (const row of report?.results ?? []) {
    for (const step of row?.trace?.steps ?? []) {
      const ms = Number(step?.ms) || 0
      totals.set(step.step, (totals.get(step.step) ?? 0) + ms)
      grand += ms
    }
  }

  if (grand <= 0) {
    return { grandMs: 0, steps: [] }
  }

  const steps = [...totals.entries()]
    .map(([step, ms]) => ({ ms, pct: (ms / grand) * 100, step }))
    .sort((a, b) => {
      const ai = STEP_ORDER.indexOf(a.step)
      const bi = STEP_ORDER.indexOf(b.step)
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
    })

  return { grandMs: grand, steps }
}

/** 逐题对比两次跑批。回答「这次改动到底动了哪几题」。
 *  实例：跨 9 次跑批发现 10 题里 7 题分毫不动，全部波动只来自 R01/R02。 */
export function compareRuns(baseReport, otherReport) {
  const pick = (report) => {
    const map = new Map()
    for (const row of report?.results ?? []) {
      map.set(row.case_id, row)
    }
    return map
  }

  const base = pick(baseReport)
  const other = pick(otherReport)
  const ids = [...new Set([...base.keys(), ...other.keys()])].sort()

  const rows = ids.map((caseId) => {
    const a = base.get(caseId)
    const b = other.get(caseId)
    const aMrr = a?.scores?.mrr ?? null
    const bMrr = b?.scores?.mrr ?? null
    const delta = aMrr != null && bMrr != null ? bMrr - aMrr : null

    return {
      baseMrr: aMrr,
      baseStatus: a?.status ?? null,
      caseId,
      delta,
      layer: a?.layer ?? b?.layer ?? null,
      otherMrr: bMrr,
      otherStatus: b?.status ?? null,
      statusChanged: Boolean(a && b) && a.status !== b.status,
    }
  })

  const moved = rows.filter((r) => (r.delta != null && Math.abs(r.delta) > 1e-9) || r.statusChanged)

  return { moved, rows, unchangedCount: rows.length - moved.length }
}

/** 检索两路的召回与重叠。回答「RRF 的 k 为什么不起作用」。
 *  单路文档的 RRF 分只有一项、排序与 k 无关，k 只作用在重叠那几条上。 */
export function retrievalPaths(caseRow) {
  const step = (caseRow?.trace?.steps ?? []).find((s) => s.step === "retrieve")
  if (!step) {
    return null
  }

  const dense = Number(step.dense) || 0
  const sparse = Number(step.sparse) || 0
  const overlap = Number(step.overlap) || 0
  const slots = dense + sparse

  return {
    dense,
    mode: step.mode ?? null,
    overlap,
    overlapPct: slots > 0 ? (overlap / slots) * 100 : 0,
    returned: Number(step.returned) || 0,
    sparse,
    tokenizedQuery: step.tokenized_query ?? null,
  }
}

/** 重排把谁挤上去、把谁压下来。 */
export function rerankMoves(caseRow) {
  const step = (caseRow?.trace?.steps ?? []).find((s) => s.step === "rerank")
  const moved = step?.moved
  if (!Array.isArray(moved) || moved.length === 0) {
    return []
  }
  return moved.map((m) => ({ delta: (m.from ?? 0) - (m.to ?? 0), from: m.from, to: m.to }))
}

/** 分层通过率，按固定顺序输出，缺层不显示。 */
export function layerBreakdown(report) {
  const layers = report?.layers ?? {}
  return LAYER_ORDER.filter((name) => layers[name]).map((name) => {
    const entry = layers[name]
    const total = entry.total ?? 0
    const passed = entry.passed ?? 0
    return { name, passed, pct: total > 0 ? (passed / total) * 100 : 0, total }
  })
}
