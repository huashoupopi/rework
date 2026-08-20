import { expect, test, vi } from "vitest"

const getMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    get: (...args) => getMock(...args),
  },
}))

const { getEvalReport, listEvalReports } = await import("./eval-api")

test("listEvalReports requests /evals", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      items: [],
    },
  })

  const result = await listEvalReports()

  expect(getMock).toHaveBeenCalledWith("/evals")
  expect(result).toEqual({
    items: [],
  })
})

test("getEvalReport requests /evals/{name}", async () => {
  getMock.mockResolvedValueOnce({
    data: {
      name: "eval30_ok.json",
    },
  })

  const result = await getEvalReport("eval30_ok.json")

  expect(getMock).toHaveBeenCalledWith("/evals/eval30_ok.json")
  expect(result).toEqual({
    name: "eval30_ok.json",
  })
})
