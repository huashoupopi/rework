import * as React from "react"

const DEFECT_COLORS = {
  corrosion: "#f0803c",
  crack: "#ff6b6e",
  craze: "#ff6b6e",
  hide_craze: "#9d6bff",
  surface_attach: "#1890ff",
  surface_corrosion: "#ffa940",
  surface_eye: "#13c2c2",
  surface_injure: "#eb2f96",
  surface_oil: "#52c41a",
  thunderstrike: "#fadb14",
  default: "#2563eb",
}

function getPreviewUrl(originalPath) {
  if (!originalPath || typeof originalPath !== "string") {
    return ""
  }

  if (originalPath.startsWith("http://") || originalPath.startsWith("https://")) {
    return originalPath
  }

  if (originalPath.startsWith("/")) {
    return originalPath
  }

  return `/${originalPath}`
}

function getStatusCopy(status) {
  if (status === "progressing" || status === "pending") {
    return "正在检测中，结果生成后会自动刷新。"
  }

  if (status === "failed") {
    return "检测失败，请检查原始图片或稍后重试。"
  }

  return ""
}

function getLabelColor(defectClass) {
  return DEFECT_COLORS[defectClass] ?? DEFECT_COLORS.default
}

function drawLabel(context, color, text, x, y, width, containerWidth, containerTop) {
  context.font = "12px sans-serif"
  const textWidth = context.measureText(text).width + 10
  const labelHeight = 22
  let labelX = x
  let labelY = y - labelHeight - 6

  if (labelX + textWidth > containerWidth) {
    labelX = Math.max(0, x + width - textWidth)
  }

  if (labelY < containerTop) {
    labelY = y + 6
  }

  context.fillStyle = `${color}dd`
  context.fillRect(labelX, labelY, textWidth, labelHeight)
  context.fillStyle = "#ffffff"
  context.fillText(text, labelX + 5, labelY + 15)
}

function drawBoxes({ canvas, container, naturalSize, objects }) {
  const context = canvas.getContext("2d")

  if (!context) {
    return
  }

  const containerWidth = container.clientWidth || naturalSize.width
  const containerHeight = container.clientHeight || naturalSize.height

  // object-fit: contain 下计算图片实际渲染尺寸
  const imageAspect = naturalSize.width / naturalSize.height
  const containerAspect = containerWidth / containerHeight
  let displayWidth, displayHeight
  if (imageAspect > containerAspect) {
    displayWidth = containerWidth
    displayHeight = containerWidth / imageAspect
  } else {
    displayHeight = containerHeight
    displayWidth = containerHeight * imageAspect
  }

  const offsetX = (containerWidth - displayWidth) / 2
  const offsetY = (containerHeight - displayHeight) / 2
  const scaleX = displayWidth / naturalSize.width
  const scaleY = displayHeight / naturalSize.height
  const devicePixelRatio = window.devicePixelRatio || 1

  canvas.width = Math.max(1, Math.round(containerWidth * devicePixelRatio))
  canvas.height = Math.max(1, Math.round(containerHeight * devicePixelRatio))
  canvas.style.width = `${containerWidth}px`
  canvas.style.height = `${containerHeight}px`

  if (typeof context.setTransform === "function") {
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
  } else if (typeof context.scale === "function") {
    context.scale(devicePixelRatio, devicePixelRatio)
  }

  context.clearRect(0, 0, containerWidth, containerHeight)

  for (const object of objects) {
    if (!Array.isArray(object?.box) || object.box.length < 4) {
      continue
    }

    const [x1, y1, x2, y2] = object.box
    const x = x1 * scaleX + offsetX
    const y = y1 * scaleY + offsetY
    const width = (x2 - x1) * scaleX
    const height = (y2 - y1) * scaleY
    const color = getLabelColor(object?.class)
    const confidence =
      typeof object?.confidence === "number" ? ` ${(object.confidence * 100).toFixed(0)}%` : ""

    context.strokeStyle = color
    context.lineWidth = 2
    context.strokeRect(x, y, width, height)
    drawLabel(
      context,
      color,
      `${object?.class ?? "defect"}${confidence}`,
      x,
      y,
      width,
      containerWidth,
      offsetY,
    )
  }
}

export function TaskImagePreview({ task }) {
  const containerRef = React.useRef(null)
  const imageRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const previewUrl = getPreviewUrl(task?.original_path)
  const [naturalSize, setNaturalSize] = React.useState(null)
  const [loadError, setLoadError] = React.useState(false)
  const rawObjects = task?.detect_result?.objects
  const isCompleted = task?.status === "completed"
  const statusCopy = getStatusCopy(task?.status)
  const objectCount = Array.isArray(rawObjects) ? rawObjects.length : 0

  React.useEffect(() => {
    setLoadError(false)
    setNaturalSize(null)

    if (!previewUrl || !isCompleted) {
      return undefined
    }

    const img = new Image()
    img.onload = () => {
      setNaturalSize({
        height: img.naturalHeight || 1,
        width: img.naturalWidth || 1,
      })
    }
    img.onerror = () => {
      setLoadError(true)
    }
    img.src = previewUrl

    return undefined
  }, [isCompleted, previewUrl])

  React.useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const imageElement = imageRef.current

    if (!isCompleted || !canvas || !container || !imageElement || !naturalSize) {
      return undefined
    }

    drawBoxes({
      canvas,
      container,
      naturalSize,
      objects: Array.isArray(rawObjects) ? rawObjects : [],
    })

    return undefined
  }, [isCompleted, naturalSize, previewUrl, rawObjects])

  if (!previewUrl || loadError) {
    return (
      <section aria-label="任务图像预览" className="task-image-preview task-image-preview--empty">
        <div className="task-image-preview__header">
          <p className="page-header__eyebrow">检测预览</p>
          <h3>原图预览</h3>
        </div>
        <div className="task-image-preview__empty">
          <p>原始图片不可用</p>
        </div>
      </section>
    )
  }

  return (
    <section aria-label="任务图像预览" className="task-image-preview">
      <div className="task-image-preview__header">
        <div>
          <p className="page-header__eyebrow">检测预览</p>
          <h3>原图可视化</h3>
        </div>
        {isCompleted ? (
          <p className="task-image-preview__badge">{`识别 ${objectCount} 个对象`}</p>
        ) : null}
      </div>
      <div className="task-image-preview__surface" ref={containerRef}>
        <img
          alt={`${task?.file_name ?? "任务图片"} 原图预览`}
          className="task-image-preview__image"
          ref={imageRef}
          src={previewUrl}
        />
        {isCompleted ? (
          <canvas
            aria-label="检测标框画布"
            className="task-image-preview__canvas"
            ref={canvasRef}
          />
        ) : null}
        {statusCopy ? (
          <div
            className={`task-image-preview__overlay task-image-preview__overlay--${task?.status ?? "idle"}`}
          >
            <span>{statusCopy}</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
