import type { CollaborationRole } from './collaboration.js'

/**
 * Project presence (Wave R R3, SPEC §4.7). Additive event family: the server
 * emits a full per-session viewer snapshot whenever the set of connected
 * member identities subscribed to that session changes. Scope is presence
 * only — no typing indicators, no cursors.
 */
export interface ProjectPresenceViewer {
  userId: string
  displayName: string
  role: CollaborationRole
}

export interface ProjectPresenceEvent {
  type: 'project_presence'
  /** The builder session whose viewer set changed. */
  sessionAgentId: string
  /** Owning profile/project when resolvable. */
  profileId?: string
  /** Current viewer identities (deduplicated by userId). */
  viewers: ProjectPresenceViewer[]
}
