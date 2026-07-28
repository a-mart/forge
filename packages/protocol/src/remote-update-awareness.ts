/**
 * Local Builder-only remote Git update awareness contracts.
 *
 * These DTOs deliberately expose project-scoped, sanitized state only. Git
 * paths, remote URLs, credentials, command output, monitor keys, and viewer
 * identities remain server-local implementation details.
 */

/** Per-project preference; `on` still requires the global master switch. */
export type RemoteUpdateAwarenessProjectOverride = 'inherit' | 'on' | 'off'

/**
 * Sanitized observation truth for the project's selected Git context.
 *
 * `update_available` means the observed remote is an ordinary advancement;
 * dismissal only changes `attentionRequired`, never this observation. The
 * other relationship states must not be presented as ordinary advancement.
 */
export const REMOTE_UPDATE_AWARENESS_PROJECT_STATES = [
  'disabled',
  'not_git',
  'unobserved',
  'checking',
  'up_to_date',
  'update_available',
  'local_ahead',
  'diverged',
  'rewound',
  'missing',
  'detached',
  'stale',
  'unresolved',
  'unknown',
  'error',
] as const

export type RemoteUpdateAwarenessProjectState = (typeof REMOTE_UPDATE_AWARENESS_PROJECT_STATES)[number]

/** Sanitized failure classification; never carries a Git command or output. */
export type RemoteUpdateAwarenessFailureCode =
  | 'auth'
  | 'transport'
  | 'timeout'
  | 'git_unavailable'
  | 'invalid_target'
  | 'unknown'

/** Durable global preference. New installations and upgrades default to false. */
export interface RemoteUpdateAwarenessSettings {
  globalEnabled: boolean
  updatedAt: string | null
}

/** Per-local-project preference and its server-derived effective result. */
export interface RemoteUpdateAwarenessProjectSettings {
  projectId: string
  override: RemoteUpdateAwarenessProjectOverride
  effectiveEnabled: boolean
}

/** Settings response for the local Builder's eligible, non-archived projects. */
export interface RemoteUpdateAwarenessSettingsSnapshot {
  settings: RemoteUpdateAwarenessSettings
  projects: RemoteUpdateAwarenessProjectSettings[]
}

export interface GetRemoteUpdateAwarenessSettingsResponse extends RemoteUpdateAwarenessSettingsSnapshot {}

export interface UpdateRemoteUpdateAwarenessSettingsRequest {
  globalEnabled: boolean
}

export interface UpdateRemoteUpdateAwarenessSettingsResponse extends RemoteUpdateAwarenessSettingsSnapshot {}

export interface UpdateRemoteUpdateAwarenessProjectOverrideRequest {
  projectId: string
  override: RemoteUpdateAwarenessProjectOverride
}

export interface UpdateRemoteUpdateAwarenessProjectOverrideResponse {
  project: RemoteUpdateAwarenessProjectSettings
}

/**
 * Opaque revision used to condition an exact-tip dismissal. The server maps
 * it to the current monitor/ref/tip/generation tuple and rejects stale values.
 */
export interface RemoteUpdateAwarenessDismissalTarget {
  generation: number
}

/**
 * Active-project projection. It is intentionally free of filesystem, remote
 * URL, ref, OID, monitor, and identity data. `state` is observation truth;
 * `attentionRequired` is the independent presentation/notification decision.
 */
export interface RemoteUpdateAwarenessProjectSnapshot {
  projectId: string
  override: RemoteUpdateAwarenessProjectOverride
  globalEnabled: boolean
  effectiveEnabled: boolean
  state: RemoteUpdateAwarenessProjectState
  lastObservedAt: string | null
  failureCode: RemoteUpdateAwarenessFailureCode | null
  attentionRequired: boolean
  /** Exact observed generation used for dismissal, including after dismissal. */
  dismissalTarget: RemoteUpdateAwarenessDismissalTarget | null
}

export interface GetRemoteUpdateAwarenessProjectResponse {
  snapshot: RemoteUpdateAwarenessProjectSnapshot
}

