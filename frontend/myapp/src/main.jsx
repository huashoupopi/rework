import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { AppProvider } from "@/app/AppProvider"
import "./index.css"

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppProvider />
  </StrictMode>,
)
