/**
 * Multi-collaboration-backend connection registry.
 *
 * Client-side registry of collaboration backend connections stored in
 * localStorage.  Manages legacy migration from the singleton
 * `forge-collab-server-url` key, deterministic connection IDs, the stable
 * `conn_same_origin` virtual fallback, and target-aware endpoint resolution.
 *
 * Storage keys:
 *   - `forge:collab:connections:v1`           — canonical registry
 *   - `forge:collab:connections:v1:malformed`  — backup of unparseable registry
 *   - `forge-collab-server-url`               — legacy singleton (read/mirror)
 *
 * Events:
 *   - `forge-collab-connections-change`        — registry mutation
 *   - `forge-collab-server-url-change`         — legacy compat (mirrored)
 */

import { resolveBackendWsUrl } from './backend-url'
import { resolveApiEndpoint } from './api-endpoint'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_KEY = 'forge:collab:connections:v1'
const REGISTRY_MALFORMED_KEY = 'forge:collab:connections:v1:malformed'
const LEGACY_URL_KEY = 'forge-collab-server-url'
const REGISTRY_CHANGE_EVENT = 'forge-collab-connections-change'
const LEGACY_CHANGE_EVENT = 'forge-collab-server-url-change'

/** Stable virtual connection ID for same-origin/local collab fallback. */
export const SAME_ORIGIN_CONNECTION_ID = 'conn_same_origin'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollaborationConnectionKind = 'remote' | 'same-origin'

/**
 * Instance capabilities cached from the last successful
 * `/api/collaboration/status` handshake (Wave R). Absent until first probed —
 * treat as collab-only.
 */
export interface CollaborationConnectionCapabilities {
  collab: boolean
  remoteBuild: boolean
  /** Absent on older servers — UI hides create-folder when false/undefined. */
  createDirectory?: boolean
  protocolVersion: number
}

export interface CollaborationConnectionRecord {
  id: string
  kind: CollaborationConnectionKind
  label: string
  /** User-provided server URL (absent for same-origin). */
  serverUrl?: string
  apiBaseUrl: string
  wsUrl: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  source?: 'legacy' | 'manual' | 'same-origin'
  /** Cached handshake capabilities (Wave R, additive). */
  capabilities?: CollaborationConnectionCapabilities
  /** Per-connection opt-in: surface this instance's projects as an origin. */
  remoteProjectsEnabled?: boolean
}

export interface CollaborationConnectionRegistry {
  version: 1
  /** Default target for fallback / downgrade compat; not a visibility gate. */
  lastActiveConnectionId?: string
  connections: CollaborationConnectionRecord[]
}

/** Resolved runtime target for a single collaboration backend. */
export interface CollaborationEndpointTarget {
  connectionId: string
  kind: CollaborationConnectionKind
  label: string
  serverUrl?: string
  apiBaseUrl: string
  wsUrl: string
  isRemote: boolean
  /** True when this target is a virtual fallback not explicitly persisted in the registry. */
  virtual?: boolean
  /** Cached handshake capabilities (Wave R, additive). */
  capabilities?: CollaborationConnectionCapabilities
  /** Per-connection opt-in: surface this instance's projects as an origin. */
  remoteProjectsEnabled?: boolean
}

// ---------------------------------------------------------------------------
// URL normalization (shared with collaboration-endpoints.ts)
// ---------------------------------------------------------------------------

/**
 * Normalize a server URL to a canonical HTTP(S) origin string.
 * Returns `null` for empty, non-http(s), or unparseable values.
 */
export function normalizeServerUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
    }
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Derive the API base URL (with trailing slash) from a normalized origin.
 */
function deriveApiBaseUrl(normalizedOrigin: string): string {
  return normalizedOrigin.endsWith('/') ? normalizedOrigin : normalizedOrigin + '/'
}

/**
 * Derive the WebSocket URL from a normalized HTTP(S) origin.
 */
