/**
 * Centralized backend WebSocket URL resolution.
 *
 * Resolution priority:
 *   1. window.electronBridge.backendWsUrl  (Electron preload injection)
 *   2. VITE_FORGE_WS_URL / VITE_MIDDLEMAN_WS_URL  (build-time env var)
 *   3. Port-based heuristic from window.location  (web fallback)
 */

import '@/lib/electron-bridge' // ensure global Window augmentation is loaded

const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:47187'

/**
 * Resolve the backend WebSocket URL using the 3-tier priority chain.
 *
 * Safe to call at module scope or inside components — handles SSR
 * (typeof window === 'undefined') by returning the dev default.
 */
export function resolveBackendWsUrl(): string {
  // SSR / non-browser context
  if (typeof window === 'undefined') {
    return DEFAULT_DEV_WS_URL
  }

  // 1. Electron preload bridge (highest priority)
  if (
    window.electronBridge &&
    typeof window.electronBridge.backendWsUrl === 'string' &&
    window.electronBridge.backendWsUrl.length > 0
  ) {
    return window.electronBridge.backendWsUrl
  }

  // 2. Build-time env var override
  const envUrl =
    (import.meta.env.VITE_FORGE_WS_URL as string | undefined) ??
    (import.meta.env.VITE_MIDDLEMAN_WS_URL as string | undefined)
  if (envUrl) {
    return envUrl
  }

  // 3. Port-based heuristic (unchanged web behavior)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  const uiPort =
    Number(window.location.port) ||
    (window.location.protocol === 'https:' ? 443 : 80)
  // Dev UI runs on 47188 -> backend 47187, prod UI runs on 47189 -> backend 47287.
  const wsPort = uiPort <= 47188 ? 47187 : 47287

  return `${protocol}//${hostname}:${wsPort}`
}
