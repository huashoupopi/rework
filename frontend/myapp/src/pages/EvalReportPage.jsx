import * as React from "react"
import { Select, Table, Tag } from "antd"
import { ArrowDown, ArrowUp, Download, GitCompare, RefreshCw } from "lucide-react"

import { useEvalReports } from "@/features/eval-report/hooks/useEvalReports"
import {
  compareRuns,
  layerBreakdown,
  rerankMoves,
  retrievalPaths,
  stepTimings,
} from "@/features/eval-report/lib/analysis"
import { extractErrorMessage } from "@/shared/api/http"
import { EmptyState } from "@/shared/ui/EmptyState"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

const LAYER_LABELS = {
  generation: "生成",
  guardrail: "门卫",
  multi_turn: "多轮",
  retrieval: "检索",
  routing: "路由",
}

const STEP_LABELS = {
  generate: "生成",
  rerank: "重排",
  retrieve: "检索",
  rewrite: "改写",
  route: "路由",
}

function formatEvalName(name) {
  const match = /^eval30_(\d{8})_(\d{6})(?:_(.+))?\.json$/.exec(name ?? "")
  if (!match) {
    return name ?? "-"
  }
  const [, date, time, tag] = match
  const stamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`
  return tag ? `${stamp} · ${tag}` : stamp
}

function formatPass(summary) {
  if (!summary) {
    return "-"
  }
  return `${summary.passed_cases ?? 0}/${summary.total_cases ?? 0}`
}

function formatLayers(layers) {
  if (!layers) {
    return "-"
  }
  return Object.entries(layers)
    .map(([name, entry]) => `${LAYER_LABELS[name] ?? name} ${entry.passed ?? 0}/${entry.total ?? 0}`)
    .join(" · ")
}

function formatStepValue(value) {
  if (value == null) {
    return "-"
  }
  if (typeof value === "object") {
    return JSON.stringify(value)
  }
  return String(value)
}

function formatMs(ms) {
  if (ms == null) {
    return "-"
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

/** 一条横向占比条。不引图表库 —— 单一维度的占比用 div 宽度就够了。 */
function ShareBar({ items }) {
  return (
    <div className="eval-sharebar" role="img" aria-label="各跳耗时占比">
      {items.map((item) => (
        <span
          className={`eval-sharebar__seg eval-sharebar__seg--${item.step}`}
          key={item.step}
          style={{ width: `${item.pct}%` }}
          title={`${STEP_LABELS[item.step] ?? item.step} ${item.pct.toFixed(1)}%`}
        />
      ))}
    </div>
  )
}

export function EvalReportPage() {
  const {
    compareLoading,
    compareName,
    compareReport,
    detailLoading,
    error,
    items,
    loading,
    openCompare,
    openReport,
    refresh,
    report,
    selectedName,
  } = useEvalReports()

  const [selectedCaseId, setSelectedCaseId] = React.useState(null)
  const [layerFilter, setLayerFilter] = React.useState("all")
  const [failOnly, setFailOnly] = React.useState(false)

  const selectedCase = (report?.results ?? []).find((row) => row.case_id === selectedCaseId) ?? null

  React.useEffect(() => {
    setSelectedCaseId(null)
    setLayerFilter("all")
    setFailOnly(false)
  }, [selectedName])

  const timings = React.useMemo(() => stepTimings(report), [report])
  const layers = React.useMemo(() => layerBreakdown(report), [report])
  const diff = React.useMemo(
    () => (compareReport ? compareRuns(report, compareReport) : null),
    [compareReport, report],
  )
  const paths = React.useMemo(() => retrievalPaths(selectedCase), [selectedCase])
  const moves = React.useMemo(() => rerankMoves(selectedCase), [selectedCase])

  const visibleCases = React.useMemo(() => {
    let rows = report?.results ?? []
    if (layerFilter !== "all") {
      rows = rows.filter((row) => row.layer === layerFilter)
    }
    if (failOnly) {
      rows = rows.filter((row) => row.status !== "PASS")
    }
    return rows
  }, [failOnly, layerFilter, report])

  const failCount = (report?.results ?? []).filter((row) => row.status !== "PASS").length

  function downloadReport() {
    if (!report || !selectedName) {
      return
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = selectedName
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  const listColumns = [
    { dataIndex: "name", render: (name) => formatEvalName(name), title: "跑批" },
    { key: "score", render: (_, row) => formatPass(row.summary), title: "总分" },
    { key: "layers", render: (_, row) => formatLayers(row.layers), title: "分层" },
  ]

  const caseColumns = [
    { dataIndex: "case_id", title: "题号" },
    { dataIndex: "layer", render: (layer) => LAYER_LABELS[layer] ?? layer, title: "层" },
    {
      dataIndex: "status",
      render: (status) => (
        <Tag color={status === "PASS" ? "green" : "red"}>
          {status === "PASS" ? "通过" : status === "FAIL" ? "失败" : status}
        </Tag>
      ),
      title: "结果",
    },
    {
      key: "mrr",
      render: (_, row) => (row.scores?.mrr == null ? "-" : row.scores.mrr.toFixed(3)),
      title: "MRR",
    },
    {
      dataIndex: "elapsed_ms",
      render: (value) => (value == null ? "-" : formatMs(value)),
      title: "耗时",
    },
  ]

  const diffColumns = [
    { dataIndex: "caseId", title: "题号" },
    { dataIndex: "layer", render: (layer) => LAYER_LABELS[layer] ?? layer ?? "-", title: "层" },
    { dataIndex: "baseMrr", render: (v) => (v == null ? "-" : v.toFixed(3)), title: "当前" },
    { dataIndex: "otherMrr", render: (v) => (v == null ? "-" : v.toFixed(3)), title: "对比" },
    {
      dataIndex: "delta",
      render: (delta, row) =>
        delta == null ? (
          row.statusChanged ? <Tag color="orange">状态翻转</Tag> : "-"
        ) : (
          <span className={delta > 0 ? "eval-delta--up" : "eval-delta--down"}>
            {delta > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
            {delta > 0 ? "+" : ""}
            {delta.toFixed(3)}
          </span>
        ),
      title: "差值",
    },
  ]

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <button className="secondary-action"
            disabled={loading}
            type="button"
            onClick={() => refresh().catch(() => {})}
          >
            <RefreshCw size={14} />
            刷新
          </button>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "跑批次数", value: `${items.length} 次` },
              { label: "当前", value: report ? formatPass(report.summary) : "未选择" },
              { label: "红题", value: report ? `${failCount} 道` : "-" },
            ]}
            label="评测摘要"
            title="评测报告"
          />
        }
        compact
        description="历次 eval30 跑批、分层通过率、各跳耗时分布、跨跑批逐题对比与链路 trace。"
        eyebrow="系统管理"
        title="评测报告"
      />

      {error ? <p role="alert">{extractErrorMessage(error, "加载评测报告失败")}</p> : null}

      {!loading && items.length === 0 ? (
        <EmptyState description="跑完 eval30 后刷新即可。结果文件在 backend/evals/results。" title="暂无评测报告" />
      ) : (
        <GlassPanel aria-label="评测跑批列表" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">历次跑批</p>
              <h2>eval30 结果</h2>
            </div>
          </div>
          <Table
            columns={listColumns}
            dataSource={items.map((row) => ({ ...row, key: row.name }))}
            loading={loading}
            locale={{ emptyText: "暂无评测报告" }}
            onRow={(row) => ({ onClick: () => openReport(row.name).catch(() => {}) })}
            pagination={false}
            rowClassName={(row) => (row.name === selectedName ? "eval-row--selected" : undefined)}
            rowKey="name"
            size="middle"
          />
        </GlassPanel>
      )}

      {selectedName && layers.length > 0 ? (
        <GlassPanel aria-label="分层与耗时" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">{formatEvalName(selectedName)}</p>
              <h2>分层通过率与耗时分布</h2>
            </div>
            <button className="secondary-action" type="button" onClick={downloadReport}>
              <Download size={14} />
              导出 JSON
            </button>
          </div>

          <ul className="eval-layer-grid">
            {layers.map((layer) => (
              <li className={layer.pct < 100 ? "eval-layer--partial" : undefined} key={layer.name}>
                <span className="eval-layer__name">{LAYER_LABELS[layer.name] ?? layer.name}</span>
                <strong className="eval-layer__score">{`${layer.passed}/${layer.total}`}</strong>
                <span className="eval-layer__meter">
                  <span style={{ width: `${layer.pct}%` }} />
                </span>
              </li>
            ))}
          </ul>

          {timings.steps.length > 0 ? (
            <div className="eval-timing">
              <div className="eval-timing__head">
                <h3>各跳耗时占比</h3>
                <span>{`链路合计 ${formatMs(timings.grandMs)}`}</span>
              </div>
              <ShareBar items={timings.steps} />
              <ul className="eval-timing__legend">
                {timings.steps.map((step) => (
                  <li key={step.step}>
                    <span className={`eval-dot eval-dot--${step.step}`} />
                    {STEP_LABELS[step.step] ?? step.step}
                    <strong>{`${step.pct.toFixed(1)}%`}</strong>
                    <span className="text-muted">{formatMs(step.ms)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </GlassPanel>
      ) : null}

      {selectedName ? (
        <GlassPanel aria-label="跨跑批对比" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">对比</p>
              <h2>跨跑批逐题差异</h2>
            </div>
            <Select
              allowClear
              className="eval-compare-select"
              loading={compareLoading}
              options={items
                .filter((row) => row.name !== selectedName)
                .map((row) => ({ label: formatEvalName(row.name), value: row.name }))}
              placeholder="选一次跑批来对比"
              value={compareName ?? undefined}
              onChange={(value) => openCompare(value ?? null).catch(() => {})}
            />
          </div>

          {diff ? (
            diff.moved.length === 0 ? (
              <p className="eval-diff__none">
                <GitCompare size={14} />
                两次跑批逐题完全一致，共 {diff.rows.length} 题。
              </p>
            ) : (
              <>
                <p className="eval-diff__summary">
                  {`${diff.unchangedCount} 题分毫不动，${diff.moved.length} 题有变化 —— 波动集中在下面这几题。`}
                </p>
                <Table
                  columns={diffColumns}
                  dataSource={diff.moved.map((row) => ({ ...row, key: row.caseId }))}
                  pagination={false}
                  rowKey="caseId"
                  size="small"
                />
              </>
            )
          ) : (
            <p className="text-muted">选一次跑批，逐题比对 MRR 与状态 —— 用来看清一次改动到底动了哪几题。</p>
          )}
        </GlassPanel>
      ) : null}

      {selectedName ? (
        <GlassPanel aria-label="评测详情" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">{formatEvalName(selectedName)}</p>
              <h2>{`${visibleCases.length} / ${report?.results?.length ?? 0} 题`}</h2>
            </div>
            <div className="eval-filters">
              <Select
                className="eval-layer-select"
                options={[
                  { label: "全部层", value: "all" },
                  ...layers.map((l) => ({ label: LAYER_LABELS[l.name] ?? l.name, value: l.name })),
                ]}
                value={layerFilter}
                onChange={setLayerFilter}
              />
              <button
                aria-pressed={failOnly}
                className={failOnly ? "secondary-action is-active" : "secondary-action"}
                type="button"
                onClick={() => setFailOnly((prev) => !prev)}
              >
                {`只看红题${failCount > 0 ? ` (${failCount})` : ""}`}
              </button>
            </div>
          </div>
          <Table
            columns={caseColumns}
            dataSource={visibleCases.map((row) => ({ ...row, key: row.case_id }))}
            loading={detailLoading}
            locale={{ emptyText: failOnly ? "没有红题" : "该跑批没有题目" }}
            onRow={(row) => ({ onClick: () => setSelectedCaseId(row.case_id) })}
            pagination={false}
            rowClassName={(row) =>
              [
                row.status !== "PASS" ? "eval-row--fail" : "",
                row.case_id === selectedCaseId ? "eval-row--selected" : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            rowKey="case_id"
            size="middle"
          />
        </GlassPanel>
      ) : null}

      {selectedCase ? (
        <GlassPanel aria-label="题目详情" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">{LAYER_LABELS[selectedCase.layer] ?? selectedCase.layer}</p>
              <h2>{selectedCase.case_id}</h2>
            </div>
            <Tag color={selectedCase.status === "PASS" ? "green" : "red"}>{selectedCase.status}</Tag>
          </div>

          {paths ? (
            <div className="eval-paths">
              <h3>检索两路</h3>
              <ul>
                <li>
                  <span>向量 dense</span>
                  <strong>{paths.dense}</strong>
                </li>
                <li>
                  <span>全文 sparse</span>
                  <strong>{paths.sparse}</strong>
                </li>
                <li>
                  <span>重叠</span>
                  <strong>{`${paths.overlap} (${paths.overlapPct.toFixed(0)}%)`}</strong>
                </li>
                <li>
                  <span>去重后</span>
                  <strong>{paths.returned}</strong>
                </li>
              </ul>
              {paths.tokenizedQuery ? (
                <p className="eval-paths__query">
                  <span className="text-muted">全文查询串</span>
                  <code>{paths.tokenizedQuery}</code>
                </p>
              ) : null}
            </div>
          ) : null}

          {moves.length > 0 ? (
            <div className="eval-moves">
              <h3>{`重排名次变化（${moves.length} 处）`}</h3>
              <ul>
                {moves.map((move) => (
                  <li key={`${move.from}-${move.to}`}>
                    <span className={move.delta > 0 ? "eval-delta--up" : "eval-delta--down"}>
                      {move.delta > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                    </span>
                    {`第 ${move.from} → 第 ${move.to}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <section className="eval-case-panel">
            <div>
              <h3>判分明细</h3>
              <pre>{JSON.stringify(selectedCase.scores ?? {}, null, 2)}</pre>
            </div>
            <div>
              <h3>链路</h3>
              {selectedCase.trace ? (
                <dl className="eval-trace">
                  <div>
                    <dt>request_id</dt>
                    <dd>{selectedCase.trace.request_id ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>total_ms</dt>
                    <dd>{formatStepValue(selectedCase.trace.total_ms)}</dd>
                  </div>
                  {(selectedCase.trace.steps ?? []).map((step) => (
                    <div key={step.step}>
                      <dt>
                        {STEP_LABELS[step.step] ?? step.step}
                        <span className="eval-trace__ms">{formatMs(step.ms)}</span>
                      </dt>
                      <dd>
                        {Object.entries(step)
                          .filter(([key]) => key !== "step" && key !== "ms")
                          .map(([key, value]) => `${key}=${formatStepValue(value)}`)
                          .join(" · ") || "-"}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>无 trace（门卫直接拒答的题不进 RAG 五跳）</p>
              )}
            </div>
          </section>
        </GlassPanel>
      ) : null}
    </div>
  )
}
