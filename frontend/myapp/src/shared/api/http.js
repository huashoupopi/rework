import axios from "axios"

import { useAuthStore } from "@/features/auth/store/auth-store"

export function applyAuthHeader(config, token) {
  const nextConfig = {
    ...config,
    headers: {
      ...(config.headers ?? {}),
    },
  }

  if (token) {
    nextConfig.headers.Authorization = `Bearer ${token}`
  }

  return nextConfig
}

export function handleHttpError(error) {
  if (error?.response?.status === 401) {
    useAuthStore.getState().clearAuth()
  }

  return Promise.reject(error)
}

export const http = axios.create({
  baseURL: "/api",
})

http.interceptors.request.use((config) => applyAuthHeader(config, useAuthStore.getState().token))
http.interceptors.response.use((response) => response, handleHttpError)

export async function downloadFile(url, config = {}) {
  const response = await http.get(url, {
    ...config,
    responseType: "blob",
  })

  const disposition = response.headers?.["content-disposition"] ?? ""
  const match = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/i)
  const filename = match ? decodeURIComponent(match[1]) : "download"

  const blobUrl = URL.createObjectURL(response.data)
  const anchor = document.createElement("a")
  anchor.href = blobUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(blobUrl)

  return response
}

// FastAPI 的 detail 有三种形态：字符串（HTTPException）、对象数组（Pydantic 422）、
// 或缺席。以前各页面直接把 detail 塞进 React，遇到 422 就抛
// "Objects are not valid as a React child"，整页白屏。统一在这里收敛成字符串。
export function extractErrorMessage(error, fallback = "请求失败，请稍后重试") {
  const detail = error?.response?.data?.detail

  if (typeof detail === "string" && detail.trim()) {
    return detail
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === "string") {
          return item
        }
        if (!item || typeof item !== "object") {
          return ""
        }
        // loc 形如 ["body", "password"]，取末段当字段名
        const field = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : ""
        const msg = typeof item.msg === "string" ? item.msg : ""
        if (!msg) {
          return ""
        }
        return field ? `${field}：${msg}` : msg
      })
      .filter(Boolean)

    if (messages.length > 0) {
      return messages.join("；")
    }
  }

  if (detail && typeof detail === "object" && typeof detail.msg === "string") {
    return detail.msg
  }

  // axios 的网络层错误（请求发出去了但没有 response）message 是
  // "Network Error" / "timeout of 30000ms exceeded" 这类英文技术文案，
  // 对用户没有任何可执行的信息。给一句能指向下一步的中文。
  if (error?.request && !error?.response) {
    const timedOut = typeof error.message === "string" && error.message.includes("timeout")
    return timedOut ? "请求超时，服务可能正忙，请稍后重试" : "连不上服务，请确认后端是否在运行"
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}
