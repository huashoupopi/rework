import * as React from "react"
import { Input, Select } from "antd"
import { Play } from "lucide-react"

import {
  getEvalRunStatus,
  listEvalLayers,
  triggerEvalRun,
} from "@/features/eval-report/api/eval-api"
import { extractErrorMessage } from "@/shared/api/http"
import { useAppMessage } from "@/shared/lib/use-app-message"
import { EVAL_LAYER_LABELS } from "@/shared/lib/labels"

const POLL_MS = 2500

/**
 * 从页面开一轮评测。
 *
 * 在此之前只能切终端跑 `run_rag_eval.py`，页面是纯只读的。
 *
 * 两个要说明的约束：
 * 1. 一次只允许跑一轮 —— 后端用固定 job_id 去重。每题都要打一次 LLM，
 *    并发开几轮既烧额度又会写出多份结果文件。
 * 2. 跑批期间不轮询业务数据，只轮询进度。列表在跑完那一刻刷新一次。
 */
export function EvalRunPanel({ onFinished }) {
  const message = useAppMessage()
  const [layers, setLayers] = React.useState([])
  const [selectedLayers, setSelectedLayers] = React.useState([])
  const [tag, setTag] = React.useState("")
  const [state, setState] = React.useState({ phase: "idle" })
  const [submitting, setSubmitting] = React.useState(false)
  const finishedRef = React.useRef(false)

  React.useEffect(() => {
    listEvalLayers()
      .then((data) => setLayers(data?.layers ?? []))
      .catch(() => setLayers([]))
  }, [])

  React.useEffect(() => {
    let timer = null
    let alive = true

    async function poll() {
      try {
        const next = await getEvalRunStatus()
        if (!alive) return
        setState(next ?? { phase: "idle" })
        // 只在「从跑批中变成完成」的那一次刷新列表，避免空闲时反复拉
        if (next?.phase === "done" && !finishedRef.current) {
          finishedRef.current = true
          onFinished?.()
          message.success(`跑批完成：${next.passed}/${next.cases}`)
        }
        if (next?.phase === "running") {
          finishedRef.current = false
        }
      } catch {
        // 状态查不到不该打断页面，下一轮再试
      }
      if (alive) timer = window.setTimeout(poll, POLL_MS)
    }

    poll()
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [message, onFinished])

  const running = state.phase === "running"
  const total = Number(state.total) || 0
  const done = Number(state.done) || 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const selectedCount = selectedLayers.length
    ? layers.filter((l) => selectedLayers.includes(l.name)).reduce((n, l) => n + l.count, 0)
    : layers.reduce((n, l) => n + l.count, 0)

  async function handleRun() {
    setSubmitting(true)
    try {
      await triggerEvalRun({ layers: selectedLayers, tag })
      finishedRef.current = false
      setState({ phase: "running", done: 0, total: selectedCount })
      message.info("已开始跑批，进度在下面")
    } catch (error) {
      message.error(extractErrorMessage(error, "启动失败"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section aria-label="开始评测" className="eval-run">
      <div className="eval-run__head">
        <p className="ops-block__label">开始一轮</p>
        <span className="eval-run__scope">
          将跑 <b>{selectedCount}</b> 题
        </span>
      </div>

      <div className="eval-run__form">
        <label className="eval-run__field">
          <span>层</span>
          <Select
            allowClear
            disabled={running}
            mode="multiple"
            onChange={setSelectedLayers}
            options={layers.map((l) => ({
              label: `${EVAL_LAYER_LABELS[l.name] ?? l.name} · ${l.count}`,
              value: l.name,
            }))}
            placeholder="全部层"
            value={selectedLayers}
          />
        </label>

        <label className="eval-run__field eval-run__field--tag">
          <span>标签</span>
          <Input
            disabled={running}
            maxLength={40}
            onChange={(event) => setTag(event.target.value)}
            placeholder="写进文件名，如 p4-after"
            value={tag}
          />
        </label>

        <button
          className="primary-action"
          disabled={running || submitting}
          onClick={handleRun}
          type="button"
        >
          <Play size={15} strokeWidth={2} />
          {running ? "跑批中" : "开始跑批"}
        </button>
      </div>

      {running || state.phase === "done" || state.phase === "failed" ? (
        <div className="eval-run__progress" data-phase={state.phase}>
          <div className="eval-run__bar">
            <span style={{ width: `${state.phase === "done" ? 100 : pct}%` }} />
          </div>
          <p className="eval-run__status">
            {state.phase === "running" ? (
              <>
                <b>
                  {done}/{total}
                </b>
                <span>
                  {state.last_case ? `刚跑完 ${state.last_case} · ${state.last_status}` : "启动中"}
                </span>
              </>
            ) : state.phase === "done" ? (
              <>
                <b>
                  {state.passed}/{state.cases}
                </b>
                <span>已写入 {state.result_file}</span>
              </>
            ) : (
              <span className="eval-run__error">{state.error ?? "跑批失败"}</span>
            )}
          </p>
        </div>
      ) : null}

      <p className="eval-run__note">
        每题要完整走一次问答，一轮 36 题约几分钟，期间不能再开第二轮。
      </p>
    </section>
  )
}
