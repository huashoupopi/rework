import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { AnimatedNumber } from "./AnimatedNumber"
import { AuroraBackground } from "./AuroraBackground"
import { EmptyState } from "./EmptyState"
import { GlassButton } from "./GlassButton"
import { GlassCard } from "./GlassCard"
import { GlassPanel } from "./GlassPanel"
import { PageTransition } from "./PageTransition"
import { ShimmerText } from "./ShimmerText"
import { SpotlightCard } from "./SpotlightCard"
import { StaggerList } from "./StaggerList"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubReducedMotion(enabled: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: enabled && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  )
}

test("foundation components render their content", () => {
  stubReducedMotion(false)
  render(
    <>
      <GlassCard>卡片</GlassCard>
      <GlassPanel>转发壳</GlassPanel>
      <GlassButton>提交</GlassButton>
      <AuroraBackground>极光</AuroraBackground>
      <SpotlightCard>光斑</SpotlightCard>
      <ShimmerText as="h1">标题微光</ShimmerText>
      <StaggerList>
        <p>一项</p>
      </StaggerList>
      <PageTransition>转场</PageTransition>
      <AnimatedNumber value={12} />
      <EmptyState description="还没有任务" title="空状态" />
    </>,
  )

  expect(screen.getByText("卡片")).toBeInTheDocument()
  expect(screen.getByText("转发壳")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "提交" })).toBeInTheDocument()
  expect(screen.getByText("极光")).toBeInTheDocument()
  expect(screen.getByText("光斑")).toBeInTheDocument()
  expect(screen.getByRole("heading", { name: "标题微光" })).toBeInTheDocument()
  expect(screen.getByText("一项")).toBeInTheDocument()
  expect(screen.getByText("转场")).toBeInTheDocument()
  expect(screen.getByText("空状态")).toBeInTheDocument()
})

test("reduced motion still renders the same labels", async () => {
  stubReducedMotion(true)
  render(
    <>
      <AuroraBackground>静态极光</AuroraBackground>
      <ShimmerText>静态标题</ShimmerText>
      <AnimatedNumber value={7} />
    </>,
  )

  expect(screen.getByText("静态极光")).toBeInTheDocument()
  expect(screen.getByText("静态标题")).toBeInTheDocument()
  await waitFor(() => {
    expect(screen.getByText("7")).toBeInTheDocument()
  })
})
