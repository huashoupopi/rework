import * as React from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  Bot,
  FileText,
  Home,
  Layers3,
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
import { ShimmerText } from "@/shared/ui/ShimmerText"
import { WindTurbineSvg } from "@/shared/ui/WindTurbineSvg"

const navigationItems = [
  { label: "工作台", path: "/", icon: Home },
  { label: "任务中心", path: "/tasks", icon: UploadCloud },
  { label: "智能问答", path: "/chat", icon: Bot },
  { label: "知识库文档", path: "/knowledge/documents", icon: FileText, adminOnly: true },
  { label: "索引重建", path: "/knowledge/rebuild", icon: RefreshCw, adminOnly: true },
  { label: "分块配置", path: "/knowledge/chunk-configs", icon: Settings2, adminOnly: true },
  { label: "用户管理", path: "/users", icon: Users, adminOnly: true },
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
    <div className="app-shell" data-sidebar-collapsed={sidebarCollapsed}>
      <div aria-hidden="true" className="app-shell__aurora app-shell__aurora--one" />
      <div aria-hidden="true" className="app-shell__aurora app-shell__aurora--two" />
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
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
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

        {!sidebarCollapsed && (
          <div className="app-sidebar__footnote">
            <Layers3 size={16} />
            <div>
              <strong>AI 检测工作流</strong>
              <p>检测、问答、知识管理一站式协同。</p>
            </div>
          </div>
        )}
      </aside>

      <div className="app-shell__main">
        <header className="app-topbar">
          <div className="app-topbar__intro">
            <p className="app-topbar__eyebrow">REWORK OPERATIONS</p>
            <h1 className="app-topbar__title">
              <ShimmerText as="span">{activeItem?.label ?? "工作台"}</ShimmerText>
            </h1>
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
