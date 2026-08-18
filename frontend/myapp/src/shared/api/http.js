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
