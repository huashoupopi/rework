import * as React from "react"
import { Alert, Button, Form, Input, Typography } from "antd"
import { Link, Navigate, useNavigate } from "react-router-dom"

import { register } from "@/features/auth/api/auth-api"
import { useAuthStore } from "@/features/auth/store/auth-store"
import { GlassPanel } from "@/shared/ui/GlassPanel"

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
      setErrorMessage(error?.response?.data?.detail ?? "注册失败，请稍后重试")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-stage">
        <section className="auth-hero">
          <p className="auth-hero__eyebrow">REWORK</p>
          <h1>创建你的账号</h1>
          <p className="auth-hero__description">加入智能检测平台，开始使用 AI 驱动的工作流。</p>
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
            <p className="auth-card__eyebrow">注册</p>
            <Typography.Title level={2}>开始使用</Typography.Title>
            <Typography.Paragraph type="secondary">
              创建账号以访问完整功能。
            </Typography.Paragraph>
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
            <Button block htmlType="submit" loading={submitting} type="primary">
              注册
            </Button>
          </Form>
          <Typography.Paragraph>
            <Link to="/login">已有账号？去登录</Link>
          </Typography.Paragraph>
        </GlassPanel>
      </div>
    </main>
  )
}