function deriveWsUrl(normalizedOrigin: string): string {
  return normalizedOrigin.replace(/^http(s?):\/\//, 'ws$1://')
}

// ---------------------------------------------------------------------------
// Deterministic connection IDs
// ---------------------------------------------------------------------------

/**
 * Generate a stable, deterministic connection ID from a normalized origin.
 * Uses a simple djb2-style hash to keep IDs short and collision-resistant.
 */
export function connectionIdFromOrigin(normalizedOrigin: string): string {
  let hash = 5381
  for (let i = 0; i < normalizedOrigin.length; i++) {
    hash = ((hash << 5) + hash + normalizedOrigin.charCodeAt(i)) >>> 0
  }
  return `conn_${hash.toString(36)}`
}

// ---------------------------------------------------------------------------
// Same-origin fallback target
// ---------------------------------------------------------------------------

/** Build the virtual same-origin connection target. */
export function buildSameOriginTarget(): CollaborationEndpointTarget {
  const wsUrl = resolveBackendWsUrl()
  return {
    connectionId: SAME_ORIGIN_CONNECTION_ID,
    kind: 'same-origin',
    label: 'Local',
    apiBaseUrl: resolveApiEndpoint(wsUrl, '/'),
    wsUrl,
    isRemote: false,
    virtual: true,
  }
}

/** Build a same-origin connection record (for explicit persistence). */
function buildSameOriginRecord(): CollaborationConnectionRecord {
  const target = buildSameOriginTarget()
  const now = new Date().toISOString()
  return {
    id: SAME_ORIGIN_CONNECTION_ID,
    kind: 'same-origin',
    label: target.label,
    apiBaseUrl: target.apiBaseUrl,
    wsUrl: target.wsUrl,
    createdAt: now,
    updatedAt: now,
    source: 'same-origin',
  }
}

// ---------------------------------------------------------------------------
// localStorage helpers (safe for SSR / no-window)
// ---------------------------------------------------------------------------

function storageGet(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(key, value)
  } catch {
    // silent — localStorage unavailable
  }
}

function storageRemove(key: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(key)
  } catch {
    // silent
  }
}

// ---------------------------------------------------------------------------
// Registry persistence
// ---------------------------------------------------------------------------

/**
 * Check whether a string is a parseable URL with an expected protocol.
 * Returns false for empty, whitespace-only, or structurally invalid values
 * that would throw in `new URL()` or `new WebSocket()`.
 */
function isParseableUrl(value: unknown, allowedProtocols: string[]): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    const parsed = new URL(value)
    return allowedProtocols.includes(parsed.protocol)
  } catch {
    return false
  }
}

/**
 * Validate that a connection record has the minimum required fields AND
 * that URL fields are parseable.  Records with unparseable `apiBaseUrl`,
 * `wsUrl`, or (for remotes) `serverUrl` are dropped to prevent downstream
 * `new WebSocket(...)` or `new URL(...)` crashes at connection startup.
 */
function isValidConnectionRecord(
  entry: unknown,
): entry is CollaborationConnectionRecord {
  if (!entry || typeof entry !== 'object') return false
  const rec = entry as Record<string, unknown>

  // Structural checks
  if (
    typeof rec.id !== 'string' || rec.id.length === 0 ||
    typeof rec.kind !== 'string' || (rec.kind !== 'remote' && rec.kind !== 'same-origin') ||
    typeof rec.label !== 'string' ||
    typeof rec.createdAt !== 'string' ||
    typeof rec.updatedAt !== 'string'
  ) {
    return false
  }

  // apiBaseUrl must be a parseable HTTP(S) URL
  if (!isParseableUrl(rec.apiBaseUrl, ['http:', 'https:'])) return false

  // wsUrl must be a parseable WS(S) URL
  if (!isParseableUrl(rec.wsUrl, ['ws:', 'wss:'])) return false

  // Remote connections must have a parseable HTTP(S) serverUrl
  if (rec.kind === 'remote') {
    if (!isParseableUrl(rec.serverUrl, ['http:', 'https:'])) return false
  }

  return true
}

