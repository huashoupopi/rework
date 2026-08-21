import * as React from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  Bot,
  ClipboardList,
  FileText,
  Home,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings2,
  UploadCloud,
  Users,
} from "lucide-react"

import { useReducedMotion } from "motion/react"

import { useAuthStore } from "@/features/auth/store/auth-store"
import { useShellStore } from "@/features/app-shell/store/useShellStore"
import { http } from "@/shared/api/http"
import { tokenDurationSeconds } from "@/shared/lib/utils"
import { PageTransition } from "@/shared/ui/PageTransition"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

// code = 图号。工程图纸每张都有编号，这里给每个页面一个稳定编号，
// 顶栏按「REWORK / DWG-03 · 智能问答」显示，比一个孤零零的页名有分量。
// 编号跟导航顺序走，不跟路由字符串走 —— 换路径不影响它。
// 风电运维是 24 小时轮班的，夜里巡检和复核都照常。22:00-06:00 顶栏挂一个
// 夜班标记 —— 这是彩蛋，但不是无由来的花哨：它对着这个行业的真实作息。
function isNightShift() {
  const hour = new Date().getHours()
  return hour >= 22 || hour < 6
}

const navigationItems = [
  { label: "工作台", path: "/", icon: Home, code: "01" },
  { label: "任务中心", path: "/tasks", icon: UploadCloud, code: "02" },
  { label: "智能问答", path: "/chat", icon: Bot, code: "03" },
  { label: "知识库文档", path: "/knowledge/documents", icon: FileText, adminOnly: true, code: "04" },
  { label: "索引重建", path: "/knowledge/rebuild", icon: RefreshCw, adminOnly: true, code: "05" },
  { label: "分块配置", path: "/knowledge/chunk-configs", icon: Settings2, adminOnly: true, code: "06" },
  { label: "用户管理", path: "/users", icon: Users, adminOnly: true, code: "07" },
  { label: "评测报告", path: "/evals", icon: ClipboardList, adminOnly: true, code: "08" },
]

