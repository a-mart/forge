/**
 * Origin meta slice (WP-U1, requirement 5).
 *
 * Connection/transport metadata for an origin, kept SEPARATE from the domain
 * `ManagerWsState`.  The connection manager writes it; it is never merged into
 * `ManagerWsState`.  Subscribable like any other slice.  Remote origins (Wave
 * R) populate `authState` / `capabilities` / `protocolVersion`; the local
 * origin only ever toggles `connectionStatus` and mirrors `lastError`.
 *
 * @see .internal/forge-review-2026-07/97-remote/U1-REQUIREMENTS.md (req. 5)
 */

export type OriginConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

/**
 * Auth posture for the origin.  The local backend is always `'not-required'`;
 * remote collaboration backends move through `'pending' → 'authenticated' |
 * 'unauthorized'`.
 */
export type OriginAuthState =
  | 'not-required'
  | 'pending'
  | 'authenticated'
  | 'unauthorized'

/** The signed-in identity behind a remote origin's connection (Wave R). */
export interface OriginCurrentUser {
  userId: string
  displayName: string
  role: 'admin' | 'member'
}

export interface OriginMetaState {
  connectionStatus: OriginConnectionStatus
  authState: OriginAuthState
  /** Server-advertised capability flags (opaque today; populated by Wave R). */
  capabilities: Readonly<Record<string, boolean>>
  /** Server-advertised builder protocol version from the handshake. */
  protocolVersion: number | null
  /** Last transport/connection error, separate from domain `lastError`. */
  lastError: string | null
  /**
   * Identity of the user this origin is connected as (`null` for the local
   * origin and before the auth probe). Used for author-chip suppression:
   * chips render only for authors other than this user.
   */
  currentUser?: OriginCurrentUser | null
  /** Instance display name from the handshake (remote origins). */
  instanceName?: string | null
  /**
   * Set when the server's builder protocol version exceeds this client's
   * ceiling — the origin section renders "update Forge to connect" and the
   * manager refuses to open a socket.
   */
  versionBlocked?: boolean
}

export function createInitialOriginMetaState(
  overrides?: Partial<OriginMetaState>,
): OriginMetaState {
  return {
    connectionStatus: 'idle',
    authState: 'not-required',
    capabilities: {},
    protocolVersion: null,
    lastError: null,
    ...overrides,
  }
}

