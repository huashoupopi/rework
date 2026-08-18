import * as React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const createConfigMock = vi.fn()
const deleteConfigMock = vi.fn()
const updateConfigMock = vi.fn()

vi.mock("@/features/knowledge-admin/hooks/useChunkConfigs", () => ({
  useChunkConfigs: () => ({
    configs: [
      {
        chunk_overlap: 100,
        chunk_size: 600,
        id: 1,
        name: "默认配置",
      },
    ],
    createConfig: createConfigMock,
    deleteConfig: deleteConfigMock,
    error: null,
    loading: false,
    refresh: vi.fn(),
    updateConfig: updateConfigMock,
  }),
}))

const { KnowledgeChunkConfigsPage } = await import("./KnowledgeChunkConfigsPage")

afterEach(() => {
  createConfigMock.mockReset()
  deleteConfigMock.mockReset()
  updateConfigMock.mockReset()
})

test("renders config table and create entry", () => {
  render(<KnowledgeChunkConfigsPage />)

  expect(screen.getByRole("heading", { name: "分块配置" })).toBeInTheDocument()
  expect(screen.getByText("切分策略")).toBeInTheDocument()
  expect(screen.getByText("维护分块参数，平衡入库质量与检索召回率。")).toBeInTheDocument()
  expect(screen.getByText("默认配置")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "新建配置" })).toBeInTheDocument()
})

test("opens create and edit entry, then submits and deletes", async () => {
  createConfigMock.mockResolvedValueOnce({
    id: 2,
  })
  updateConfigMock.mockResolvedValueOnce({
    id: 1,
  })
  deleteConfigMock.mockResolvedValueOnce({
    success: true,
  })

  render(<KnowledgeChunkConfigsPage />)

  fireEvent.click(screen.getByRole("button", { name: "新建配置" }))
  expect(screen.getByRole("dialog", { name: "新建分块配置" })).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText("配置名称"), {
    target: {
      value: "调试配置",
    },
  })
  fireEvent.change(screen.getByLabelText("Chunk Size"), {
    target: {
      value: "800",
    },
  })
  fireEvent.change(screen.getByLabelText("Chunk Overlap"), {
    target: {
      value: "120",
    },
  })
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }))

  await waitFor(() => {
    expect(createConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        chunk_overlap: 120,
        chunk_size: 800,
        name: "调试配置",
      }),
    )
  })

  fireEvent.click(screen.getByRole("button", { name: "编辑 默认配置" }))
  expect(screen.getByRole("dialog", { name: "编辑分块配置" })).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "保存配置" }))

  await waitFor(() => {
    expect(updateConfigMock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        name: "默认配置",
      }),
    )
  })

  fireEvent.click(screen.getByRole("button", { name: "删除 默认配置" }))

  await waitFor(() => {
    expect(deleteConfigMock).toHaveBeenCalledWith(1)
  })
})

test("renders the real chunk config table with Antd table chrome", async () => {
  const { ChunkConfigTable } = await vi.importActual(
    "@/features/knowledge-admin/components/ChunkConfigTable",
  )

  const { container } = render(
    <ChunkConfigTable
      configs={[
        {
          chunk_overlap: 100,
          chunk_size: 600,
          id: 1,
          name: "默认配置",
        },
      ]}
      onCreate={vi.fn()}
      onDelete={vi.fn()}
      onEdit={vi.fn()}
    />,
  )

  expect(container.querySelector(".ant-table")).toBeInTheDocument()
  expect(container.querySelector(".ant-btn-primary")).toBeInTheDocument()
})
