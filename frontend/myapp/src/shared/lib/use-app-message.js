import { App, message as staticMessage } from "antd"

/**
 * 取 antd 的 message API，没有 <App> 包裹时回落到静态版本。
 *
 * 2026-08-21 起因：组件直接用 App.useApp() 拿 message，但没有 <App> 祖先时
 * useApp() 返回的是空对象 —— 调 message.error() 就是 TypeError，而它发生在
 * async 的 catch 里，冒成 Unhandled Rejection。
 *
 * 本地 `vitest run` 仍报 180 passed（vitest 把它算未处理错误而非测试失败），
 * 但 CI 的 `pnpm test:run` 退出码是 1，整条流水线红。
 * 这就是「本地绿不等于 CI 绿」的一个实例。
 *
 * 兜底放在这里而不是每个测试都包一层 <App>：组件不该假设自己一定在
 * Provider 里面，尤其是只用来弹提示的这种旁路能力。
 */
export function useAppMessage() {
  const app = App.useApp()
  return typeof app?.message?.error === "function" ? app.message : staticMessage
}
