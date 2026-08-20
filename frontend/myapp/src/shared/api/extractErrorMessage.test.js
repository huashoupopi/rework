import { expect, test } from "vitest"

import { extractErrorMessage } from "./http"

// 回归钉：批次 2 把密码规则改成 8-128 后，注册短密码会返回 Pydantic 422，
// detail 是对象数组。旧代码把它直接塞进 React，整页崩在
// "Objects are not valid as a React child"。
test("flattens FastAPI 422 detail arrays into a readable string", () => {
  const error = {
    response: {
      data: {
        detail: [
          {
            ctx: { min_length: 8 },
            input: "123",
            loc: ["body", "password"],
            msg: "String should have at least 8 characters",
            type: "string_too_short",
          },
        ],
      },
    },
  }

  const message = extractErrorMessage(error, "注册失败")

  expect(typeof message).toBe("string")
  expect(message).toContain("password")
  expect(message).toContain("String should have at least 8 characters")
})

test("joins multiple validation errors", () => {
  const error = {
    response: {
      data: {
        detail: [
          { loc: ["body", "username"], msg: "field required" },
          { loc: ["body", "password"], msg: "too short" },
        ],
      },
    },
  }

  expect(extractErrorMessage(error, "失败")).toBe("username：field required；password：too short")
})

test("passes through a plain string detail from HTTPException", () => {
  const error = { response: { data: { detail: "用户名已存在" } } }

  expect(extractErrorMessage(error, "注册失败")).toBe("用户名已存在")
})

test("falls back when detail is absent", () => {
  expect(extractErrorMessage({}, "注册失败")).toBe("注册失败")
  expect(extractErrorMessage(null, "注册失败")).toBe("注册失败")
})

test("never returns a non-string, whatever detail holds", () => {
  const weird = { response: { data: { detail: { nested: { deep: true } } } } }

  expect(typeof extractErrorMessage(weird, "兜底")).toBe("string")
})
