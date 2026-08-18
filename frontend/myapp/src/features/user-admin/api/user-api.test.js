import { expect, test, vi } from "vitest"

const getMock = vi.fn()
const deleteMock = vi.fn()

vi.mock("@/shared/api/http", () => ({
  http: {
    delete: (...args) => deleteMock(...args),
    get: (...args) => getMock(...args),
  },
}))

const { deleteUser, getUsers } = await import("./user-api")

test("getUsers maps page and pageSize to skip and limit", async () => {
  getMock.mockResolvedValueOnce({
    data: [
      {
        id: 1,
        username: "admin",
      },
    ],
  })

  const result = await getUsers({
    page: 3,
    pageSize: 20,
  })

  expect(getMock).toHaveBeenCalledWith("/users", {
    params: {
      limit: 20,
      skip: 40,
    },
  })
  expect(result).toEqual([
    {
      id: 1,
      username: "admin",
    },
  ])
})

test("deleteUser calls the delete endpoint for the target user", async () => {
  deleteMock.mockResolvedValueOnce({
    data: null,
  })

  const result = await deleteUser(9)

  expect(deleteMock).toHaveBeenCalledWith("/users/9")
  expect(result).toBeNull()
})
