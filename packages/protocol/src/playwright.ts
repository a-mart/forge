export type PlaywrightFeatureSource = 'env' | 'settings' | 'default'

export type PlaywrightDiscoveryServiceStatus =
  | 'disabled'
  | 'idle'
  | 'scanning'
  | 'ready'
  | 'error'

export type PlaywrightSessionSchemaVersion = 'v1' | 'v2'

export type PlaywrightSessionRootKind = 'repo-root' | 'backend-root' | 'worktree-root'

export type PlaywrightSessionLiveness =
  | 'active'
  | 'inactive'
  | 'stale'
  | 'error'

export type PlaywrightCorrelationConfidence = 'high' | 'medium' | 'low' | 'none'

export interface PlaywrightSessionArtifactCounts {
  pageSnapshots: number
  screenshots: number
  consoleLogs: number
  networkLogs: number
  total: number
  lastArtifactAt: string | null
}

export interface PlaywrightSessionPorts {
  frontend: number | null
  backendApi: number | null
  sandbox: number | null
  liteLlm: number | null
  cdp: number | null
}

export interface PlaywrightSessionCorrelation {
  matchedAgentId: string | null
  matchedAgentDisplayName: string | null
  matchedManagerId: string | null
  matchedManagerDisplayName: string | null
  matchedProfileId: string | null
  confidence: PlaywrightCorrelationConfidence
  reasons: string[]
}

export interface PlaywrightDiscoveredSession {
  id: string
  sessionName: string
  sessionVersion: string | null
  schemaVersion: PlaywrightSessionSchemaVersion

  sessionFilePath: string
  sessionFileRealPath: string
  sessionFileUpdatedAt: string
  sessionTimestamp: string | null

  rootPath: string
  rootKind: PlaywrightSessionRootKind
  repoRootPath: string | null
  backendRootPath: string | null
  worktreePath: string | null
  worktreeName: string | null

  daemonId: string | null
  socketPath: string | null
  socketExists: boolean
  socketResponsive: boolean | null
  cdpResponsive: boolean | null
  liveness: PlaywrightSessionLiveness
  stale: boolean
  staleReason: string | null

  browserName: string | null
  browserChannel: string | null
  headless: boolean | null
  persistent: boolean | null
  isolated: boolean | null

  userDataDirPath: string | null
  userDataDirExists: boolean

  ports: PlaywrightSessionPorts
  artifactCounts: PlaywrightSessionArtifactCounts

  duplicateGroupKey: string
  duplicateRank: number
  preferredInDuplicateGroup: boolean

  correlation: PlaywrightSessionCorrelation
  warnings: string[]
}

export interface PlaywrightDiscoverySettings {
  enabled: boolean
  effectiveEnabled: boolean
  source: PlaywrightFeatureSource
  envOverride: boolean | null
  scanRoots: string[]
  pollIntervalMs: number
  socketProbeTimeoutMs: number
  staleSessionThresholdMs: number
  updatedAt: string | null
}

export interface PlaywrightDiscoverySummary {
  totalSessions: number
  activeSessions: number
  inactiveSessions: number
  staleSessions: number
  legacySessions: number
  duplicateSessions: number
  correlatedSessions: number
  unmatchedSessions: number
  worktreeCount: number
}

export interface PlaywrightDiscoverySnapshot {
  updatedAt: string | null
  lastScanStartedAt: string | null
  lastScanCompletedAt: string | null
  scanDurationMs: number | null
  sequence: number
  serviceStatus: PlaywrightDiscoveryServiceStatus
  settings: PlaywrightDiscoverySettings
  rootsScanned: string[]
  summary: PlaywrightDiscoverySummary
  sessions: PlaywrightDiscoveredSession[]
  warnings: string[]
  lastError: string | null
}

export interface GetPlaywrightSessionsResponse {
  snapshot: PlaywrightDiscoverySnapshot
}

export interface TriggerPlaywrightRescanResponse {
  ok: true
  snapshot: PlaywrightDiscoverySnapshot
}

export interface GetPlaywrightSettingsResponse {
  settings: PlaywrightDiscoverySettings
}

export interface UpdatePlaywrightSettingsRequest {
  enabled?: boolean
  scanRoots?: string[]
  pollIntervalMs?: number
  socketProbeTimeoutMs?: number
  staleSessionThresholdMs?: number
}

export interface UpdatePlaywrightSettingsResponse {
  ok: true
  settings: PlaywrightDiscoverySettings
  snapshot: PlaywrightDiscoverySnapshot
}
