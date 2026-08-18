import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getChunkConfigsMock = vi.fn()
const createChunkConfigMock = vi.fn()
const updateChunkConfigMock = vi.fn()
const deleteChunkConfigMock = vi.fn()

vi.mock("../api/knowledge-api", () => ({
  createChunkConfig: (...args) => createChunkConfigMock(...args),
  deleteChunkConfig: (...args) => deleteChunkConfigMock(...args),
  getChunkConfigs: (...args) => getChunkConfigsMock(...args),
  updateChunkConfig: (...args) => updateChunkConfigMock(...args),
}))

const { useChunkConfigs } = await import("./useChunkConfigs")

afterEach(() => {
  createChunkConfigMock.mockReset()
  deleteChunkConfigMock.mockReset()
  getChunkConfigsMock.mockReset()
  updateChunkConfigMock.mockReset()
})

test("loads chunk configs on mount", async () => {
  getChunkConfigsMock.mockResolvedValueOnce([
    {
      chunk_overlap: 100,
      chunk_size: 600,
      id: 1,
      name: "默认配置",
    },
  ])

  const { result } = renderHook(() => useChunkConfigs())

  await waitFor(() => {
    expect(getChunkConfigsMock).toHaveBeenCalledTimes(1)
  })

  await waitFor(() => {
    expect(result.current.configs).toEqual([
      {
        chunk_overlap: 100,
        chunk_size: 600,
        id: 1,
        name: "默认配置",
      },
    ])
  })
})

test("createConfig, updateConfig, and deleteConfig refresh the config list", async () => {
  getChunkConfigsMock
    .mockResolvedValueOnce([
      {
        id: 1,
        name: "默认配置",
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 1,
        name: "默认配置",
      },
      {
        id: 2,
        name: "调试配置",
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 1,
        name: "默认配置-已更新",
      },
      {
        id: 2,
        name: "调试配置",
      },
    ])
    .mockResolvedValueOnce([
      {
        id: 1,
        name: "默认配置-已更新",
      },
    ])

  createChunkConfigMock.mockResolvedValueOnce({
    id: 2,
  })
  updateChunkConfigMock.mockResolvedValueOnce({
    id: 1,
  })
  deleteChunkConfigMock.mockResolvedValueOnce({
    success: true,
  })

  const { result } = renderHook(() => useChunkConfigs())

  await waitFor(() => {
    expect(getChunkConfigsMock).toHaveBeenCalledTimes(1)
  })

  await act(async () => {
    await result.current.createConfig({
      chunk_overlap: 100,
      chunk_size: 600,
      name: "调试配置",
    })
  })

  await act(async () => {
    await result.current.updateConfig(1, {
      chunk_overlap: 120,
      chunk_size: 800,
      name: "默认配置-已更新",
    })
  })

  await act(async () => {
    await result.current.deleteConfig(2)
  })

  expect(createChunkConfigMock).toHaveBeenCalledWith({
    chunk_overlap: 100,
    chunk_size: 600,
    name: "调试配置",
  })
  expect(updateChunkConfigMock).toHaveBeenCalledWith(1, {
    chunk_overlap: 120,
    chunk_size: 800,
    name: "默认配置-已更新",
  })
  expect(deleteChunkConfigMock).toHaveBeenCalledWith(2)
  await waitFor(() => {
    expect(getChunkConfigsMock).toHaveBeenCalledTimes(4)
  })
})

test("createConfig surfaces validation and conflict errors to the caller", async () => {
  const conflictError = new Error("同名配置已存在")

  getChunkConfigsMock.mockResolvedValueOnce([])
  createChunkConfigMock.mockRejectedValueOnce(conflictError)

  const { result } = renderHook(() => useChunkConfigs())

  await waitFor(() => {
    expect(getChunkConfigsMock).toHaveBeenCalledTimes(1)
  })

  await expect(
    result.current.createConfig({
      chunk_overlap: 500,
      chunk_size: 500,
      name: "非法配置",
    }),
  ).rejects.toThrow("chunk_overlap 必须小于 chunk_size")

  await expect(
    result.current.createConfig({
      chunk_overlap: 100,
      chunk_size: 500,
      name: "默认配置",
    }),
  ).rejects.toBe(conflictError)
})
