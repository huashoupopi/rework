import * as React from "react"

import { http } from "@/shared/api/http"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"
import Markdown from "react-markdown"
import { BrainCircuit, ChevronDown, ChevronRight, FileText } from "lucide-react"

import { AnimatedShinyText } from "@/shared/ui/magicui/animated-shiny-text"
import { TextShimmerWave } from "@/shared/ui/motion-primitives/text-shimmer-wave"

import { extractAssistantThink } from "../utils/extractAssistantThink"

function getRoleLabel(role) {
  return role === "assistant" ? "助手" : "用户"
}

function ThinkingProcess({ content }) {
  const [open, setOpen] = React.useState(false)

  if (!content) {
    return null
  }

  return (
    <div className="collapsible-panel collapsible-panel--think">
      <button
        aria-expanded={open}
        className="collapsible-panel__trigger"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <BrainCircuit size={14} />
        <span>思考过程</span>
      </button>
      {open && (
        <div className="collapsible-panel__body">
          <p>{content}</p>
        </div>
      )}
    </div>
  )
}

function formatScore(score) {
  if (score === null || score === undefined) {
    return "n/a"
  }

  if (typeof score === "number" && score >= 0 && score <= 1) {
    return `${(score * 100).toFixed(0)}%`
  }

  if (typeof score === "number") {
    return score.toFixed(2)
  }

  return String(score)
}

function getRelevanceClass(score) {
  if (typeof score !== "number") {
    return ""
  }

  if (score >= 0.5) {
    return "source-item__score--high"
  }

  if (score >= 0) {
    return "source-item__score--mid"
  }

  return ""
}

function SourcesPanel({ sources }) {
  const [open, setOpen] = React.useState(false)

  if (!Array.isArray(sources) || sources.length === 0) {
    return null
  }

  return (
    <div className="collapsible-panel collapsible-panel--sources">
      <button
        aria-expanded={open}
        className="collapsible-panel__trigger"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FileText size={14} />
        <span>{`参考文献 (${sources.length})`}</span>
      </button>
      {open && (
        <div className="collapsible-panel__body">
          {sources.map((source, index) => {
            const docName = source?.doc || source?.file || source?.title || source?.source || `来源 ${index + 1}`
            const score = typeof source?.score === "number" ? source.score : null
            const snippet = source?.snippet
              ? source.snippet.length > 200
                ? `${source.snippet.slice(0, 200)}...`
                : source.snippet
              : null

            return (
              <div className="source-item" key={`${docName}-${index}`}>
                <div className="source-item__header">
                  <span className="source-item__index">[{index + 1}]</span>
                  <span className="source-item__name">{docName}</span>
                  <span className={`source-item__score ${getRelevanceClass(score)}`}>{formatScore(score)}</span>
                </div>
                {snippet && <p className="source-item__snippet">{snippet}</p>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MessageImages({ images }) {
  const [urls, setUrls] = React.useState([])

  React.useEffect(() => {
    if (!Array.isArray(images) || images.length === 0) {
      setUrls([])
      return undefined
    }

    // 三种来源：已是 URL 的字符串、刚选中的本地 Blob、后端返回的历史图。
    // 历史图不能再直连 /static —— 批次 2 关了匿名访问，必须带 token 取 Blob。
    const objectUrls = []
    let cancelled = false

    const immediate = images.map((img) => {
      if (typeof img === "string") {
        return img
      }
      if (img instanceof Blob) {
        const objectUrl = URL.createObjectURL(img)
        objectUrls.push(objectUrl)
        return objectUrl
      }
      return null
    })

    setUrls(immediate.filter(Boolean))

    const remoteTasks = images
      .map((img, index) => {
        if (immediate[index] !== null) {
          return null
        }
        const imageId = img && typeof img === "object" ? img.id : null
        if (imageId === undefined || imageId === null) {
          return null
        }
        return http
          .get(`/chat/images/${imageId}`, { responseType: "blob" })
          .then((response) => ({ blob: response.data, index }))
          .catch(() => null)
      })
      .filter(Boolean)

    if (remoteTasks.length > 0) {
      Promise.all(remoteTasks).then((results) => {
        if (cancelled) {
          return
        }
        const merged = [...immediate]
        for (const item of results) {
          if (!item) {
            continue
          }
          const objectUrl = URL.createObjectURL(item.blob)
          objectUrls.push(objectUrl)
          merged[item.index] = objectUrl
        }
        setUrls(merged.filter(Boolean))
      })
    }

    return () => {
      cancelled = true
      for (const url of objectUrls) {
        URL.revokeObjectURL(url)
      }
    }
  }, [images])

  if (urls.length === 0) {
    return null
  }

  return (
    <div className="message-card__images">
      {urls.map((url, index) => (
        <img alt={`上传图片 ${index + 1}`} className="message-card__image" key={url} src={url} />
      ))}
    </div>
  )
}

export function ChatMessageCard({ message }) {
  const sources = Array.isArray(message?.meta?.sources) ? message.meta.sources : []
  const isStreaming = message?.status === "streaming"
  const roleLabel = getRoleLabel(message?.role)
  const isAssistant = message?.role === "assistant"
  const metaThink = typeof message?.meta?.think === "string" ? message.meta.think.trim() : ""

  const rawContent = message?.content ?? ""
  const extracted = extractAssistantThink(rawContent)
  const displayContent = extracted.displayContent
  const think = metaThink || extracted.think

  return (
    <article
      aria-label={`${roleLabel}消息`}
      className={["message-card", isAssistant ? "message-card--assistant" : "message-card--user"].join(" ")}
    >
      <header className="message-card__header">
        <span className="message-card__role">{roleLabel}</span>
        {isStreaming ? (
          <span className="message-card__badge">
            <WindTurbineSvg className="message-card__spinner" spinning />
            <span>生成中</span>
          </span>
        ) : null}
      </header>
      {!isAssistant && <MessageImages images={message?.images} />}
      <ThinkingProcess content={think} />
      {displayContent ? (
        <div className="message-card__content prose">
          <Markdown>{displayContent}</Markdown>
          {isStreaming ? (
            <AnimatedShinyText className="mx-0 max-w-none">正在写入答复</AnimatedShinyText>
          ) : null}
        </div>
      ) : isStreaming ? (
        <TextShimmerWave className="[--base-color:var(--surface-muted)] [--base-gradient-color:var(--accent-strong)]">
          正在生成答复
        </TextShimmerWave>
      ) : null}
      <SourcesPanel sources={sources} />
    </article>
  )
}
