/**
 * Centralized backend WebSocket URL resolution.
 *
 * Resolution priority:
 *   1. window.electronBridge.backendWsUrl  (Electron preload injection)
 *   2. window.__forgeRemoteRuntimeConfig (packaged trusted-network UI)
 *   3. VITE_FORGE_WS_URL / VITE_MIDDLEMAN_WS_URL  (build-time env var)
 *   4. VITE_FORGE_WS_PORT / VITE_MIDDLEMAN_WS_PORT combined with window.location
 *   5. Port-based heuristic from window.location  (web fallback)
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

function parseBackendPort(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65_535
      ? value
      : undefined
  }

  if (!value?.trim()) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : undefined
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
    runtimePort?: string | number
    envUrl?: string
    envPort?: string
    webBaseMode?: UiWebBaseMode
  },
): string {
  if (options?.electronWsUrl) {
    return options.electronWsUrl
  }

  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = locationLike.hostname
  const uiPort = resolveLocationPort(locationLike)
  const runtimePort = parseBackendPort(options?.runtimePort)
  if (runtimePort !== undefined) {
    return `${protocol}//${hostname}:${runtimePort}`
  }

  if (options?.envUrl) {
    return options.envUrl
  }

  const backendPort =
    parseBackendPort(options?.envPort) ??
    resolveBackendPort(uiPort, options?.webBaseMode ?? 'auto')

  return `${protocol}//${hostname}:${backendPort}`
}

/**
 * Resolve the backend WebSocket URL using the priority chain above.
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
    runtimePort: getPackagedRemoteRuntimePort(),
    envUrl:
      (import.meta.env.VITE_FORGE_WS_URL as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_WS_URL as string | undefined),
    envPort:
      (import.meta.env.VITE_FORGE_WS_PORT as string | undefined) ??
      (import.meta.env.VITE_MIDDLEMAN_WS_PORT as string | undefined),
    webBaseMode: getConfiguredUiWebBaseMode(),
  })
}

function getPackagedRemoteRuntimePort(): string | number | undefined {
  const runtimeConfig = (window as typeof window & {
    __forgeRemoteRuntimeConfig?: { backendPort?: unknown }
  }).__forgeRemoteRuntimeConfig
  const backendPort = runtimeConfig?.backendPort
  return typeof backendPort === 'string' || typeof backendPort === 'number'
    ? backendPort
    : undefined
}
