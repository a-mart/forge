export const REMOTE_UPDATE_PROJECT_OVERRIDES = ["inherit", "on", "off"] as const;
export type RemoteUpdateProjectOverride = (typeof REMOTE_UPDATE_PROJECT_OVERRIDES)[number];

export const REMOTE_UPDATE_OBSERVATION_STATES = [
  "equal",
  "remote_ahead",
  "local_ahead",
  "diverged",
  "rewound",
  "unknown",
  "detached",
  "missing",
  "unresolved",
  "auth_error",
  "transport_error",
  "timeout",
  "invalid_repository",
  "ref_integrity_error",
  "aborted"
] as const;
export type RemoteUpdateObservationState = (typeof REMOTE_UPDATE_OBSERVATION_STATES)[number];

export interface ResolvedRemoteUpdateTarget {
  commonDir: string;
  monitorKey: string;
  remoteName: string;
  remoteFingerprint: string;
  targetRef: `refs/heads/${string}`;
  destinationRef: `refs/remotes/${string}/${string}`;
}

export interface RemoteUpdateGitObservation {
  state: RemoteUpdateObservationState;
  tipOid: string | null;
  observedAt: string;
}

export interface RemoteUpdateSettings {
  globalEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteUpdateProjectRecord {
  projectId: string;
  override: RemoteUpdateProjectOverride;
  monitorKey: string | null;
  remoteFingerprint: string | null;
  lastCompletedObservedAt: string | null;
  nextDueAt: string | null;
  failureCount: number;
  backoffUntil: string | null;
  generation: number;
  attentionGeneration: number | null;
  lastTipOid: string | null;
  lastState: RemoteUpdateObservationState | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteUpdateMonitorRecord {
  monitorKey: string;
  commonDir: string;
  remoteName: string;
  targetRef: string;
  remoteFingerprint: string;
  latestState: RemoteUpdateObservationState | null;
  latestTipOid: string | null;
  generation: number;
  lastObservedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteUpdateDismissal {
  projectId: string;
  monitorKey: string;
  ref: string;
  tipOid: string;
  generation: number;
  dismissedAt: string;
}

export interface RemoteUpdateProjectSnapshot {
  projectId: string;
  globalEnabled: boolean;
  override: RemoteUpdateProjectOverride;
  effectiveEnabled: boolean;
  monitorKey: string | null;
  ref: string | null;
  tipOid: string | null;
  state: RemoteUpdateObservationState | null;
  generation: number;
  dismissed: boolean;
  hasUndismissedUpdate: boolean;
  lastCompletedObservedAt: string | null;
}

export interface RecordRemoteUpdateObservationResult {
  baseline: boolean;
  changed: boolean;
  generation: number;
  snapshot: RemoteUpdateProjectSnapshot;
  affectedProjectIds: string[];
}
