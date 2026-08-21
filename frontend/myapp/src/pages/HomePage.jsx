import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  Bot,
  ClipboardList,
  FileText,
  RefreshCw,
  UploadCloud,
  Users,
} from "lucide-react"

import { useAuthStore } from "@/features/auth/store/auth-store"
import { DEFECT_COLORS, DEFECT_NAMES } from "@/shared/lib/labels"
import { useTaskList } from "@/features/task-center/hooks/useTaskList"
import { InView } from "@/shared/ui/motion-primitives/in-view"

// 2026-08-21 推倒重写。原版的三处问题：
//   ① 整页包在 PageWorkband 这个巨型容器里 → 卡片套卡片套卡片
//   ② dashboard 顶了一个 marketing hero（「从这里开始今天的检测工作」）
//   ③ 一个数据都没有：`SlidingNumber value={3}` 是写死的假数字
// 现在改成 utility 模式：先给状态，再给动作，最后给入口。
// 数据走 useTaskList 的 statusCounts / total —— 后端本来就返回全量分布。

const STATUS_ROWS = [
  { key: "completed", label: "已完成" },
  { key: "progressing", label: "处理中" },
  { key: "pending", label: "待处理" },
  { key: "failed", label: "失败", tone: "danger" },
]

const PRIMARY_ACTIONS = [
  {
    to: "/tasks",
    icon: UploadCloud,
    title: "上传检测任务",
    copy: "叶片图像 → 自动缺陷识别与结构化分析",
  },
  {
    to: "/chat",
    icon: Bot,
    title: "智能问答",
    copy: "基于检测结果与知识库展开追问",
  },
]

const ADMIN_LINKS = [
  { to: "/knowledge/documents", icon: FileText, label: "知识库文档" },
  { to: "/knowledge/rebuild", icon: RefreshCw, label: "索引重建" },
  { to: "/users", icon: Users, label: "用户管理" },
  { to: "/evals", icon: ClipboardList, label: "评测报告" },
]

const STATUS_LABEL = {
  completed: "已完成",
  progressing: "处理中",
  pending: "待处理",
  failed: "失败",
}

function formatTime(value) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  const pad = (n) => String(n).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function HomePage() {
  const userInfo = useAuthStore((state) => state.userInfo)
  const username = userInfo?.username ?? "访客"
  const { statusCounts, tasks, total } = useTaskList()

  const counts = statusCounts ?? {}
  const recent = (tasks ?? []).slice(0, 6)

  // 缺陷分布只能按【已加载的这一页】统计 —— 后端的 status_counts 给的是
  // 任务状态的全量分布，缺陷明细在 detect_result 里，不随分页汇总。
  // 所以下面的标题写明「最近 N 条」，不写成全量，免得读的人以为是总账。
  const defects = React.useMemo(() => {
    const stats = {}
    let total = 0
    for (const task of tasks ?? []) {
      for (const obj of task.detect_result?.objects ?? []) {
        const cls = obj.class || "unknown"
        stats[cls] = (stats[cls] ?? 0) + 1
        total += 1
      }
    }
    const ranked = Object.entries(stats)
      .map(([cls, count]) => ({ cls, count, pct: total > 0 ? Math.round((count / total) * 100) : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
    return { ranked, total }
  }, [tasks])

  return (
    <div className="ops-page">
      <header className="ops-page__head">
        <div>
          <h1 className="ops-page__title">工作台</h1>
          <p className="ops-page__sub">
            {username} · {userInfo?.is_superuser ? "管理员" : "成员"}
          </p>
        </div>
      </header>

      {/* 概览：数字全部走等宽字与 tabular-nums，位宽不随数值变化跳动 */}
      <section aria-label="任务概览" className="ops-block ops-block--wide">
        <p className="ops-block__label">概览</p>
        <div className="stat-row">
          <div className="stat-row__cell">
            <span className="stat-row__num">{total ?? 0}</span>
            <span className="stat-row__key">总任务</span>
          </div>
          {STATUS_ROWS.map((row) => (
            <div className="stat-row__cell" data-tone={row.tone ?? "default"} key={row.key}>
              <span className="stat-row__num">{counts[row.key] ?? 0}</span>
              <span className="stat-row__key">{row.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="ops-columns">
        <InView once>
          <section aria-label="最近任务" className="ops-block">
            <div className="ops-block__headrow">
              <p className="ops-block__label">最近任务</p>
              <Link className="ops-block__more" to="/tasks">
                全部任务
                <ArrowRight size={13} strokeWidth={1.5} />
              </Link>
            </div>
            {recent.length === 0 ? (
              <p className="ops-empty">
                还没有检测任务。<Link to="/tasks">上传第一批叶片图像</Link>后，结果会出现在这里。
              </p>
            ) : (
              <ul className="record-list">
                {recent.map((task) => (
                  <li className="record-list__row" key={task.id}>
                    <span className="record-list__time">{formatTime(task.created_at)}</span>
                    <span className="record-list__name" title={task.file_name}>
                      {task.file_name}
                    </span>
                    <span className="record-list__status" data-status={task.status}>
                      {STATUS_LABEL[task.status] ?? task.status}
                    </span>
                    <Link className="record-list__link" to={`/tasks/${task.id}`}>
                      查看
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </InView>

        <section aria-label="缺陷分布" className="ops-block ops-block--defects">
          <div className="ops-block__headrow">
            <p className="ops-block__label">缺陷分布</p>
            <span className="ops-block__note">
              {defects.total > 0
                ? `最近 ${(tasks ?? []).length} 条任务共 ${defects.total} 处`
                : "暂无数据"}
            </span>
          </div>
          {defects.ranked.length === 0 ? (
            <p className="ops-empty">已加载的任务里还没有检出缺陷。</p>
          ) : (
            <ul className="defect-bars">
              {defects.ranked.map((item) => (
                <li className="defect-bars__row" key={item.cls}>
                  <span className="defect-bars__name">{DEFECT_NAMES[item.cls] ?? item.cls}</span>
                  <span className="defect-bars__track">
                    <span
                      className="defect-bars__fill"
                      style={{
                        background: DEFECT_COLORS[item.cls] ?? "#7c6f64",
                        width: `${Math.max(item.pct, 2)}%`,
                      }}
                    />
                  </span>
                  <span className="defect-bars__num">{item.count}</span>
                  <span className="defect-bars__pct">{item.pct}%</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="ops-side">
          <section aria-label="主要操作" className="ops-block">
            <p className="ops-block__label">主要操作</p>
            <div className="action-list action-list--stacked">
              {PRIMARY_ACTIONS.map((action) => (
                <Link className="action-list__row" key={action.to} to={action.to}>
                  <action.icon className="action-list__icon" size={18} strokeWidth={1.5} />
                  <span className="action-list__title">{action.title}</span>
                  <span className="action-list__copy">{action.copy}</span>
                  <ArrowRight className="action-list__arrow" size={15} strokeWidth={1.5} />
                </Link>
              ))}
            </div>
          </section>

          {userInfo?.is_superuser && (
            <section aria-label="管理入口" className="ops-block">
              <p className="ops-block__label">管理</p>
              <div className="chip-row">
                {ADMIN_LINKS.map((link) => (
                  <Link className="chip-row__item" key={link.to} to={link.to}>
                    <link.icon size={15} strokeWidth={1.5} />
                    <span>{link.label}</span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
