import * as React from "react"
import { Alert, Button, Form, Input, Typography } from "antd"
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom"

import { getCurrentUser, login } from "@/features/auth/api/auth-api"
import { useAuthStore } from "@/features/auth/store/auth-store"
import { GlassPanel } from "@/shared/ui/GlassPanel"

export function LoginPage() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)
  const setAuth = useAuthStore((state) => state.setAuth)
  const clearAuth = useAuthStore((state) => state.clearAuth)
  const [errorMessage, setErrorMessage] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  if (hydrated && token) {
    return <Navigate replace to="/" />
  }

  async function handleFinish(values) {
    setSubmitting(true)
    setErrorMessage("")

    try {
      const tokenData = await login(values)

      setAuth({
        token: tokenData.access_token,
        userInfo: null,
      })

      const currentUser = await getCurrentUser()

      setAuth({
        token: tokenData.access_token,
        userInfo: currentUser,
      })

      navigate(location.state?.from?.pathname ?? "/", { replace: true })
    } catch (error) {
      clearAuth()
      setErrorMessage(error?.response?.data?.detail ?? "登录失败，请稍后重试")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-stage">
        <section className="auth-hero">
          <p className="auth-hero__eyebrow">REWORK</p>
          <h1>风机叶片智能检测</h1>
          <p className="auth-hero__description">基于深度学习的缺陷检测、知识管理与智能问答平台。</p>
          <div className="auth-hero__panel">
            <div className="auth-hero__metric">
              <span>检测</span>
              <strong>智能缺陷识别</strong>
              <p>上传图片即可获得自动化检测结果与结构化分析。</p>
            </div>
            <div className="auth-hero__metric">
              <span>问答</span>
              <strong>上下文对话</strong>
              <p>围绕检测任务展开深度分析，获得精准回答。</p>
            </div>
            <div className="auth-hero__metric">
              <span>知识</span>
              <strong>知识库治理</strong>
              <p>统一管理文档资产、索引构建与检索策略。</p>
            </div>
          </div>
        </section>

        <GlassPanel className="auth-card">
          <div className="auth-card__copy">
            <p className="auth-card__eyebrow">登录</p>
            <Typography.Title level={2}>欢迎回来</Typography.Title>
            <Typography.Paragraph type="secondary">
              登录以访问你的工作台。
            </Typography.Paragraph>
          </div>
          {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}
          <Form className="auth-form" layout="vertical" onFinish={handleFinish}>
            <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
              <Input placeholder="请输入用户名" />
            </Form.Item>
            <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password placeholder="请输入密码" />
            </Form.Item>
            <Button block htmlType="submit" loading={submitting} type="primary">
              登录
            </Button>
          </Form>
          <Typography.Paragraph>
            <Link to="/register">没有账号？立即注册</Link>
          </Typography.Paragraph>
        </GlassPanel>
      </div>
    </main>
  )
}
