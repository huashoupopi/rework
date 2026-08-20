import * as React from "react"
import { Table, Tag } from "antd"
import { RefreshCw } from "lucide-react"

import { useEvalReports } from "@/features/eval-report/hooks/useEvalReports"
import { extractErrorMessage } from "@/shared/api/http"
import { EmptyState } from "@/shared/ui/EmptyState"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { RippleButton } from "@/shared/ui/magicui/ripple-button"
import { PageWorkband } from "@/shared/ui/PageWorkband"
import { PageWorkbandInfoCard } from "@/shared/ui/PageWorkbandInfoCard"

const LAYER_LABELS = {
  retrieval: "检索",
  generation: "生成",
  guardrail: "门卫",
  multi_turn: "多轮",
  routing: "路由",
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

export function EvalReportPage() {
  const { detailLoading, error, items, loading, openReport, refresh, report, selectedName } = useEvalReports()
  const [selectedCaseId, setSelectedCaseId] = React.useState(null)

  const selectedCase = (report?.results ?? []).find((row) => row.case_id === selectedCaseId) ?? null

  React.useEffect(() => {
    setSelectedCaseId(null)
  }, [selectedName])

  const listColumns = [
    {
      dataIndex: "name",
      title: "跑批",
      render: (name) => formatEvalName(name),
    },
    {
      key: "score",
      title: "总分",
      render: (_, row) => formatPass(row.summary),
    },
    {
      key: "layers",
      title: "分层",
      render: (_, row) => formatLayers(row.layers),
    },
  ]

  const caseColumns = [
    {
      dataIndex: "case_id",
      title: "题号",
    },
    {
      dataIndex: "layer",
      title: "层",
      render: (layer) => LAYER_LABELS[layer] ?? layer,
    },
    {
      dataIndex: "status",
      title: "结果",
      render: (status) => (
        <Tag color={status === "PASS" ? "green" : "red"}>{status === "PASS" ? "通过" : status === "FAIL" ? "失败" : status}</Tag>
      ),
    },
    {
      dataIndex: "elapsed_ms",
      title: "耗时 ms",
      render: (value) => (value == null ? "-" : Math.round(value)),
    },
  ]

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <RippleButton disabled={loading} rippleColor="rgba(77,141,255,0.28)" type="button" onClick={() => refresh().catch(() => {})}>
            <RefreshCw size={14} />
            刷新
          </RippleButton>
        }
        aside={
          <PageWorkbandInfoCard
            items={[
              { label: "跑批次数", value: `${items.length} 次` },
              { label: "当前", value: report ? formatPass(report.summary) : "未选择" },
            ]}
            label="评测摘要"
            title="评测报告"
          />
        }
        compact
        description="历次 eval30 跑批、36 题表格与链路 trace。红题高亮，点开看判分和五跳。"
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
            onRow={(row) => ({
              onClick: () => openReport(row.name).catch(() => {}),
            })}
            pagination={false}
            rowClassName={(row) => (row.name === selectedName ? "eval-row--selected" : undefined)}
            rowKey="name"
            size="middle"
          />
        </GlassPanel>
      )}

      {selectedName ? (
        <GlassPanel aria-label="评测详情" className="data-surface">
          <div className="data-surface__toolbar">
            <div>
              <p className="data-surface__eyebrow">{formatEvalName(selectedName)}</p>
              <h2>36 题</h2>
            </div>
            {report?.summary ? <p>{formatPass(report.summary)}</p> : null}
          </div>
          {report?.layers ? (
            <ul className="eval-layer-list">
              {Object.entries(report.layers).map(([name, entry]) => (
                <li key={name}>
                  <span>{LAYER_LABELS[name] ?? name}</span>
                  <strong>{`${entry.passed ?? 0}/${entry.total ?? 0}`}</strong>
                </li>
              ))}
            </ul>
          ) : null}
          <Table
            columns={caseColumns}
            dataSource={(report?.results ?? []).map((row) => ({ ...row, key: row.case_id }))}
            loading={detailLoading}
            locale={{ emptyText: "该跑批没有题目" }}
            onRow={(row) => ({
              onClick: () => setSelectedCaseId(row.case_id),
            })}
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
              <p className="data-surface__eyebrow">{selectedCase.layer}</p>
              <h2>{selectedCase.case_id}</h2>
            </div>
            <Tag color={selectedCase.status === "PASS" ? "green" : "red"}>{selectedCase.status}</Tag>
          </div>
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
                      <dt>{step.step}</dt>
                      <dd>
                        {Object.entries(step)
                          .filter(([key]) => key !== "step")
                          .map(([key, value]) => `${key}=${formatStepValue(value)}`)
                          .join(" · ")}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>无 trace</p>
              )}
            </div>
          </section>
        </GlassPanel>
      ) : null}
    </div>
  )
}
