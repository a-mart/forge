/**
 * Collaboration endpoint resolution.
 *
 * Resolution order:
 *   1. User-configured remote collab server URL (localStorage)
 *   2. Derived from Forge backend URL (same-origin deployment)
 *
 * The no-arg exports (`resolveCollaborationApiBaseUrl()`,
 * `resolveCollaborationWsUrl()`, `isCollabServerRemote()`) are
 * **compatibility wrappers** that resolve the default/last-active
 * connection target.  New code should prefer the target-aware helpers
 * in `collaboration-connections.ts`.
 */

import {
  getDefaultCollaborationConnection,
  loadRegistry,
  normalizeServerUrl,
  removeCollaborationConnection,
  upsertCollaborationConnection,
  type CollaborationEndpointTarget,
} from './collaboration-connections'

// ---------------------------------------------------------------------------
// localStorage-backed collab server URL (legacy singleton)
// ---------------------------------------------------------------------------

const COLLAB_SERVER_URL_KEY = 'forge-collab-server-url'

/**
 * Get the user-configured remote collab server URL.
 * Returns `null` if not configured (same-origin fallback).
 *
 * @deprecated Prefer `getDefaultCollaborationConnection()` or explicit
 * `resolveCollaborationTarget(connectionId)` from `collaboration-connections`.
 */
export function getCollabServerUrl(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = localStorage.getItem(COLLAB_SERVER_URL_KEY)
    const normalized = normalizeConfiguredServerUrl(stored)
    if (stored && normalized && stored.trim() !== normalized) {
      localStorage.setItem(COLLAB_SERVER_URL_KEY, normalized)
    }
    return normalized
  } catch {
    return null
  }
}

/**
 * Set (or clear) the remote collab server URL.
 * Pass `null` to clear and revert to same-origin fallback.
 *
 * This is a **singleton** API — it treats the remote server URL as a
 * single value, not a multi-connection list.  Setting a new URL removes
 * any prior remote connections so the canonical registry and the legacy
 * `forge-collab-server-url` key stay synchronized.  Without this
 * delegation, the no-arg resolvers (which read from registry first)
 * would not see changes made via this legacy setter once a registry
 * exists.
 *
 * @deprecated Prefer `upsertCollaborationConnection()` /
 * `removeCollaborationConnection()` from `collaboration-connections`.
 */
export function setCollabServerUrl(url: string | null): void {
  if (typeof window === 'undefined') return
  try {
    const normalized = normalizeConfiguredServerUrl(url)

    // Clear all existing remote connections first (singleton semantics).
    // This ensures that switching from URL A → URL B removes A, and
    // clearing (null) removes everything.
    const registry = loadRegistry()
    for (const conn of registry.connections) {
      if (conn.kind === 'remote') {
        removeCollaborationConnection(conn.id)
      }
    }

    if (normalized) {
      // Add the new connection — becomes last-active automatically
      // (since we just cleared all remotes, it will be the first/only one).
      upsertCollaborationConnection({ serverUrl: normalized })
      // Also write legacy key directly for immediate reads via getCollabServerUrl()
      localStorage.setItem(COLLAB_SERVER_URL_KEY, normalized)
    } else {
      localStorage.removeItem(COLLAB_SERVER_URL_KEY)
    }
  } catch {
    // localStorage unavailable — silent no-op
  }
}

// ---------------------------------------------------------------------------
// Endpoint resolution — compatibility wrappers
// ---------------------------------------------------------------------------

/**
 * Resolve the base HTTP URL for collaboration REST API calls.
 *
 * Returns a fully qualified origin string (e.g. "https://collab.example.com/")
 * that can be combined with API paths.
 *
 * **Compatibility wrapper.** Resolves the default/last-active connection.
 * New code should pass an explicit `connectionId` or target.
 */
export function resolveCollaborationApiBaseUrl(): string {
  // Delegate to the connection registry's default target
  return getDefaultCollaborationConnection().apiBaseUrl
}

/**
 * Whether the user-configured collab server URL points to a truly remote
 * origin (different host/port from the local Forge backend).
 *
 * Returns `false` when no URL is configured or when the configured URL
 * resolves to the same origin as the Forge backend — preserving same-origin
 * behavior (e.g. unauthenticated bounce to builder).
 *
 * **Compatibility wrapper.** Resolves the default/last-active connection.
 */
export function isCollabServerRemote(): boolean {
  return getDefaultCollaborationConnection().isRemote
}

/**
 * Resolve the WebSocket URL for the collaboration transport.
 *
 * Returns a ws(s):// URL ready for `WebSocketTransport`.
 *
 * **Compatibility wrapper.** Resolves the default/last-active connection.
 */
export function resolveCollaborationWsUrl(): string {
  return getDefaultCollaborationConnection().wsUrl
}

// ---------------------------------------------------------------------------
// Target-aware endpoint resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the API base URL for a specific connection target.
 */
export function resolveCollaborationApiBaseUrlFor(
  target: CollaborationEndpointTarget,
): string {
  return target.apiBaseUrl
}

/**
 * Resolve the WS URL for a specific connection target.
 */
export function resolveCollaborationWsUrlFor(
  target: CollaborationEndpointTarget,
): string {
  return target.wsUrl
}

/**
 * Whether a specific connection target is remote.
 */
export function isCollabServerRemoteFor(
  target: CollaborationEndpointTarget,
): boolean {
  return target.isRemote
}

// ---------------------------------------------------------------------------
// URL normalization (kept for legacy `getCollabServerUrl` / `setCollabServerUrl`)
// ---------------------------------------------------------------------------

/**
 * Normalize a configured server URL to a canonical HTTP(S) origin.
 *
 * Delegates to the shared `normalizeServerUrl` from `collaboration-connections`,
 * but preserves the legacy fallback of returning the trimmed value when the
 * protocol is non-http(s) (instead of returning null).
 */
function normalizeConfiguredServerUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  // Try shared normalizer first (returns null for non-http(s))
  const normalized = normalizeServerUrl(trimmed)
  if (normalized) return normalized

  // Legacy fallback: return trimmed value for non-http(s) protocols
  // (preserves exact prior behavior for edge cases like ws:// URLs)
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
    }
    return parsed.origin
  } catch {
    return trimmed
  }
}

// Re-export for callers that still need the raw backend WS resolution
export { resolveBackendWsUrl } from './backend-url'
export { resolveApiEndpoint } from './api-endpoint'
