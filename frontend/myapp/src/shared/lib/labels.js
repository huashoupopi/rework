// 后端枚举 → 中文显示名的唯一来源。
// 起因：DEFECT_NAMES 原本只在 TaskTable 里，任务详情、文档列表、重建页
// 各自直接渲染后端英文值，于是中文界面里蹦出 completed / corrosion /
// active / indexed。⛔ 新增映射一律加在这里，不要在页面里另写一份。

export const DEFECT_COLORS = {
  corrosion: "#f0803c",
  craze: "#ff6b6e",
  hide_craze: "#9d6bff",
  surface_attach: "#1890ff",
  surface_corrosion: "#ffa940",
  surface_eye: "#13c2c2",
  surface_injure: "#eb2f96",
  surface_oil: "#52c41a",
  thunderstrike: "#faad14",
}

export const DEFECT_NAMES = {
  corrosion: "腐蚀",
  craze: "裂纹",
  hide_craze: "隐裂",
  surface_attach: "附着物",
  surface_corrosion: "表面腐蚀",
  surface_eye: "气孔",
  surface_injure: "表面损伤",
  surface_oil: "油污",
  thunderstrike: "雷击",
}

export const TASK_STATUS_NAMES = {
  completed: "已完成",
  failed: "失败",
  pending: "待处理",
  progressing: "处理中",
}

export const DOCUMENT_STATUS_NAMES = {
  active: "生效中",
  deleted: "已删除",
}

export const INDEX_STATUS_NAMES = {
  failed: "索引失败",
  indexed: "已索引",
  indexing: "索引中",
  pending: "待索引",
}

// 查不到就原样返回 —— 后端新增枚举时宁可露出英文，也不显示空白或 "undefined"。
function lookup(dict, value) {
  if (value === null || value === undefined || value === "") {
    return ""
  }
  return dict[value] ?? String(value)
}

export function defectName(value) {
  return lookup(DEFECT_NAMES, value)
}

export function defectColor(value) {
  return DEFECT_COLORS[value] ?? "#2563eb"
}

export function taskStatusName(value) {
  return lookup(TASK_STATUS_NAMES, value)
}

export function documentStatusName(value) {
  return lookup(DOCUMENT_STATUS_NAMES, value)
}

export function indexStatusName(value) {
  return lookup(INDEX_STATUS_NAMES, value)
}
