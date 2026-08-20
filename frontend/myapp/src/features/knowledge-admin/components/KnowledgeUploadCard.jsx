import * as React from "react"
import { FileUp } from "lucide-react"
import { GlassPanel } from "@/shared/ui/GlassPanel"
import { extractErrorMessage } from "@/shared/api/http"

function getErrorMessage(error) {
  return extractErrorMessage(error, "上传失败")
}

export function KnowledgeUploadCard({ onUpload }) {
  const inputRef = React.useRef(null)
  const [file, setFile] = React.useState(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")

  const handleChange = (event) => {
    setFile(event.target.files?.[0] ?? null)
    setError("")
  }

  const handleUpload = async () => {
    if (!file) {
      return
    }

    setLoading(true)
    setError("")

    try {
      await onUpload?.(file)
      setFile(null)

      if (inputRef.current) {
        inputRef.current.value = ""
      }
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <GlassPanel aria-label="知识库上传" className="upload-panel">
      <div className="upload-panel__copy">
        <p className="upload-panel__eyebrow">文档源文件</p>
        <h2>上传知识库文档</h2>
        <p>上传后仍需在重建页执行索引任务，文档才会真正参与检索。</p>
      </div>
      <label className="upload-dropzone">
        <div className="upload-dropzone__icon">
          <FileUp size={20} />
        </div>
        <div>
          <strong>选择知识文档</strong>
          <p>支持单文件上传，适合逐份治理和版本追踪。</p>
        </div>
        <input ref={inputRef} aria-label="上传知识库文档" type="file" onChange={handleChange} />
      </label>
      {file ? <p>待上传文件: {file.name}</p> : null}
      <button className="primary-action" disabled={loading || !file} type="button" onClick={handleUpload}>
        {loading ? "上传中..." : "上传文档"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </GlassPanel>
  )
}
