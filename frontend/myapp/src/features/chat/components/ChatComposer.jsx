import * as React from "react"
import { ImagePlus, SendHorizontal, Square } from "lucide-react"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function ChatComposer({ onSend, onStop, sending }) {
  const [question, setQuestion] = React.useState("")
  const [images, setImages] = React.useState([])

  const handleSubmit = async (event) => {
    event?.preventDefault?.()

    if (!question.trim() || sending) {
      return
    }

    const payload = { images, question: question.trim() }
    setQuestion("")
    setImages([])

    await onSend?.(payload)
  }

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      handleSubmit()
    }
  }

  return (
    <GlassPanel as="form" className="chat-composer" onSubmit={handleSubmit}>
      <div className="chat-composer__field">
        <textarea
          aria-label="输入问题"
          disabled={sending}
          placeholder="输入你的问题..."
          rows={2}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className="chat-composer__footer">
        <div className="chat-composer__left">
          <label className="file-chip">
            <ImagePlus size={16} />
            <span>图片</span>
            <input
              aria-label="上传图片"
              disabled={sending}
              multiple
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => setImages(Array.from(event.target.files ?? []))}
            />
          </label>
          {images.length > 0 && <span className="chat-composer__count">{images.length} 张</span>}
        </div>
        {sending ? (
          <button
            className="primary-action primary-action--danger"
            type="button"
            onClick={() => onStop?.()}
          >
            <Square size={14} />
            <span>终止</span>
          </button>
        ) : (
          <button
            className="primary-action"
            disabled={!question.trim()}
            type="button"
            onClick={() => handleSubmit()}
          >
            <SendHorizontal size={16} />
            <span>发送</span>
          </button>
        )}
      </div>
    </GlassPanel>
  )
}