export function AppShell() {
  const clearAuth = useAuthStore((state) => state.clearAuth)
  const userInfo = useAuthStore((state) => state.userInfo)
  const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useShellStore((state) => state.toggleSidebar)
  const visibleItems = navigationItems.filter((item) => !item.adminOnly || userInfo?.is_superuser)
  const coreItems = visibleItems.filter((item) => !item.adminOnly)
  const adminItems = visibleItems.filter((item) => item.adminOnly)
  const location = useLocation()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const [logoSpinning, setLogoSpinning] = React.useState(false)
  const logoClicksRef = React.useRef(0)
  // 彩蛋：点图号进「制图模式」—— 网格线加深、四角显出坐标角标，
  // 像把图纸切到细节视图。再点一下退出。
  const [draftMode, setDraftMode] = React.useState(false)
  // 顶栏风机：常速慢转。切页面时转快一下 —— 这不是装饰，是「页面换了」的反馈；
  // 点一下也会加速，跟登录页那台大风机是同一个彩蛋。
  const [gust, setGust] = React.useState(false)
  const gustTimerRef = React.useRef(null)

  const blowGust = React.useCallback((ms = 2200) => {
    window.clearTimeout(gustTimerRef.current)
    setGust(true)
    gustTimerRef.current = window.setTimeout(() => setGust(false), ms)
  }, [])

  React.useEffect(() => {
    blowGust(1400)
  }, [location.pathname, blowGust])

  React.useEffect(() => () => window.clearTimeout(gustTimerRef.current), [])

  const [nightShift, setNightShift] = React.useState(isNightShift)

  React.useEffect(() => {
    // 每分钟对一次表：有人会在 21:5x 打开页面一直挂着
    const timer = window.setInterval(() => setNightShift(isNightShift()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const activeItem = visibleItems.find((item) =>
    item.path === "/"
      ? location.pathname === "/"
      : location.pathname === item.path || location.pathname.startsWith(`${item.path}/`),
  )

  function handleLogoClick() {
    logoClicksRef.current += 1
    if (logoClicksRef.current < 5) {
      return
    }

    logoClicksRef.current = 0
    setLogoSpinning(true)
    const spinMs = reduceMotion ? 0 : tokenDurationSeconds("--easter-logo-spin", 3000) * 1000
    window.setTimeout(() => {
      setLogoSpinning(false)
    }, spinMs)
  }

  async function handleLogout() {
    try {
      await http.get("/auth/logout")
    } catch {
      // 即使后端请求失败也继续登出
    }
    clearAuth()
    navigate("/login", { replace: true })
  }

  return (
    <div className="app-shell" data-draft={draftMode ? "true" : "false"} data-sidebar-collapsed={sidebarCollapsed}>
      <aside className="app-sidebar" data-collapsed={sidebarCollapsed} role="complementary">
        <div className="app-sidebar__brand">
          <button
            aria-label="REWORK 标志"
            className="app-sidebar__brand-mark"
            data-spinning={logoSpinning ? "true" : "false"}
            onClick={handleLogoClick}
            type="button"
          >
            {logoSpinning ? <WindTurbineSvg boost spinning /> : "R"}
          </button>
          {!sidebarCollapsed && (
            <div className="app-sidebar__brand-copy">
              <p>REWORK</p>
              <span>智能检测平台</span>
            </div>
          )}
        </div>

        <button
          aria-pressed={sidebarCollapsed}
          className="app-sidebar__toggle"
          onClick={toggleSidebar}
          type="button"
        >
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          {!sidebarCollapsed && <span>收起</span>}
        </button>

        <nav aria-label="主导航" className="app-sidebar__nav">
          <div className="app-sidebar__group">
            {!sidebarCollapsed && <p className="app-sidebar__group-label">工作台</p>}
            {coreItems.map((item) => (
              <NavLink
                key={item.path}
                className={({ isActive }) =>
                  ["app-sidebar__link", isActive ? "app-sidebar__link--active" : ""].filter(Boolean).join(" ")
                }
                end={item.path === "/"}
                title={sidebarCollapsed ? item.label : undefined}
                to={item.path}
              >
                <item.icon size={18} />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </NavLink>
            ))}
          </div>

          {adminItems.length > 0 ? (
            <div className="app-sidebar__group">
              {!sidebarCollapsed && <p className="app-sidebar__group-label">管理</p>}
              {adminItems.map((item) => (
                <NavLink
                  key={item.path}
                  className={({ isActive }) =>
                    ["app-sidebar__link", isActive ? "app-sidebar__link--active" : ""].filter(Boolean).join(" ")
                  }
                  title={sidebarCollapsed ? item.label : undefined}
                  to={item.path}
                >
                  <item.icon size={18} />
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}
            </div>
          ) : null}
        </nav>

      </aside>

      <div className="app-shell__main">
        <header className="app-topbar">
          <div className="app-topbar__intro">
            <button
              aria-label="让风机转快一点"
              className="app-topbar__turbine"
              onClick={() => blowGust()}
              title="点一下试试"
              type="button"
            >
              <WindTurbineSvg boost={gust} spinning />
            </button>
            <button
              aria-label={draftMode ? "退出制图模式" : "进入制图模式"}
              aria-pressed={draftMode}
              className="app-topbar__code"
              onClick={() => setDraftMode((on) => !on)}
              title="DWG"
              type="button"
            >
              DWG-{activeItem?.code ?? "01"}
            </button>
            {/* 顶栏显示的是「当前位置」，页面内容里的 PageWorkband 才是真正的页面标题。
                这里曾用 <h1>，导致每页两个 H1、同一个词在一屏内显示两遍。
                样式走 .app-topbar__title 这个 class，改标签不影响视觉。 */}
            <p className="app-topbar__title">{activeItem?.label ?? "工作台"}</p>
            {nightShift ? (
              <span className="app-topbar__shift" title="22:00–06:00">
                夜班
              </span>
            ) : null}
          </div>
          <div className="app-topbar__actions">
            <div className="user-badge" title={userInfo?.is_superuser ? "管理员" : "成员"}>
              <span className="user-badge__avatar">{String(userInfo?.username ?? "访客").slice(0, 1).toUpperCase()}</span>
              <strong>{userInfo?.username ?? "访客"}</strong>
            </div>
            <button aria-label="退出登录" className="app-topbar__logout" onClick={handleLogout} type="button">
              <LogOut size={16} />
            </button>
          </div>
        </header>

        <main className="app-shell__content">
          <div className="app-shell__canvas">
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </div>
        </main>
      </div>
    </div>
  )
}
