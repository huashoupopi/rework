import { http } from "@/shared/api/http"

export async function getUsers({ page = 1, pageSize = 100 } = {}) {
  const skip = Math.max(0, (page - 1) * pageSize)
  const limit = pageSize

  const response = await http.get("/users", {
    params: {
      limit,
      skip,
    },
  })

  return response.data
}

export async function deleteUser(userId) {
  const response = await http.delete(`/users/${userId}`)

  return response.data
}
