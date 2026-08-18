import { http } from "@/shared/api/http"

export async function login({ password, username }) {
  const payload = new URLSearchParams()

  payload.set("username", username)
  payload.set("password", password)

  const response = await http.post("/auth/login", payload, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  })

  return response.data
}

export async function register(payload) {
  const response = await http.post("/auth/register", payload)

  return response.data
}

export async function getCurrentUser() {
  const response = await http.get("/users/me")

  return response.data
}
