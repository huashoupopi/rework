import * as React from "react"

const DEFAULT_VALUES = {
  chunk_overlap: 150,
  chunk_size: 800,
  description: "",
  is_active: true,
  is_default: false,
  metadata_policy: "basic",
  min_chunk_len: 20,
  name: "",
  splitter: "sentence",
}

function getInitialValues(initialValues) {
  return {
    ...DEFAULT_VALUES,
    ...(initialValues ?? {}),
  }
}

function toSubmitPayload(values) {
  return {
    ...values,
    chunk_overlap: Number(values.chunk_overlap),
    chunk_size: Number(values.chunk_size),
    min_chunk_len: Number(values.min_chunk_len),
  }
}

export function ChunkConfigFormModal({ initialValues, mode = "create", onCancel, onSubmit, open = false }) {
  const [formValues, setFormValues] = React.useState(getInitialValues(initialValues))
  const [error, setError] = React.useState("")

  React.useEffect(() => {
    if (!open) {
      return
    }

    setError("")
    setFormValues(getInitialValues(initialValues))
  }, [initialValues, open])

  if (!open) {
    return null
  }

  const title = mode === "edit" ? "编辑分块配置" : "新建分块配置"

  const handleChange = (key, value) => {
    setFormValues((currentValues) => ({
      ...currentValues,
      [key]: value,
    }))
  }

  const handleSubmit = async () => {
    try {
      setError("")
      await onSubmit?.(toSubmitPayload(formValues))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "保存失败")
    }
  }

  return (
    <section aria-label={title} role="dialog">
      <h2>{title}</h2>
      <label>
        配置名称
        <input
          aria-label="配置名称"
          type="text"
          value={formValues.name}
          onChange={(event) => handleChange("name", event.target.value)}
        />
      </label>
      <label>
        Chunk Size
        <input
          aria-label="Chunk Size"
          type="number"
          value={formValues.chunk_size}
          onChange={(event) => handleChange("chunk_size", event.target.value)}
        />
      </label>
      <label>
        Chunk Overlap
        <input
          aria-label="Chunk Overlap"
          type="number"
          value={formValues.chunk_overlap}
          onChange={(event) => handleChange("chunk_overlap", event.target.value)}
        />
      </label>
      <label>
        Min Chunk Len
        <input
          aria-label="Min Chunk Len"
          type="number"
          value={formValues.min_chunk_len}
          onChange={(event) => handleChange("min_chunk_len", event.target.value)}
        />
      </label>
      <label>
        Splitter
        <select
          aria-label="Splitter"
          value={formValues.splitter}
          onChange={(event) => handleChange("splitter", event.target.value)}
        >
          <option value="sentence">sentence</option>
          <option value="markdown">markdown</option>
        </select>
      </label>
      <label>
        Metadata Policy
        <select
          aria-label="Metadata Policy"
          value={formValues.metadata_policy}
          onChange={(event) => handleChange("metadata_policy", event.target.value)}
        >
          <option value="basic">basic</option>
          <option value="debug">debug</option>
        </select>
      </label>
      <label>
        描述
        <textarea aria-label="描述" value={formValues.description} onChange={(event) => handleChange("description", event.target.value)} />
      </label>
      <label>
        <input
          aria-label="设为默认"
          checked={Boolean(formValues.is_default)}
          type="checkbox"
          onChange={(event) => handleChange("is_default", event.target.checked)}
        />
        设为默认
      </label>
      <label>
        <input
          aria-label="启用配置"
          checked={Boolean(formValues.is_active)}
          type="checkbox"
          onChange={(event) => handleChange("is_active", event.target.checked)}
        />
        启用配置
      </label>
      <div>
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" onClick={handleSubmit}>
          保存配置
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  )
}
