/**
 * Collaboration endpoint resolution.
 *
 * Resolution order:
 *   1. User-configured remote collab server URL (localStorage)
 *   2. Derived from Builder backend URL (same-origin deployment — private fork default)
 */

import { resolveBackendWsUrl } from './backend-url'
import { resolveApiEndpoint } from './api-endpoint'

// ---------------------------------------------------------------------------
// localStorage-backed collab server URL
// ---------------------------------------------------------------------------

const COLLAB_SERVER_URL_KEY = 'forge-collab-server-url'

/**
 * Get the user-configured remote collab server URL.
 * Returns `null` if not configured (same-origin fallback).
 */
export function getCollabServerUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(COLLAB_SERVER_URL_KEY)
    return stored && stored.trim().length > 0 ? stored.trim() : null
  } catch {
    return null
  }
}

/**
 * Set (or clear) the remote collab server URL.
 * Pass `null` to clear and revert to same-origin fallback.
 */
export function setCollabServerUrl(url: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (url && url.trim().length > 0) {
      localStorage.setItem(COLLAB_SERVER_URL_KEY, url.trim())
    } else {
      localStorage.removeItem(COLLAB_SERVER_URL_KEY)
    }
  } catch {
    // localStorage unavailable — silent no-op
  }
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the base HTTP URL for collaboration REST API calls.
 *
 * Returns a fully qualified origin string (e.g. "https://collab.example.com/")
 * that can be combined with API paths.
 */
export function resolveCollaborationApiBaseUrl(): string {
  const configured = getCollabServerUrl()
  if (configured) {
    // Ensure trailing slash for URL base resolution
    const normalized = configured.endsWith('/') ? configured : configured + '/'
    return normalized
  }

  // Fallback: same-origin (private fork where collab backend IS the Builder)
  const wsUrl = resolveBackendWsUrl()
  return resolveApiEndpoint(wsUrl, '/')
}

/**
 * Resolve the WebSocket URL for the collaboration transport.
 *
 * Returns a ws(s):// URL ready for `WebSocketTransport`.
 */
export function resolveCollaborationWsUrl(): string {
  const configured = getCollabServerUrl()
  if (configured) {
    // Derive WS URL: https:// → wss://, http:// → ws://
    try {
      const parsed = new URL(configured)
      parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:'
      return parsed.origin.replace(/^http/, 'ws')
    } catch {
      // Malformed URL — fall through to same-origin
    }
  }

  // Fallback: same-origin Builder backend WS
  return resolveBackendWsUrl()
}
