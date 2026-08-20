import * as React from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  Bot,
  ClipboardList,
  FileText,
  LibraryBig,
  RefreshCw,
  UploadCloud,
  Users,
} from "lucide-react"

import { useAuthStore } from "@/features/auth/store/auth-store"
import { InteractiveHoverButton } from "@/shared/ui/magicui/interactive-hover-button"
import { Meteors } from "@/shared/ui/magicui/meteors"
import { Pointer } from "@/shared/ui/magicui/pointer"
import { RippleButton } from "@/shared/ui/magicui/ripple-button"
import { InView } from "@/shared/ui/motion-primitives/in-view"
import { SlidingNumber } from "@/shared/ui/motion-primitives/sliding-number"
import { Spotlight } from "@/shared/ui/motion-primitives/spotlight"
import { PageWorkband } from "@/shared/ui/PageWorkband"

function HomeHeroScene({ username, userRole }) {
  return (
    <div className="home-hero-scene">
      <div className="home-hero-scene__identity">
        <p>当前账号</p>
        <strong>{username}</strong>
        <span>{`你好，${username}`}</span>
      </div>
      <div aria-hidden="true" className="home-hero-scene__signal">
        <Meteors maxDuration={9} minDuration={5} number={4} />
        <Pointer />
        <ol className="home-flow">
          <li>上传</li>
          <li>复核</li>
          <li>追问</li>
        </ol>
      </div>
      <div className="home-hero-scene__facts">
        <div className="home-hero-scene__fact">
          <span>角色</span>
          <strong>{userRole}</strong>
        </div>
        <div className="home-hero-scene__fact">
          <span>今日节奏</span>
          <strong className="home-step-count__meter">
            <SlidingNumber value={3} />
            <span>步 · 上传 / 复核 / 追问</span>
          </strong>
        </div>
      </div>
    </div>
  )
}

export function HomePage() {
  const userInfo = useAuthStore((state) => state.userInfo)
  const userRole = userInfo?.is_superuser ? "管理员" : "成员"
  const username = userInfo?.username ?? "访客"

  return (
    <div className="page-stack">
      <PageWorkband
        actions={
          <div className="dashboard-hero__actions">
            <Link to="/tasks">
              <InteractiveHoverButton type="button">
                <UploadCloud size={16} />
                上传检测任务
              </InteractiveHoverButton>
            </Link>
            <Link to="/chat">
              <RippleButton className="secondary-action border-0" rippleColor="rgba(77,141,255,0.28)" type="button">
                <Bot size={16} />
                智能问答
              </RippleButton>
            </Link>
          </div>
        }
        aside={
          <HomeHeroScene username={username} userRole={userRole} />
        }
        className="dashboard-workband"
        description="上传叶片图片、查看缺陷分析结果，或在智能问答中继续深入。"
        eyebrow="工作台"
        footer={
          <InView once>
            <section className="quick-entry-grid" aria-label="快捷入口">
              <Link className="quick-entry-card" to="/tasks">
                <Spotlight className="from-[rgba(77,141,255,0.2)] via-[rgba(77,141,255,0.08)] to-transparent" size={220} />
                <div className="quick-entry-card__icon quick-entry-card__icon--blue">
                  <UploadCloud size={20} />
                </div>
                <div className="quick-entry-card__body">
                  <strong>任务中心</strong>
                  <p>上传叶片图片，查看缺陷检测结果</p>
                </div>
                <ArrowRight size={16} className="quick-entry-card__arrow" />
              </Link>
              <Link className="quick-entry-card" to="/chat">
                <Spotlight className="from-[rgba(77,141,255,0.2)] via-[rgba(77,141,255,0.08)] to-transparent" size={220} />
                <div className="quick-entry-card__icon quick-entry-card__icon--purple">
                  <Bot size={20} />
                </div>
                <div className="quick-entry-card__body">
                  <strong>智能问答</strong>
                  <p>基于检测结果进行深度分析对话</p>
                </div>
                <ArrowRight size={16} className="quick-entry-card__arrow" />
              </Link>
              {userInfo?.is_superuser && (
                <Link className="quick-entry-card" to="/knowledge/documents">
                  <Spotlight className="from-[rgba(77,141,255,0.2)] via-[rgba(77,141,255,0.08)] to-transparent" size={220} />
                  <div className="quick-entry-card__icon quick-entry-card__icon--green">
                    <LibraryBig size={20} />
                  </div>
                  <div className="quick-entry-card__body">
                    <strong>知识库管理</strong>
                    <p>文档上传、索引重建与分块配置</p>
                  </div>
                  <ArrowRight size={16} className="quick-entry-card__arrow" />
                </Link>
              )}
            </section>
          </InView>
        }
        supporting="今天先完成上传、复核和追问。"
        title="从这里开始今天的检测工作"
      />

      {userInfo?.is_superuser && (
        <section className="admin-grid" aria-label="管理入口">
          <p className="admin-grid__label">管理员功能</p>
          <div className="admin-grid__items">
            <Link className="admin-link-card" to="/knowledge/documents">
              <FileText size={16} />
              <span>知识库文档</span>
            </Link>
            <Link className="admin-link-card" to="/knowledge/rebuild">
              <RefreshCw size={16} />
              <span>索引重建</span>
            </Link>
            <Link className="admin-link-card" to="/users">
              <Users size={16} />
              <span>用户管理</span>
            </Link>
            <Link className="admin-link-card" to="/evals">
              <ClipboardList size={16} />
              <span>评测报告</span>
            </Link>
          </div>
        </section>
      )}
    </div>
  )
}
