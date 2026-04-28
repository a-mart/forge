/**
 * Centralized backend WebSocket URL resolution.
 *
 * Resolution priority:
 *   1. window.electronBridge.backendWsUrl  (Electron preload injection)
 *   2. VITE_FORGE_WS_URL / VITE_MIDDLEMAN_WS_URL  (build-time env var)
 *   3. Port-based heuristic from window.location  (web fallback)
 */

import '@/lib/electron-bridge' // ensure global Window augmentation is loaded
import { getConfiguredUiWebBaseMode, type UiWebBaseMode } from './web-runtime-flags'

const DEFAULT_DEV_WS_URL = 'ws://127.0.0.1:47187'
const DEV_UI_PORT = 47188
const DEV_BACKEND_PORT = 47187
const PREVIEW_UI_PORT = 47189
const PROD_BACKEND_PORT = 47287

interface LocationLike {
  protocol: string
  hostname: string
  port: string
}

function resolveLocationPort(locationLike: LocationLike): number {
  return Number(locationLike.port) || (locationLike.protocol === 'https:' ? 443 : 80)
}

function resolveBackendPort(uiPort: number, webBaseMode: UiWebBaseMode): number {
  if (webBaseMode === 'same-origin') {
    return uiPort
  }

  if (uiPort === DEV_UI_PORT) {
    return DEV_BACKEND_PORT
  }

  if (uiPort === PREVIEW_UI_PORT) {
    return PROD_BACKEND_PORT
  }

  return uiPort
}

export function resolveBackendWsUrlFromLocation(
  locationLike: LocationLike,
  options?: {
    electronWsUrl?: string
    envUrl?: string
    webBaseMode?: UiWebBaseMode
  },
): string {
  if (options?.electronWsUrl) {
    return options.electronWsUrl
  }

  if (options?.envUrl) {
    return options.envUrl
  }

  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = locationLike.hostname
  const uiPort = resolveLocationPort(locationLike)
  const backendPort = resolveBackendPort(uiPort, options?.webBaseMode ?? 'auto')

  return `${protocol}//${hostname}:${backendPort}`
}

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

  return resolveBackendWsUrlFromLocation(window.location, {
    electronWsUrl:
      window.electronBridge &&
      typeof window.electronBridge.backendWsUrl === 'string' &&
      window.electronBridge.backendWsUrl.length > 0
        ? window.electronBridge.backendWsUrl
        : undefined,
    envUrl:
      (import.meta.env.VITE_FORGE_WS_URL as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_WS_URL as string | undefined),
    webBaseMode: getConfiguredUiWebBaseMode(),
  })
}
