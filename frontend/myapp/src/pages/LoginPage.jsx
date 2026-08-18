import * as React from "react"
import { Alert, Form, Input, Typography } from "antd"
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom"
import { useReducedMotion } from "motion/react"

import { getCurrentUser, login } from "@/features/auth/api/auth-api"
import { useAuthStore } from "@/features/auth/store/auth-store"
import { tokenDurationSeconds } from "@/shared/lib/utils"
import { GlassButton } from "@/shared/ui/GlassButton"
import { GlassCard } from "@/shared/ui/GlassCard"

import { AuthScene } from "./AuthScene"

export function LoginPage() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)
  const setAuth = useAuthStore((state) => state.setAuth)
  const clearAuth = useAuthStore((state) => state.clearAuth)
  const [errorMessage, setErrorMessage] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [failCount, setFailCount] = React.useState(0)
  const [boost, setBoost] = React.useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const locked = failCount >= 3

  if (hydrated && token) {
    return <Navigate replace to="/" />
  }

  async function handleFinish(values) {
    if (locked) {
      return
    }

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

      setBoost(true)
      const delayMs = reduceMotion ? 0 : tokenDurationSeconds("--motion-slow", 220) * 3000
      if (delayMs > 0) {
        await new Promise((resolve) => {
          window.setTimeout(resolve, delayMs)
        })
      }

      navigate(location.state?.from?.pathname ?? "/", { replace: true })
    } catch (error) {
      clearAuth()
      const nextFails = failCount + 1
      setFailCount(nextFails)
      setErrorMessage(
        nextFails >= 3
          ? "叶片检修中，请稍后再试"
          : (error?.response?.data?.detail ?? "登录失败，请稍后重试"),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthScene
      boost={boost}
      description="基于深度学习的缺陷检测、知识管理与智能问答平台。"
      spinning={!locked}
      stopped={locked}
      titleLines={["风机叶片", "智能检测"]}
    >
      <GlassCard className="auth-card">
        <div className="auth-card__copy">
          <p className="auth-card__eyebrow">登录</p>
          <Typography.Title level={2}>欢迎回来</Typography.Title>
          <Typography.Paragraph type="secondary">登录以访问你的工作台。</Typography.Paragraph>
        </div>
        {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}
        <Form className="auth-form" layout="vertical" onFinish={handleFinish}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input disabled={locked} placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password disabled={locked} placeholder="请输入密码" />
          </Form.Item>
          <GlassButton className="glass-button--block glass-button--primary" disabled={locked || submitting} type="submit">
            {submitting ? "叶片加速中" : "登录"}
          </GlassButton>
        </Form>
        <Typography.Paragraph>
          <Link to="/register">没有账号？立即注册</Link>
        </Typography.Paragraph>
      </GlassCard>
    </AuthScene>
  )
}