function parseRegistry(raw: string | null): CollaborationConnectionRegistry | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      Array.isArray(parsed.connections)
    ) {
      // Validate each record — drop malformed entries rather than letting
      // them flow to `new URL()` and throw at runtime.
      const validConnections = (parsed.connections as unknown[]).filter(
        isValidConnectionRecord,
      )
      return {
        ...parsed,
        connections: validConnections,
      } as CollaborationConnectionRegistry
    }
    return null
  } catch {
    return null
  }
}

function persistRegistry(registry: CollaborationConnectionRegistry): void {
  storageSet(REGISTRY_KEY, JSON.stringify(registry))
}

/**
 * Mirror the last-active remote URL to the legacy key for downgrade compat.
 *
 * When no remote connection remains (all removed, or only same-origin),
 * clears the legacy key so downgraded/legacy readers do not see a stale
 * remote URL.
 */
function mirrorLegacyUrl(registry: CollaborationConnectionRegistry): void {
  const activeId = registry.lastActiveConnectionId
  const activeConn = activeId
    ? registry.connections.find((c) => c.id === activeId)
    : undefined
  // Fall back to first remote if active is not remote
  const remote = activeConn?.kind === 'remote'
    ? activeConn
    : registry.connections.find((c) => c.kind === 'remote')
  if (remote?.serverUrl) {
    storageSet(LEGACY_URL_KEY, remote.serverUrl)
  } else {
    // No remote connection — clear stale legacy key
    storageRemove(LEGACY_URL_KEY)
  }
}

// ---------------------------------------------------------------------------
// Registry change notification
// ---------------------------------------------------------------------------

function notifyRegistryChange(): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new Event(REGISTRY_CHANGE_EVENT))
  } catch {
    // silent
  }
}

function notifyLegacyChange(): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new Event(LEGACY_CHANGE_EVENT))
  } catch {
    // silent
  }
}

// ---------------------------------------------------------------------------
// Registry load (with legacy migration & malformed recovery)
// ---------------------------------------------------------------------------

/**
 * Load the canonical registry, performing lazy migration if needed.
 *
 * Resolution order:
 *   1. Valid `forge:collab:connections:v1` — use directly.
 *   2. Malformed registry — back up, fall through to legacy.
 *   3. Valid `forge-collab-server-url` — migrate to one-entry registry.
 *   4. Nothing — return empty registry (same-origin virtual fallback).
 */
