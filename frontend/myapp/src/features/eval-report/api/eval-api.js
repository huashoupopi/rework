import { http } from "@/shared/api/http"

export async function listEvalReports() {
  const response = await http.get("/evals")

  return response.data
}

export async function getEvalReport(name) {
  const response = await http.get(`/evals/${encodeURIComponent(name)}`)

  return response.data
}

// ── 触发跑批（2026-08-21）────────────────────────────────────────
// 在此之前跑一轮评测只能切终端敲 run_rag_eval.py，页面只能看历史结果。

export async function listEvalLayers() {
  const response = await http.get("/evals/meta/layers")

  return response.data
}

export async function triggerEvalRun({ layers, caseIds, tag } = {}) {
  const response = await http.post("/evals/run", {
    case_ids: caseIds?.length ? caseIds : null,
    layers: layers?.length ? layers : null,
    tag: tag?.trim() || null,
  })

  return response.data
}

export async function getEvalRunStatus() {
  const response = await http.get("/evals/run/status")

  return response.data
}