/** Records local activity and may queue the normal stale-on-activation check. */
export interface ActivateRemoteUpdateAwarenessProjectRequest {
  projectId: string
}

export interface ActivateRemoteUpdateAwarenessProjectResponse {
  snapshot: RemoteUpdateAwarenessProjectSnapshot
}

/**
 * Requests a local, project-scoped observation. Fetching may update Git
 * metadata/remote-tracking refs, but never mutates the working tree or
 * integrates remote changes.
 */
export interface RefreshRemoteUpdateAwarenessProjectRequest {
  projectId: string
}

export interface RefreshRemoteUpdateAwarenessProjectResponse {
  snapshot: RemoteUpdateAwarenessProjectSnapshot
}

/** Dismisses attention only for the exact currently projected update generation. */
export interface DismissRemoteUpdateAwarenessProjectUpdateRequest {
  projectId: string
  dismissalTarget: RemoteUpdateAwarenessDismissalTarget
}

export interface DismissRemoteUpdateAwarenessProjectUpdateResponse {
  snapshot: RemoteUpdateAwarenessProjectSnapshot
}

/**
 * A sanitized, bounded summary of one observed incoming commit. Subjects are
 * normalized and truncated by the server; authors, body text, paths, and raw
 * command output are deliberately absent.
 */
export interface RemoteUpdateAwarenessIncomingCommitSummary {
  subject: string
  committedAt: string | null
}

/**
 * Bounded incoming-commit evidence. `commitCount` is the number represented
 * in `commits`, never an unbounded repository-wide count; `hasMore` reports
 * whether the server omitted further commits after `commitLimit`.
 */
export interface RemoteUpdateAwarenessIncomingCommitRange {
  commitCount: number
  commitLimit: number
  hasMore: boolean
  commits: RemoteUpdateAwarenessIncomingCommitSummary[]
}

/**
 * Aggregate file-change evidence for the same bounded incoming range. No
 * filenames or paths are exposed. A null count means the server could not
 * safely compute the summary for this observation.
 */
export interface RemoteUpdateAwarenessIncomingFileChangeSummary {
  changedFileCount: number | null
  changedFileCountLimit: number
  hasMore: boolean
  addedCount: number | null
  modifiedCount: number | null
  deletedCount: number | null
  renamedCount: number | null
}

/**
 * Project-scoped evidence used by Incoming inspection. Display names are
 * labels only: no repository path, remote URL, credential, command output,
 * monitor key, or viewer identity is included. `observedTipOid`, when
 * present, is the exact full OID from the observation (not an abbreviated UI
 * display value).
 */
export interface RemoteUpdateAwarenessIncomingInspection {
  projectId: string
  remoteDisplayName: string | null
  defaultBranchDisplay: string | null
  observedTipOid: string | null
  generation: number
  observedAt: string | null
  freshnessCheckedAt: string | null
  staleAfter: string | null
  state: RemoteUpdateAwarenessProjectState
  failureCode: RemoteUpdateAwarenessFailureCode | null
  attentionRequired: boolean
  commits: RemoteUpdateAwarenessIncomingCommitRange
  fileChanges: RemoteUpdateAwarenessIncomingFileChangeSummary | null
}

/** Reads sanitized Incoming evidence for one local project. */
export interface GetRemoteUpdateAwarenessIncomingRequest {
  projectId: string
}

export interface GetRemoteUpdateAwarenessIncomingResponse {
  incoming: RemoteUpdateAwarenessIncomingInspection
}

/** Sent when the active project's sanitized projection changes. */
export interface RemoteUpdateAwarenessProjectChangedEvent {
  type: 'remote_update_awareness_project_changed'
  snapshot: RemoteUpdateAwarenessProjectSnapshot
}

/** Sent when route/lifecycle changes remove the active-project projection. */
export interface RemoteUpdateAwarenessProjectClearedEvent {
  type: 'remote_update_awareness_project_cleared'
  projectId: string
}
