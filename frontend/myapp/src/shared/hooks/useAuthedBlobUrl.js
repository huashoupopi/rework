import * as React from "react"

import { http } from "@/shared/api/http"

// 批次 2 关掉了 /static 的匿名访问（IDOR 修复），图片改走带 Authorization 的接口。
// <img src> 带不上 localStorage 里的 token，所以只能先取 Blob 再 createObjectURL。
// 返回 { url, loading, error }；path 变化或组件卸载时回收上一个 objectURL。
export function useAuthedBlobUrl(path) {
  const [url, setUrl] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    setError(false)

    if (!path) {
      setUrl("")
      setLoading(false)
      return undefined
    }

    let objectUrl = ""
    let cancelled = false

    setLoading(true)
    http
      .get(path, { responseType: "blob" })
      .then((response) => {
        if (cancelled) {
          return
        }
        objectUrl = URL.createObjectURL(response.data)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) {
          setUrl("")
          setError(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [path])

  return { error, loading, url }
}
