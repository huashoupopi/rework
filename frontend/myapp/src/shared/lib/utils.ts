import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function readCssToken(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback
  }

  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

export function tokenDurationSeconds(name: string, fallbackMs: number): number {
  const raw = readCssToken(name, `${fallbackMs}ms`)
  if (raw.endsWith("ms")) {
    return Number.parseFloat(raw) / 1000
  }
  if (raw.endsWith("s")) {
    return Number.parseFloat(raw)
  }
  const asNumber = Number.parseFloat(raw)
  return Number.isFinite(asNumber) ? asNumber : fallbackMs / 1000
}
