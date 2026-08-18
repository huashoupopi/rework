import * as React from "react"
import { App, ConfigProvider } from "antd"
import { RouterProvider } from "react-router-dom"

import { createAppRouter } from "@/app/router"
import { antdTheme } from "@/app/theme"
import { AuthBootstrap } from "@/features/auth/components/AuthBootstrap"

export function AppProvider() {
  const router = React.useMemo(() => createAppRouter(), [])

  return (
    <ConfigProvider theme={antdTheme}>
      <App>
        <AuthBootstrap>
          <RouterProvider router={router} />
        </AuthBootstrap>
      </App>
    </ConfigProvider>
  )
}
