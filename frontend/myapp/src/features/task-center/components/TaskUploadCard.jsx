import * as React from "react"
import { CloudUpload, ImageIcon } from "lucide-react"

import { uploadTasks } from "../api/task-api"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function TaskUploadCard({ onUploaded }) {
  const [files, setFiles] = React.useState([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState("")

  const handleChange = (event) => {
    setFiles(Array.from(event.target.files ?? []))
    setError("")
  }

  const handleUpload = async () => {
    if (files.length === 0) {
      return
    }

    setLoading(true)
    setError("")

    try {
      await uploadTasks(files)
      setFiles([])
      onUploaded?.()
    } catch (nextError) {
      setError(nextError?.response?.data?.detail ?? (nextError instanceof Error ? nextError.message : "上传失败"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <GlassPanel aria-label="任务上传" className="upload-panel">
      <div className="upload-panel__copy">
        <p className="upload-panel__eyebrow">上传检测</p>
        <h2>上传待检测图片</h2>
        <p>批量图片会拆成独立任务，自动进入检测队列。</p>
      </div>

      <div className="upload-panel__body">
        <label className="upload-dropzone">
          <div className="upload-dropzone__icon">
            <CloudUpload size={20} />
          </div>
          <div>
            <strong>上传文件</strong>
            <p>支持多文件选择，适合批量检测。</p>
          </div>
          <input aria-label="上传文件" multiple type="file" onChange={handleChange} />
        </label>

        <div className="upload-panel__meta">
          <p className="upload-panel__count">
            <ImageIcon size={16} />
            <span>{`已选择 ${files.length} 张图片`}</span>
          </p>
          <div className="upload-panel__note">
            <strong>提交后会发生什么</strong>
            <p>上传完成后会立刻创建检测任务，你可以继续筛选、查看详情或等待轮询更新。</p>
          </div>
          {files.length > 0 ? (
            <ul className="upload-panel__list">
              {files.slice(0, 3).map((file) => (
                <li key={`${file.name}-${file.size}`}>{file.name}</li>
              ))}
            </ul>
          ) : null}
          <button className="primary-action" disabled={loading || files.length === 0} type="button" onClick={handleUpload}>
            {loading ? "上传中..." : "上传任务"}
          </button>
        </div>
      </div>

      {error ? <p role="alert">{error}</p> : null}
    </GlassPanel>
  )
}