export function loadRegistry(): CollaborationConnectionRegistry {
  // 1. Try canonical registry
  const raw = storageGet(REGISTRY_KEY)
  if (raw !== null) {
    const registry = parseRegistry(raw)
    if (registry) return registry

    // Malformed — preserve and fall through
    storageSet(REGISTRY_MALFORMED_KEY, JSON.stringify({
      raw,
      backedUpAt: new Date().toISOString(),
    }))
    storageRemove(REGISTRY_KEY)
  }

  // 2. Try legacy singleton URL
  const legacyUrl = storageGet(LEGACY_URL_KEY)
  const normalized = normalizeServerUrl(legacyUrl)
  if (normalized) {
    const id = connectionIdFromOrigin(normalized)
    const now = new Date().toISOString()
    const registry: CollaborationConnectionRegistry = {
      version: 1,
      lastActiveConnectionId: id,
      connections: [
        {
          id,
          kind: 'remote',
          label: hostFromOrigin(normalized),
          serverUrl: normalized,
          apiBaseUrl: deriveApiBaseUrl(normalized),
          wsUrl: deriveWsUrl(normalized),
          createdAt: now,
          updatedAt: now,
          source: 'legacy',
        },
      ],
    }
    persistRegistry(registry)
    // Keep legacy key intact (no delete)
    return registry
  }

  // 3. Empty — same-origin virtual fallback (not persisted)
  return { version: 1, connections: [] }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** Extract a human-friendly hostname from a normalized origin. */
function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/**
 * Find the canonical default connection ID from a pre-resolved targets array.
 *
 * Resolution: `lastActiveConnectionId` from registry → first target in array.
 * Avoids re-loading the registry in hot render paths when the caller already
 * holds a snapshot of the targets.
 */
export function getDefaultConnectionIdFromTargets(
  targets: readonly CollaborationEndpointTarget[],
): string | null {
  if (targets.length === 0) return null
  const registry = loadRegistry()
  if (registry.lastActiveConnectionId) {
    const match = targets.find((t) => t.connectionId === registry.lastActiveConnectionId)
    if (match) return match.connectionId
  }
  return targets[0]!.connectionId
}

/**
 * Return all connection targets.
 *
 * When no remote connections exist, includes the virtual `conn_same_origin`.
 * When remotes exist, same-origin is excluded unless explicitly persisted.
 */
export function getCollaborationConnectionOptions(): CollaborationEndpointTarget[] {
  const registry = loadRegistry()
  const remotes = registry.connections.filter((c) => c.kind === 'remote')
  const hasSameOriginExplicit = registry.connections.some(
    (c) => c.id === SAME_ORIGIN_CONNECTION_ID,
  )

  const targets: CollaborationEndpointTarget[] = []

  for (const conn of registry.connections) {
    targets.push(recordToTarget(conn))
  }

  // Virtual same-origin fallback when no remotes and not already listed
  if (remotes.length === 0 && !hasSameOriginExplicit) {
    targets.push(buildSameOriginTarget())
  }

  return targets
}

/**
 * Resolve the default/last-active connection target.
 *
 * Falls back through: lastActiveConnectionId → first remote → same-origin.
 * Recovers from stale/deleted lastActiveConnectionId gracefully.
 */
export function getDefaultCollaborationConnection(): CollaborationEndpointTarget {
  const registry = loadRegistry()

  // Try lastActiveConnectionId
  if (registry.lastActiveConnectionId) {
    const found = registry.connections.find(
      (c) => c.id === registry.lastActiveConnectionId,
    )
    if (found) return recordToTarget(found)
  }

  // Fallback: first remote
  const firstRemote = registry.connections.find((c) => c.kind === 'remote')
  if (firstRemote) return recordToTarget(firstRemote)

  // Fallback: explicit same-origin
  const sameOrigin = registry.connections.find(
    (c) => c.id === SAME_ORIGIN_CONNECTION_ID,
  )
  if (sameOrigin) return recordToTarget(sameOrigin)

  // Virtual same-origin
  return buildSameOriginTarget()
}

/**
 * Update the last-active/default connection and mirror legacy URL.
 */
export function setLastActiveCollaborationConnection(connectionId: string | null): void {
  const registry = loadRegistry()
  registry.lastActiveConnectionId = connectionId ?? undefined
  persistRegistry(registry)
  mirrorLegacyUrl(registry)
  notifyRegistryChange()
  notifyLegacyChange()
}

// ---------------------------------------------------------------------------
// Registry mutations
// ---------------------------------------------------------------------------

/**
 * Add or update a remote connection by server URL.
 *
 * If the normalized origin already exists, updates label and timestamps.
 * Returns the connection ID.
 */
export function upsertCollaborationConnection(input: {
  serverUrl: string
  label?: string
}): string {
  const normalized = normalizeServerUrl(input.serverUrl)
  if (!normalized) throw new Error('Invalid server URL')

  const registry = loadRegistry()
  const id = connectionIdFromOrigin(normalized)
  const now = new Date().toISOString()
  const existing = registry.connections.find((c) => c.id === id)

  if (existing) {
    // Update existing
    existing.label = input.label ?? existing.label
    existing.serverUrl = normalized
    existing.apiBaseUrl = deriveApiBaseUrl(normalized)
    existing.wsUrl = deriveWsUrl(normalized)
    existing.updatedAt = now
  } else {
    // Add new
    registry.connections.push({
      id,
      kind: 'remote',
      label: input.label ?? hostFromOrigin(normalized),
      serverUrl: normalized,
      apiBaseUrl: deriveApiBaseUrl(normalized),
      wsUrl: deriveWsUrl(normalized),
      createdAt: now,
      updatedAt: now,
      source: 'manual',
    })
  }

  // Set as last-active if it's the first/only remote
  if (!registry.lastActiveConnectionId) {
    registry.lastActiveConnectionId = id
  }

  persistRegistry(registry)
  mirrorLegacyUrl(registry)
  notifyRegistryChange()
  notifyLegacyChange()
  return id
}

/**
 * Edit a connection's server URL. Because origin is identity, a URL change
 * creates a new deterministic ID. If the new origin already exists, returns
 * the existing record's ID (dedup). Returns the resulting connection ID.
 */
export function editCollaborationConnectionUrl(
  connectionId: string,
  input: { serverUrl: string; label?: string },
): string {
  if (connectionId === SAME_ORIGIN_CONNECTION_ID) {
    throw new Error('Cannot edit the same-origin connection URL')
  }

  const normalized = normalizeServerUrl(input.serverUrl)
  if (!normalized) throw new Error('Invalid server URL')

  const registry = loadRegistry()
  const newId = connectionIdFromOrigin(normalized)

  // If the new origin matches an existing record, select it instead of duping
  const existingByNewOrigin = registry.connections.find((c) => c.id === newId)
  if (existingByNewOrigin && existingByNewOrigin.id !== connectionId) {
    // Update label if provided
    if (input.label) {
      existingByNewOrigin.label = input.label
      existingByNewOrigin.updatedAt = new Date().toISOString()
    }
    // Remove old record
    registry.connections = registry.connections.filter((c) => c.id !== connectionId)
    // Transfer lastActive
    if (registry.lastActiveConnectionId === connectionId) {
      registry.lastActiveConnectionId = newId
    }
    persistRegistry(registry)
    mirrorLegacyUrl(registry)
    notifyRegistryChange()
    notifyLegacyChange()
    return newId
  }

  // Same origin → just update in place
  if (newId === connectionId) {
    const existing = registry.connections.find((c) => c.id === connectionId)
    if (existing) {
      existing.serverUrl = normalized
      existing.apiBaseUrl = deriveApiBaseUrl(normalized)
      existing.wsUrl = deriveWsUrl(normalized)
      if (input.label) existing.label = input.label
      existing.updatedAt = new Date().toISOString()
    }
    persistRegistry(registry)
    mirrorLegacyUrl(registry)
    notifyRegistryChange()
    notifyLegacyChange()
    return connectionId
  }

  // Different origin → replace old record with new-id record
  const now = new Date().toISOString()
  const oldRecord = registry.connections.find((c) => c.id === connectionId)
  const newRecord: CollaborationConnectionRecord = {
    id: newId,
    kind: 'remote',
    label: input.label ?? oldRecord?.label ?? hostFromOrigin(normalized),
    serverUrl: normalized,
    apiBaseUrl: deriveApiBaseUrl(normalized),
    wsUrl: deriveWsUrl(normalized),
    createdAt: oldRecord?.createdAt ?? now,
    updatedAt: now,
    source: oldRecord?.source ?? 'manual',
  }

  // Replace in-place to preserve ordering
  registry.connections = registry.connections.map((c) =>
    c.id === connectionId ? newRecord : c,
  )

  // Transfer lastActive
  if (registry.lastActiveConnectionId === connectionId) {
    registry.lastActiveConnectionId = newId
  }

  persistRegistry(registry)
  mirrorLegacyUrl(registry)
  notifyRegistryChange()
  notifyLegacyChange()
  return newId
}

/**
 * Update the display label for a connection. Preserves its ID.
 */
export function renameCollaborationConnection(
  connectionId: string,
  label: string,
): void {
  const registry = loadRegistry()
  const conn = registry.connections.find((c) => c.id === connectionId)
  if (!conn) return

  conn.label = label
  conn.updatedAt = new Date().toISOString()
  persistRegistry(registry)
  notifyRegistryChange()
}

/**
 * Toggle whether this instance's projects surface as a remote origin
 * (Wave R). Preserves its ID; no-ops for unknown connections.
 */
export function setCollaborationConnectionRemoteProjects(
  connectionId: string,
  enabled: boolean,
): void {
  const registry = loadRegistry()
  const conn = registry.connections.find((c) => c.id === connectionId)
  if (!conn || conn.remoteProjectsEnabled === enabled) return

  conn.remoteProjectsEnabled = enabled
  conn.updatedAt = new Date().toISOString()
  persistRegistry(registry)
  notifyRegistryChange()
}

/**
 * Cache the instance capabilities observed in the latest status handshake
 * (Wave R). Skips the write when nothing changed to avoid cross-tab churn.
 */
export function cacheCollaborationConnectionCapabilities(
  connectionId: string,
  capabilities: CollaborationConnectionCapabilities,
): void {
  const registry = loadRegistry()
  const conn = registry.connections.find((c) => c.id === connectionId)
  if (!conn) return

  const current = conn.capabilities
  if (
    current &&
    current.collab === capabilities.collab &&
    current.remoteBuild === capabilities.remoteBuild &&
    current.createDirectory === capabilities.createDirectory &&
    current.protocolVersion === capabilities.protocolVersion
  ) {
    return
  }

  conn.capabilities = { ...capabilities }
  conn.updatedAt = new Date().toISOString()
  persistRegistry(registry)
  notifyRegistryChange()
}

/**
 * Remove a connection from the registry.
 */
export function removeCollaborationConnection(connectionId: string): void {
  if (connectionId === SAME_ORIGIN_CONNECTION_ID) {
    // Remove explicit same-origin record but virtual fallback persists
  }

  const registry = loadRegistry()
  registry.connections = registry.connections.filter((c) => c.id !== connectionId)

  if (registry.lastActiveConnectionId === connectionId) {
    const nextRemote = registry.connections.find((c) => c.kind === 'remote')
    registry.lastActiveConnectionId = nextRemote?.id
  }

  persistRegistry(registry)
  mirrorLegacyUrl(registry)
  notifyRegistryChange()
  notifyLegacyChange()
}

/**
 * Add same-origin as an explicit connection alongside remotes.
 */
export function addSameOriginConnection(): string {
  const registry = loadRegistry()
  if (registry.connections.some((c) => c.id === SAME_ORIGIN_CONNECTION_ID)) {
    return SAME_ORIGIN_CONNECTION_ID
  }
  registry.connections.push(buildSameOriginRecord())
  persistRegistry(registry)
  notifyRegistryChange()
  return SAME_ORIGIN_CONNECTION_ID
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Determine if a connection is truly remote (different origin from local backend).
 * A connection is remote when its resolved origin differs from the local Forge backend.
 */
function isOriginRemote(record: CollaborationConnectionRecord): boolean {
  if (record.kind === 'same-origin') return false
  if (!record.serverUrl) return false
  try {
    const connOrigin = new URL(record.serverUrl).origin
    const backendWs = resolveBackendWsUrl()
    const backendOrigin = new URL(backendWs.replace(/^ws(s?):\/\//, 'http$1://')).origin
    // Normalize localhost → 127.0.0.1 for comparison
    const normalize = (o: string) => o.replace('//localhost', '//127.0.0.1')
    return normalize(connOrigin) !== normalize(backendOrigin)
  } catch {
    return true // conservative: treat as remote on error
  }
}

/** Convert a persisted record to a runtime target. */
function recordToTarget(record: CollaborationConnectionRecord): CollaborationEndpointTarget {
  return {
    connectionId: record.id,
    kind: record.kind,
    label: record.label,
    serverUrl: record.serverUrl,
    apiBaseUrl: record.apiBaseUrl,
    wsUrl: record.wsUrl,
    isRemote: isOriginRemote(record),
    capabilities: record.capabilities,
    remoteProjectsEnabled: record.remoteProjectsEnabled,
  }
}

/**
 * Resolve a specific connection ID to an endpoint target.
 *
 * If `connectionId` is omitted, resolves the default/last-active target
 * (compatibility wrapper for code that hasn't migrated to explicit targets).
 */
export function resolveCollaborationTarget(
  connectionId?: string,
): CollaborationEndpointTarget {
  if (!connectionId) {
    return getDefaultCollaborationConnection()
  }

  if (connectionId === SAME_ORIGIN_CONNECTION_ID) {
    // Check for explicit same-origin record first
    const registry = loadRegistry()
    const explicit = registry.connections.find(
      (c) => c.id === SAME_ORIGIN_CONNECTION_ID,
    )
    if (explicit) return recordToTarget(explicit)
    return buildSameOriginTarget()
  }

  const registry = loadRegistry()
  const conn = registry.connections.find((c) => c.id === connectionId)
  if (conn) return recordToTarget(conn)

  // Stale ID — fall back to default
  return getDefaultCollaborationConnection()
}

/**
 * Resolve API base URL for a connection target.
 * Accepts a connectionId, a target object, or nothing (default).
 */
export function resolveCollaborationApiBaseUrlForTarget(
  connectionIdOrTarget?: string | CollaborationEndpointTarget,
): string {
  if (!connectionIdOrTarget) {
    return getDefaultCollaborationConnection().apiBaseUrl
  }
  if (typeof connectionIdOrTarget === 'string') {
    return resolveCollaborationTarget(connectionIdOrTarget).apiBaseUrl
  }
  return connectionIdOrTarget.apiBaseUrl
}

/**
 * Resolve WS URL for a connection target.
 */
export function resolveCollaborationWsUrlForTarget(
  connectionIdOrTarget?: string | CollaborationEndpointTarget,
): string {
  if (!connectionIdOrTarget) {
    return getDefaultCollaborationConnection().wsUrl
  }
  if (typeof connectionIdOrTarget === 'string') {
    return resolveCollaborationTarget(connectionIdOrTarget).wsUrl
  }
  return connectionIdOrTarget.wsUrl
}

/**
 * Whether a connection target is remote.
 */
export function isCollabConnectionRemote(
  connectionIdOrTarget?: string | CollaborationEndpointTarget,
): boolean {
  if (!connectionIdOrTarget) {
    return getDefaultCollaborationConnection().isRemote
  }
  if (typeof connectionIdOrTarget === 'string') {
    return resolveCollaborationTarget(connectionIdOrTarget).isRemote
  }
  return connectionIdOrTarget.isRemote
}

// ---------------------------------------------------------------------------
// Event subscription
// ---------------------------------------------------------------------------

export { REGISTRY_CHANGE_EVENT, LEGACY_CHANGE_EVENT }

/**
 * Subscribe to registry changes (includes cross-tab via storage event).
 * Returns an unsubscribe function.
 */
export function subscribeToRegistryChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  const onCustomEvent = () => callback()
  const onStorageEvent = (e: StorageEvent) => {
    if (e.key === REGISTRY_KEY || e.key === LEGACY_URL_KEY) callback()
  }

  window.addEventListener(REGISTRY_CHANGE_EVENT, onCustomEvent)
  window.addEventListener('storage', onStorageEvent)
  return () => {
    window.removeEventListener(REGISTRY_CHANGE_EVENT, onCustomEvent)
    window.removeEventListener('storage', onStorageEvent)
  }
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** @internal Reset all storage for test isolation. */
export function _resetRegistryForTesting(): void {
  storageRemove(REGISTRY_KEY)
  storageRemove(REGISTRY_MALFORMED_KEY)
  storageRemove(LEGACY_URL_KEY)
}
