import * as React from "react"
import { Alert, Form, Input, Typography } from "antd"
import { Link, Navigate, useNavigate } from "react-router-dom"

import { register } from "@/features/auth/api/auth-api"
import { useAuthStore } from "@/features/auth/store/auth-store"
import { extractErrorMessage } from "@/shared/api/http"
import { GlassCard } from "@/shared/ui/GlassCard"

import { AuthScene } from "./AuthScene"

export function RegisterPage() {
  const hydrated = useAuthStore((state) => state.hydrated)
  const token = useAuthStore((state) => state.token)
  const [errorMessage, setErrorMessage] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const navigate = useNavigate()

  if (hydrated && token) {
    return <Navigate replace to="/" />
  }

  async function handleFinish(values) {
    setSubmitting(true)
    setErrorMessage("")

    try {
      await register(values)
      navigate("/login", { replace: true })
    } catch (error) {
      setErrorMessage(extractErrorMessage(error, "注册失败，请稍后重试"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthScene
      description="加入智能检测平台，开始使用 AI 驱动的工作流。"
      titleLines={["创建你的", "账号"]}
    >
      <GlassCard className="auth-card">
        <div className="auth-card__copy">
          <p className="auth-card__eyebrow">注册</p>
          <Typography.Title level={2}>开始使用</Typography.Title>
          <Typography.Paragraph type="secondary">创建账号以访问完整功能。</Typography.Paragraph>
        </div>
        {errorMessage ? <Alert message={errorMessage} showIcon type="error" /> : null}
        <Form className="auth-form" layout="vertical" onFinish={handleFinish}>
          <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
            <Input placeholder="请输入用户名" />
          </Form.Item>
          <Form.Item label="姓名" name="full_name">
            <Input placeholder="请输入姓名（选填）" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password placeholder="请输入密码" />
          </Form.Item>
          <button className="primary-action primary-action--block" disabled={submitting} type="submit">
            注册
          </button>
        </Form>
        <Typography.Paragraph>
          <Link to="/login">已有账号？去登录</Link>
        </Typography.Paragraph>
      </GlassCard>
    </AuthScene>
  )
}
