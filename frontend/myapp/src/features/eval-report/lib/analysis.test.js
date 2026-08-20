import { expect, test } from "vitest"

import {
  compareRuns,
  layerBreakdown,
  rerankMoves,
  retrievalPaths,
  stepTimings,
} from "./analysis"

// 数据形状取自真实结果文件 evals/results/eval30_*.json，不是臆造的结构
function caseRow(id, { mrr = null, status = "PASS", steps = [], layer = "retrieval" } = {}) {
  return {
    case_id: id,
    layer,
    scores: mrr == null ? {} : { mrr },
    status,
    trace: steps.length ? { steps, total_ms: steps.reduce((s, x) => s + x.ms, 0) } : undefined,
  }
}

test("stepTimings 汇总各跳并给出占比", () => {
  const report = {
    results: [
      caseRow("R01", {
        steps: [
          { ms: 6000, step: "rewrite" },
          { ms: 800, step: "retrieve" },
          { ms: 1200, step: "rerank" },
        ],
      }),
      caseRow("R02", {
        steps: [
          { ms: 6000, step: "rewrite" },
          { ms: 1000, step: "retrieve" },
        ],
      }),
    ],
  }

  const { grandMs, steps } = stepTimings(report)

  expect(grandMs).toBe(15000)
  const rewrite = steps.find((s) => s.step === "rewrite")
  // 这正是 P1 验收发现的形状：改写吃掉大头
  expect(rewrite.ms).toBe(12000)
  expect(Math.round(rewrite.pct)).toBe(80)
  // 按链路顺序排，不是按耗时
  expect(steps.map((s) => s.step)).toEqual(["rewrite", "retrieve", "rerank"])
})

test("stepTimings 对没有 trace 的报告返回空而不是崩", () => {
  expect(stepTimings({ results: [caseRow("GR01")] })).toEqual({ grandMs: 0, steps: [] })
  expect(stepTimings(null)).toEqual({ grandMs: 0, steps: [] })
})

// 回归钉：跨 9 次跑批的实测结论是「10 题里 7 题分毫不动，波动只来自 R01/R02」。
// 这个函数就是用来把那种题挑出来的。
test("compareRuns 只挑出真正变化的题", () => {
  const base = { results: [caseRow("R01", { mrr: 0.39 }), caseRow("R02", { mrr: 1.0 }), caseRow("R03", { mrr: 0.3 })] }
  const other = { results: [caseRow("R01", { mrr: 0.5 }), caseRow("R02", { mrr: 0.33 }), caseRow("R03", { mrr: 0.3 })] }

  const { moved, unchangedCount } = compareRuns(base, other)

  expect(moved.map((m) => m.caseId)).toEqual(["R01", "R02"])
  expect(unchangedCount).toBe(1)
  expect(moved[0].delta).toBeCloseTo(0.11, 5)
  expect(moved[1].delta).toBeCloseTo(-0.67, 5)
})

test("compareRuns 把状态翻转也算作变化，即使 MRR 相同", () => {
  const base = { results: [caseRow("G01", { mrr: 0.5, status: "PASS" })] }
  const other = { results: [caseRow("G01", { mrr: 0.5, status: "FAIL" })] }

  const { moved } = compareRuns(base, other)

  expect(moved).toHaveLength(1)
  expect(moved[0].statusChanged).toBe(true)
})

test("compareRuns 容忍一边缺题", () => {
  const base = { results: [caseRow("R01", { mrr: 1 })] }
  const other = { results: [caseRow("R01", { mrr: 1 }), caseRow("R99", { mrr: 0.5 })] }

  const { rows } = compareRuns(base, other)

  const r99 = rows.find((r) => r.caseId === "R99")
  expect(r99.baseMrr).toBeNull()
  expect(r99.delta).toBeNull()
})

test("retrievalPaths 算出两路重叠率", () => {
  const row = caseRow("R01", {
    steps: [{ dense: 10, ms: 800, overlap: 5, returned: 15, sparse: 10, step: "retrieve" }],
  })

  const paths = retrievalPaths(row)

  expect(paths.dense).toBe(10)
  expect(paths.sparse).toBe(10)
  expect(paths.overlap).toBe(5)
  // 5 / (10+10) = 25% —— 实测区间是 15%~35%，正是 k 不起作用的原因
  expect(paths.overlapPct).toBeCloseTo(25, 5)
})

test("retrievalPaths 没有 retrieve 跳时返回 null", () => {
  expect(retrievalPaths(caseRow("GR01"))).toBeNull()
})

test("rerankMoves 给出名次变化方向", () => {
  const row = caseRow("R01", {
    steps: [{ moved: [{ from: 3, to: 1 }, { from: 1, to: 4 }], ms: 1200, step: "rerank" }],
  })

  const moves = rerankMoves(row)

  expect(moves[0].delta).toBe(2)
  expect(moves[1].delta).toBe(-3)
})

test("layerBreakdown 按固定顺序输出且跳过缺失的层", () => {
  const out = layerBreakdown({ layers: { retrieval: { passed: 9, total: 10 }, routing: { passed: 4, total: 4 } } })

  expect(out.map((l) => l.name)).toEqual(["retrieval", "routing"])
  expect(out[0].pct).toBe(90)
})
