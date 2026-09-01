/**
 * Vitest's builtin jsdom environment copies window keys onto globalThis only
 * when they are absent (or listed in its allowlist). Node 26 experimental Web
 * Storage already owns `localStorage` / `sessionStorage` on globalThis, and
 * `localStorage` is undefined unless `--localstorage-file` is passed. Those
 * host globals therefore shadow jsdom's isolated Storage and break the jsdom
 * test contract.
 *
 * Rebind both APIs from the JSDOM window after environment setup so every
 * jsdom test gets deterministic, origin-scoped storage regardless of the host
 * Node version. Restore the host descriptors for Node-environment files so a
 * reused worker cannot leak a previous jsdom Storage.
 */
import { afterEach, beforeEach } from 'vitest'

const HOST_WEB_STORAGE_CACHE = Symbol.for('forge.ui.vitest.host-web-storage')
const WEB_STORAGE_KEYS = ['localStorage', 'sessionStorage'] as const

type WebStorageKey = (typeof WEB_STORAGE_KEYS)[number]

type JsdomHolder = {
  jsdom?: { window?: Window }
}

type HostWebStorageCache = {
  descriptors: Record<WebStorageKey, PropertyDescriptor | undefined>
}

function getJsdomWindow(): Window | undefined {
  return (globalThis as typeof globalThis & JsdomHolder).jsdom?.window
}

function snapshotHostWebStorageDescriptors(): HostWebStorageCache['descriptors'] {
  const jsdomWindow = getJsdomWindow()
  const descriptors = {} as HostWebStorageCache['descriptors']

  for (const key of WEB_STORAGE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    if (!descriptor) {
      descriptors[key] = undefined
      continue
    }

    let current: unknown
    try {
      current = globalThis[key]
    } catch {
      current = undefined
    }

    // If Vitest already copied jsdom storage onto globalThis (Node 22), keep
    // treating the host as having no distinct storage global. Node 26's
    // experimental getters return a different value, so they are preserved.
    if (jsdomWindow && current === jsdomWindow[key]) {
      descriptors[key] = undefined
      continue
    }

    descriptors[key] = descriptor
  }

  return descriptors
}

function getHostWebStorageCache(): HostWebStorageCache {
  const holder = globalThis as typeof globalThis & {
    [HOST_WEB_STORAGE_CACHE]?: HostWebStorageCache
  }
  const existing = holder[HOST_WEB_STORAGE_CACHE]
  if (existing) return existing

  const cache: HostWebStorageCache = {
    descriptors: snapshotHostWebStorageDescriptors(),
  }
  holder[HOST_WEB_STORAGE_CACHE] = cache
  return cache
}

function bindJsdomWebStorage(jsdomWindow: Window): void {
  for (const key of WEB_STORAGE_KEYS) {
    const storage = jsdomWindow[key]
    if (!storage) continue
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: storage,
    })
  }
}

function restoreHostWebStorage(): void {
  const { descriptors } = getHostWebStorageCache()
  for (const key of WEB_STORAGE_KEYS) {
    const descriptor = descriptors[key]
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor)
      continue
    }
    Reflect.deleteProperty(globalThis, key)
  }
}

function clearWebStorage(storage: unknown): void {
  if (storage == null || typeof storage !== 'object') return
  const clear = Reflect.get(storage, 'clear')
  if (typeof clear !== 'function') return
  try {
    clear.call(storage)
  } catch {
    // Host Node experimental storage can be present but unusable.
  }
}

function resetJsdomWebStorage(): void {
  if (!getJsdomWindow()) return
  clearWebStorage(globalThis.localStorage)
  clearWebStorage(globalThis.sessionStorage)
}

const jsdomWindow = getJsdomWindow()
getHostWebStorageCache()
if (jsdomWindow) {
  bindJsdomWebStorage(jsdomWindow)
} else {
  restoreHostWebStorage()
}

beforeEach(() => {
  resetJsdomWebStorage()
})

afterEach(() => {
  resetJsdomWebStorage()
})
