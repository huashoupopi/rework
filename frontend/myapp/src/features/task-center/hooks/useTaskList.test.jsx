import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

const getTasksMock = vi.fn()

vi.mock("../api/task-api", () => ({
  getTasks: (...args) => getTasksMock(...args),
}))

const { useTaskList } = await import("./useTaskList")

afterEach(() => {
  vi.useRealTimers()
  getTasksMock.mockReset()
})

test("loads the first page on mount", async () => {
  getTasksMock.mockResolvedValueOnce({
    items: [
      {
        id: 1,
        status: "completed",
      },
    ],
    total: 1,
  })

  const { result } = renderHook(() => useTaskList())

  await waitFor(() => {
    expect(getTasksMock).toHaveBeenCalledWith(1, 10)
  })

  await waitFor(() => {
    expect(result.current.page).toBe(1)
    expect(result.current.pageSize).toBe(10)
    expect(result.current.tasks).toEqual([
      {
        id: 1,
        status: "completed",
      },
    ])
    expect(result.current.total).toBe(1)
  })
})

test("fetches the next page when page changes", async () => {
  getTasksMock
    .mockResolvedValueOnce({
      items: [
        {
          id: 1,
          status: "completed",
        },
      ],
      total: 2,
    })
    .mockResolvedValueOnce({
      items: [
        {
          id: 2,
          status: "completed",
        },
      ],
      total: 2,
    })

  const { result } = renderHook(() => useTaskList())

  await waitFor(() => {
    expect(getTasksMock).toHaveBeenCalledWith(1, 10)
  })

  act(() => {
    result.current.setPage(2)
  })

  await waitFor(() => {
    expect(getTasksMock).toHaveBeenCalledWith(2, 10)
  })

  expect(getTasksMock).toHaveBeenLastCalledWith(2, 10)
})

test("refresh reloads the current page", async () => {
  getTasksMock
    .mockResolvedValueOnce({
      items: [
        {
          id: 1,
          status: "completed",
        },
      ],
      total: 2,
    })
    .mockResolvedValueOnce({
      items: [
        {
          id: 1,
          status: "completed",
        },
        {
          id: 2,
          status: "completed",
        },
      ],
      total: 2,
    })

  const { result } = renderHook(() => useTaskList())

  await waitFor(() => {
    expect(getTasksMock).toHaveBeenCalledWith(1, 10)
  })

  act(() => {
    result.current.refresh()
  })

  await waitFor(() => {
    expect(getTasksMock).toHaveBeenCalledTimes(2)
  })

  expect(getTasksMock).toHaveBeenLastCalledWith(1, 10)
})

test("keeps polling while task is progressing", async () => {
  vi.useFakeTimers()

  getTasksMock
    .mockResolvedValueOnce({
      items: [
        {
          id: 1,
          status: "progressing",
        },
      ],
      total: 1,
    })
    .mockResolvedValueOnce({
      items: [
        {
          id: 1,
          status: "completed",
        },
      ],
      total: 1,
    })

  const { result } = renderHook(() => useTaskList({ pollIntervalMs: 1000 }))

  await act(async () => {
    await Promise.resolve()
  })

  expect(getTasksMock).toHaveBeenCalledWith(1, 10)

  expect(result.current.tasks).toEqual([
    {
      id: 1,
      status: "progressing",
    },
  ])

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
    await Promise.resolve()
  })

  expect(getTasksMock).toHaveBeenCalledTimes(2)

  expect(getTasksMock).toHaveBeenLastCalledWith(1, 10)
})
