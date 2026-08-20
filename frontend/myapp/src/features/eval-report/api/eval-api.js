import { http } from "@/shared/api/http"

export async function listEvalReports() {
  const response = await http.get("/evals")

  return response.data
}

export async function getEvalReport(name) {
  const response = await http.get(`/evals/${encodeURIComponent(name)}`)

  return response.data
}
