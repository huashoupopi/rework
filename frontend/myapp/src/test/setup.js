import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

globalThis.AbortController = window.AbortController
globalThis.AbortSignal = window.AbortSignal

function createMemoryStorage() {
  const store = new Map()

  return {
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
    get length() {
      return store.size
    },
  }
}

const localStorageMock = createMemoryStorage()
const sessionStorageMock = createMemoryStorage()

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: localStorageMock,
})

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: localStorageMock,
})

Object.defineProperty(window, "sessionStorage", {
  configurable: true,
  value: sessionStorageMock,
})

Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: sessionStorageMock,
})

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query) => ({
    addEventListener: () => {},
    addListener: () => {},
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => {},
    removeListener: () => {},
  }),
})

class ResizeObserverMock {
  disconnect() {}
  observe() {}
  unobserve() {}
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  value: ResizeObserverMock,
})

Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: () => {},
})

const originalGetComputedStyle = window.getComputedStyle.bind(window)

Object.defineProperty(window, "getComputedStyle", {
  configurable: true,
  value: (element, pseudoElement) => {
    if (typeof pseudoElement === "string" && pseudoElement.length > 0) {
      return originalGetComputedStyle(element)
    }

    return originalGetComputedStyle(element, pseudoElement)
  },
})

afterEach(() => {
  cleanup()
  localStorageMock.clear()
  sessionStorageMock.clear()
})
