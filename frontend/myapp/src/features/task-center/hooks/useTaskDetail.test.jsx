import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getTaskDetailMock = vi.fn()
const downloadTaskImageMock = vi.fn()

vi.mock("../api/task-api", () => ({
  downloadTaskImage: (...args) => downloadTaskImageMock(...args),
  getTaskDetail: (...args) => getTaskDetailMock(...args),
}))

const { useTaskDetail } = await import("./useTaskDetail")

afterEach(() => {
  vi.useRealTimers()
  getTaskDetailMock.mockReset()
  downloadTaskImageMock.mockReset()
})

test("loads task detail for the provided task id", async () => {
  getTaskDetailMock.mockResolvedValueOnce({
    id: 7,
    status: "completed",
    detect_result: {
      objects: [],
      total: 0,
    },
  })

  const { result } = renderHook(() => useTaskDetail(7))

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledWith(7)
  })

  await waitFor(() => {
    expect(result.current.loading).toBe(false)
  })

  expect(result.current.task).toMatchObject({
    id: 7,
    status: "completed",
  })
  expect(result.current.error).toBeNull()
})

test("keeps polling while a task is progressing", async () => {
  getTaskDetailMock
    .mockResolvedValueOnce({
      id: 7,
      status: "progressing",
      detect_result: null,
    })
    .mockResolvedValueOnce({
      id: 7,
      status: "completed",
      detect_result: {
        objects: [],
        total: 1,
      },
    })

  const { result } = renderHook(() => useTaskDetail(7, { pollIntervalMs: 50 }))

  await act(async () => {
    await Promise.resolve()
  })

  expect(getTaskDetailMock).toHaveBeenCalledWith(7)
  expect(result.current.task).toMatchObject({
    id: 7,
    status: "progressing",
  })

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledTimes(2)
  })

  expect(getTaskDetailMock).toHaveBeenCalledTimes(2)
  expect(getTaskDetailMock).toHaveBeenLastCalledWith(7)

  await waitFor(() => {
    expect(result.current.task).toMatchObject({
      id: 7,
      status: "completed",
    })
  })
})

test("stops polling when a task fails", async () => {
  getTaskDetailMock.mockResolvedValueOnce({
    id: 7,
    status: "failed",
    detect_result: null,
  })

  const { result } = renderHook(() => useTaskDetail(7, { pollIntervalMs: 50 }))

  await waitFor(() => {
    expect(getTaskDetailMock).toHaveBeenCalledWith(7)
    expect(result.current.task).toMatchObject({
      id: 7,
      status: "failed",
    })
  })

  await new Promise((resolve) => {
    setTimeout(resolve, 30)
  })

  expect(getTaskDetailMock).toHaveBeenCalledTimes(1)
})

test("clears the previous task when the task id changes", async () => {
  getTaskDetailMock
    .mockResolvedValueOnce({
      id: 7,
      status: "completed",
      detect_result: {
        objects: [],
        total: 1,
      },
    })
    .mockRejectedValueOnce(new Error("load failed"))

  const { result, rerender } = renderHook(({ taskId }) => useTaskDetail(taskId), {
    initialProps: { taskId: 7 },
  })

  await waitFor(() => {
    expect(result.current.task).toMatchObject({
      id: 7,
      status: "completed",
    })
  })

  rerender({ taskId: 8 })

  await waitFor(() => {
    expect(result.current.task).toBeNull()
    expect(result.current.error).toBeInstanceOf(Error)
  })
})
