import { expect, test, vi } from "vitest"

const getMock = vi.fn()
const postMock = vi.fn()
const downloadFileMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    get: (...args) => getMock(...args),
    post: (...args) => postMock(...args),
  },
  downloadFile: (...args) => downloadFileMock(...args),
}))

const {
  downloadTaskBatch,
  downloadTaskImage,
  exportTask,
  getTaskDetail,
  getTasks,
  uploadTasks,
} = await import("./task-api")

test("uploadTasks sends multipart files to /tasks/upload", async () => {
  postMock.mockResolvedValueOnce({
    data: [
      {
        id: 1,
        file_name: "demo.png",
      },
    ],
  })

  const file = new File(["file-content"], "demo.png", {
    type: "image/png",
  })

  const result = await uploadTasks([file])

  const [url, payload, config] = postMock.mock.calls.at(-1)

  expect(url).toBe("/tasks/upload")
  expect(payload).toBeInstanceOf(FormData)
  expect(payload.getAll("files")).toHaveLength(1)
  expect(payload.getAll("files")[0]).toBe(file)
  expect(config.headers["Content-Type"]).toBe("multipart/form-data")
  expect(result).toEqual([
    {
      id: 1,
      file_name: "demo.png",
    },
  ])
})

test("getTasks converts page and pageSize to skip and limit", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      total: 2,
      items: [],
    },
  })

  const result = await getTasks(3, 25)

  expect(getMock).toHaveBeenCalledWith("/tasks", {
    params: {
      limit: 25,
      skip: 50,
    },
  })
  expect(result).toEqual({
    items: [],
    total: 2,
  })
})

test("getTaskDetail requests the task detail endpoint", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      id: 7,
      status: "processing",
    },
  })

  const result = await getTaskDetail(7)

  expect(getMock).toHaveBeenCalledWith("/tasks/7")
  expect(result).toEqual({
    id: 7,
    status: "processing",
  })
})

test("downloadTaskImage uses the shared blob helper for the image endpoint", async () => {
  downloadFileMock.mockResolvedValueOnce({
    data: new Blob(["image"]),
  })

  await downloadTaskImage(9)

  expect(downloadFileMock).toHaveBeenCalledWith("/tasks/9/download/image")
})

test("exportTask hits the existing export endpoint with format", async () => {
  downloadFileMock.mockResolvedValueOnce({
    data: new Blob(["{}"]),
  })

  await exportTask(7, "json")
  expect(downloadFileMock).toHaveBeenCalledWith("/tasks/7/export", {
    params: { format: "json" },
  })

  downloadFileMock.mockResolvedValueOnce({
    data: new Blob(["csv"]),
  })
  await exportTask(7, "csv")
  expect(downloadFileMock).toHaveBeenCalledWith("/tasks/7/export", {
    params: { format: "csv" },
  })
})

test("downloadTaskBatch uses the shared blob helper for the batch endpoint", async () => {
  downloadFileMock.mockResolvedValueOnce({
    data: new Blob(["zip"]),
  })

  await downloadTaskBatch([1, 2, 3])

  expect(downloadFileMock).toHaveBeenCalledWith("/tasks/batch/download?task_ids=1&task_ids=2&task_ids=3")
})
