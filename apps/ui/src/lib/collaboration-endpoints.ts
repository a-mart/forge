/**
 * Collaboration endpoint resolution for the default/last-active connection.
 *
 * New code that targets a specific connection should prefer
 * `resolveCollaborationTarget(connectionId)` from `collaboration-connections.ts`.
 */

import { getDefaultCollaborationConnection } from './collaboration-connections'

/**
 * Resolve the base HTTP URL for collaboration REST API calls.
 *
 * Returns a fully qualified origin string (e.g. "https://collab.example.com/")
 * that can be combined with API paths.
 */
export function resolveCollaborationApiBaseUrl(): string {
  return getDefaultCollaborationConnection().apiBaseUrl
}

/**
 * Resolve the WebSocket URL for the collaboration transport.
 *
 * Returns a ws(s):// URL ready for `WebSocketTransport`.
 */
export function resolveCollaborationWsUrl(): string {
  return getDefaultCollaborationConnection().wsUrl
}
