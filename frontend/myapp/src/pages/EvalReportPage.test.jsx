import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const listEvalReports = vi.fn()
const getEvalReport = vi.fn()

vi.mock("@/features/eval-report/api/eval-api", () => ({
  getEvalReport: (...args) => getEvalReport(...args),
  listEvalReports: (...args) => listEvalReports(...args),
}))

const { EvalReportPage } = await import("./EvalReportPage")

function makeResults() {
  return Array.from({ length: 36 }, (_, index) => {
    const fail = index === 0
    return {
      case_id: fail ? "R01" : `C${String(index + 1).padStart(2, "0")}`,
      elapsed_ms: 1200,
      layer: index < 10 ? "retrieval" : "generation",
      scores: fail
        ? { hit_at_10: 0, hit_at_5: 0, mrr: 0, pass: false }
        : { pass: true },
      status: fail ? "FAIL" : "PASS",
      trace: fail
        ? {
            request_id: "req-red",
            steps: [
              {
                dense: 1,
                ms: 18.2,
                overlap: 0,
                returned: 1,
                sparse: 1,
                step: "retrieve",
              },
            ],
            total_ms: 80,
          }
        : {
            request_id: "req-ok",
            steps: [{ ms: 10, step: "retrieve", returned: 10 }],
            total_ms: 40,
          },
    }
  })
}

const SAMPLE_ITEM = {
  layers: {
    retrieval: { passed: 9, total: 10 },
  },
  name: "eval30_20260820_194549_p2-after.json",
  summary: { pass_rate: 0.97, passed_cases: 35, total_cases: 36 },
}

afterEach(() => {
  listEvalReports.mockReset()
  getEvalReport.mockReset()
})

test("renders empty state when there are no eval reports", async () => {
  listEvalReports.mockResolvedValueOnce({ items: [] })

  render(<EvalReportPage />)

  expect(await screen.findByRole("heading", { name: "暂无评测报告" })).toBeInTheDocument()
  expect(screen.getByText("跑完 eval30 后刷新即可。结果文件在 backend/evals/results。")).toBeInTheDocument()
  expect(screen.queryByText("36 题")).not.toBeInTheDocument()
})

test("renders the eval run list", async () => {
  listEvalReports.mockResolvedValueOnce({
    items: [
      SAMPLE_ITEM,
      {
        layers: { retrieval: { passed: 10, total: 10 } },
        name: "eval30_20260820_012340.json",
        summary: { pass_rate: 1, passed_cases: 36, total_cases: 36 },
      },
    ],
  })

  render(<EvalReportPage />)

  // 2026-08-21 三列从「压平的字符串」改成结构化单元格：
  // 跑批名拆成标签 + 时间戳两级，分数拆成数字 + 完成度线，
  // 分层从「检索 9/10 · 生成 …」一长串换成每层一根填充条。
  expect(await screen.findByText("p2-after")).toBeInTheDocument()
  expect(screen.getByText("2026-08-20 19:45:49")).toBeInTheDocument()
  expect(screen.getByText("未命名跑批")).toBeInTheDocument()
  expect(screen.getByText("2026-08-20 01:23:40")).toBeInTheDocument()

  // 分数：满分与掉分要在 DOM 上分得开，不只是颜色不同
  const meters = document.querySelectorAll(".pass-meter")
  expect(meters.length).toBe(2)
  expect([...meters].map((m) => m.dataset.full).sort()).toEqual(["false", "true"])

  // 这次改造的核心：掉分的那一层要被单独标出来，而不是埋在一串文字里
  expect(screen.getByTitle("检索 9/10").dataset.full).toBe("false")
  expect(screen.getByTitle("检索 10/10").dataset.full).toBe("true")
})

test("highlights failing cases and shows 36 rows plus trace", async () => {
  listEvalReports.mockResolvedValueOnce({ items: [SAMPLE_ITEM] })
  getEvalReport.mockResolvedValueOnce({
    ...SAMPLE_ITEM,
    results: makeResults(),
  })

  const { container } = render(<EvalReportPage />)

  fireEvent.click(await screen.findByText("p2-after"))

  await waitFor(() => {
    expect(getEvalReport).toHaveBeenCalledWith("eval30_20260820_194549_p2-after.json")
  })

  expect(await screen.findByText("R01")).toBeInTheDocument()
  expect(screen.getByText("C36")).toBeInTheDocument()
  expect(container.querySelectorAll(".ant-table-tbody tr").length).toBeGreaterThanOrEqual(36)
  expect(container.querySelectorAll(".eval-row--fail").length).toBe(1)
  expect(screen.getByText("失败")).toBeInTheDocument()

  fireEvent.click(screen.getByText("R01"))

  expect(await screen.findByText("判分明细")).toBeInTheDocument()
  expect(screen.getByText("链路")).toBeInTheDocument()
  expect(screen.getByText(/"hit_at_5": 0/)).toBeInTheDocument()
  expect(screen.getByText(/returned=1/)).toBeInTheDocument()
  expect(screen.getByText(/dense=1/)).toBeInTheDocument()
  expect(screen.getByText(/overlap=0/)).toBeInTheDocument()
  expect(screen.getByText("req-red")).toBeInTheDocument()
})
