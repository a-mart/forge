# Playwright Dashboard Design

Date: 2026-03-09  
Status: Proposed / implementation-ready  
Target repo: `middleman`

> Note: The requested original handoff file at `/Users/adam/repos/newco/agent_stack/planning/middleman-playwright-dashboard-handoff/README.md` was not present in the workspace during synthesis. This design therefore synthesizes the three available research reports plus `AGENTS.md`, and treats the discovery report’s “Discrepancies vs Handoff Document” section as the best available record of where earlier assumptions were wrong.

## Source legend

- **[UI]** `docs/playwright-dashboard/research-ui-architecture.md`
- **[BE]** `docs/playwright-dashboard/research-backend-architecture.md`
- **[DISC]** `docs/playwright-dashboard/research-discovery-feasibility.md`
- **[AGENTS]** `AGENTS.md`

---

## 1. Feature Overview

### 1.1 What this feature is

The Playwright Dashboard is a **read-only, discovery-based operational dashboard** inside Middleman that scans known Agent Stack repo/worktree locations for Playwright CLI session artifacts, detects whether daemons/sockets appear live, correlates discovered sessions to Middleman agents when possible, and presents the result in a dedicated dashboard view. It is an **observation surface**, not a browser control plane. (Sources: [UI §§Executive recommendation, 10-13], [BE §§3, 5, 10-14], [DISC §§Executive Summary, 13])

### 1.2 What this feature is not

This v1 feature is explicitly **not**:

- a replacement for chat, artifacts, or Cortex side panels
- a new routing framework or shell refactor
- a remote-control UI for browsers
- a guarantee of exact agent ↔ browser ownership
- a change to Agent Stack file layout or Playwright CLI behavior
- a multi-project browser fleet manager
- a screenshot/URL live preview system

The dashboard only observes filesystem/runtime evidence already produced by Agent Stack and Middleman. (Sources: [UI §§Executive recommendation, 12-13], [BE §§5, 13-14], [DISC §§11, 13-14], [AGENTS])

### 1.3 Primary user stories

1. **As a user running multiple Agent Stack worktrees**, I can open a dashboard in Middleman and see which Playwright sessions exist across repo root and worktrees.
2. **As a user debugging stale browser state**, I can tell whether a session file is merely left on disk or still backed by a live daemon/socket/CDP port.
3. **As a user coordinating workers**, I can see a best-effort mapping between a discovered Playwright session and the Middleman agent/session/profile most likely associated with it.
4. **As a user with many worktrees**, I can filter by worktree, status, staleness, or search term to find the relevant browser quickly.
5. **As an operator**, I can keep the feature off by default, enable it from Settings, or force it on/off via environment variable.
6. **As a user with no Playwright activity**, I get an intelligible empty state instead of a broken page.

(Sources: [UI §§2-6, 10-11], [BE §§1-3, 5, 7, 11], [DISC §§1-13])

### 1.4 Feature toggle contract

The feature is controlled by both:

- backend env var: `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`
- persisted settings toggle in UI: `/api/settings/playwright`

#### Effective behavior

- **Default**: OFF
- **If env var is set**: env var is authoritative
- **If env var is unset**: persisted setting is authoritative
- **If neither exists**: feature remains OFF

#### Accepted env values

Truthy: `1`, `true`, `yes`, `on`  
Falsy: `0`, `false`, `no`, `off`

Invalid values should log a warning and be ignored as “unset” rather than crashing startup.

#### UI behavior

- Settings always shows the Playwright Dashboard toggle row.
- If env override is active, the row is disabled and explains that the feature is forced on/off by `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`.
- The sidebar Playwright nav button is shown only when `effectiveEnabled === true`.
- If a user manually lands on `?view=playwright` while disabled, the dashboard renders a disabled-state surface instead of crashing or showing stale data.

(Sources: [UI §§5.1-5.4, 13], [BE §§4, 7, 11, 13-14])

---

## 2. Architecture Decisions

### 2.1 Decision summary

#### Decision A — UI placement

Implement the dashboard as a **new center-pane app view inside the existing `IndexPage` shell** using `use-route-state.ts`, alongside existing `chat` and `settings` views. Do **not** build it as the right drawer and do **not** introduce a standalone file-route in v1. (Sources: [UI §§Executive recommendation, 1-2, 9, 12-13])

#### Decision B — backend placement

Implement discovery as a **top-level backend service** (`PlaywrightDiscoveryService`) instantiated in `apps/backend/src/index.ts`, parallel to `IntegrationRegistryService` and `CronSchedulerService`, not embedded into `SwarmManager`. (Sources: [BE §§Executive summary, 3, 6, 10, 14])

#### Decision C — settings storage

Use a **dedicated settings service** and a shared persisted JSON file under `~/.middleman/shared/playwright-dashboard.json`; do not reuse `SecretsEnvService`, auth storage, or generic env settings endpoints. (Sources: [BE §§4, 7, 12-14])

#### Decision D — data transport

Use **HTTP for initial fetch + mutation** and **WebSocket full-snapshot events for live updates**. The dashboard should fetch once on mount/activation, then replace state from snapshot WS events. (Sources: [UI §§3.1, 4.1-4.6], [BE §§2, 11-14])

#### Decision E — event model

Use **full snapshot replacement**, not incremental patch events. Emit a bootstrap snapshot on subscribe and a full updated snapshot whenever the in-memory discovery snapshot materially changes. (Sources: [UI §§4.5-4.6], [BE §§2, 10, 11])

#### Decision F — correlation strategy

Correlation is **best-effort and heuristic**. The backend computes candidate ownership using agent `cwd`, role, profile/session relationships, timestamp proximity, and liveness state, and returns a confidence level plus reasons. The UI must display confidence honestly and never imply certainty where none exists. (Sources: [UI §10], [BE §5], [DISC §§4, 11, 13])

#### Decision G — worktree discovery strategy

Discovery must be **filesystem-first**. The worktree registry may contribute metadata and env lookup hints, but it is not authoritative for enumerating actual worktrees. Real directories on disk are the source of truth. (Sources: [DISC §§1, 7, 11, 13-14])

### 2.2 Why the service lives where it does

`SwarmManager` already owns swarm lifecycle, persistence, sessions, runtimes, and agent registry. Playwright discovery is adjacent operational state with its own poll/watch lifecycle and no need to mutate swarm state. A top-level service keeps the boundary clean, matches existing backend patterns, and avoids coupling discovery timing to core orchestration. (Sources: [BE §§Executive summary, 3, 6, 10, 14], [AGENTS])

### 2.3 Why the UI lives where it does

The current UI is effectively a single-route app whose shell is owned by `apps/ui/src/routes/index.tsx`. Settings already occupies the center pane while retaining the sidebar. The Playwright dashboard needs width, filters, summary cards, and scrollable multi-column status content, so it fits the Settings pattern far better than the narrow right drawer. (Sources: [UI §§Executive recommendation, 1-3, 9, 12-13])

### 2.4 End-to-end data flow

```text
Agent Stack filesystem/runtime evidence
  ├─ <repo>/.playwright-cli/sessions/**/*.session
  ├─ <repo>/backend/.playwright-cli/sessions/**/*.session
  ├─ <repo>/.git/worktree-runtime/registry.tsv
  ├─ <repo>/.git/worktree-runtime/*.env
  ├─ <worktree>/backend/.env.worktree.runtime
  ├─ /tmp/playwright-cli-sockets/**/*
  └─ <root>/.playwright-cli/{page-*.yml,*.png,console-*.log,network-*.log}
          │
          ▼
PlaywrightDiscoveryService
  ├─ resolves effective settings via PlaywrightSettingsService + env override
  ├─ enumerates scan roots/worktrees
  ├─ parses v1/v2 session files
  ├─ probes liveness (stat -> socket connect -> CDP)
  ├─ counts artifacts
  ├─ correlates sessions against swarmManager.listAgents()
  ├─ produces PlaywrightDiscoverySnapshot
  └─ emits snapshot/settings events
          │
          ├──────── HTTP ────────► /api/playwright/sessions
          │                      /api/playwright/rescan
          │                      /api/settings/playwright
          │
          ▼
SwarmWebSocketServer -> WsHandler -> ManagerWsClient -> ws-state
          │
          ▼
PlaywrightDashboardView
  ├─ summary bar
  ├─ filters/search
  ├─ session table/cards
  └─ disabled/empty/error states
```

(Sources: [UI §§4, 9, 13], [BE §§1-4, 9-14], [DISC §§1-13])

### 2.5 Global vs scoped events

For v1, Playwright discovery events are **global to the backend instance**, not agent-scoped and not profile-filtered in WS fanout. Reasons:

- discovery spans repo root and multiple worktrees
- sessions may not correlate to any Middleman agent
- the dashboard is a tool-level view, not a conversation-level stream
- the existing WS model already treats non-conversation snapshots as global

The payload still includes matched profile/manager/agent fields so the UI can group or label rows. (Sources: [UI §§4.3-4.5, 12.5], [BE §2])

### 2.6 Explicit non-goals

Not in scope for this design:

- browser control buttons that mutate Playwright or Chrome state
- CDP-backed screenshots, tabs, or current URL streaming
- command-level custom tools for agents
- modifying Agent Stack scripts or session file schema
- rich session history/timeline persistence
- per-project tenancy beyond this backend instance
- route-shell extraction or broader navigation refactor

(Sources: [UI §§11-13], [BE §§5, 13-14], [DISC §§13-14])

---

## 3. Data Model & Protocol

### 3.1 Shared protocol types

Create a new shared file:

- `packages/protocol/src/playwright.ts`

Recommended contents:

```ts
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
```

Decision: shared types include both WS payloads and HTTP DTOs even though current codebase does not centralize all HTTP DTOs. This improves implementation safety for a feature with multiple frontend/backend touchpoints. (Sources: [BE §8], [UI §4.4])

### 3.2 The `PlaywrightDiscoveredSession` record shape

`PlaywrightDiscoveredSession` is the canonical dashboard row. Important semantics:

- `schemaVersion`: distinguishes legacy v1 vs current v2 session file formats
- `sessionTimestamp`: from embedded session metadata when available; may be null for v1/corrupt partial parses
- `sessionFileUpdatedAt`: filesystem mtime; always present if file was readable
- `duplicateGroupKey`: usually normalized `socketPath`; falls back to `sessionFileRealPath` when no socket path exists
- `preferredInDuplicateGroup`: true for the newest representative of a shared daemon/socket group
- `stale`: computed, not copied from disk
- `correlation`: best-effort ownership metadata with explicit confidence/reasons

This shape intentionally includes enough detail for the UI to avoid additional path parsing or inference. (Sources: [BE §5], [DISC §§2-4, 10-13], [UI §10])

### 3.3 The `PlaywrightDiscoverySnapshot` shape

`PlaywrightDiscoverySnapshot` is the single replaceable collection object used by both HTTP and WS.

Key semantics:

- `settings` carries effective runtime settings and precedence source
- `rootsScanned` is the resolved, normalized set actually scanned in the last run
- `summary` is precomputed in backend for cheap UI rendering
- `serviceStatus` lets the UI distinguish disabled vs scanning vs error vs ready
- `lastError` is operational, not row-level; per-row recoverable issues belong in `session.warnings`

Decision: snapshot is the only collection payload; no delta protocol is introduced. (Sources: [UI §§4.5-4.6], [BE §§2, 10-11])

### 3.4 WebSocket event definitions

Modify `packages/protocol/src/server-events.ts` to add:

```ts
import type {
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from './playwright.js'

export interface PlaywrightDiscoverySnapshotEvent {
  type: 'playwright_discovery_snapshot'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoveryUpdatedEvent {
  type: 'playwright_discovery_updated'
  snapshot: PlaywrightDiscoverySnapshot
}

export interface PlaywrightDiscoverySettingsUpdatedEvent {
  type: 'playwright_discovery_settings_updated'
  settings: PlaywrightDiscoverySettings
}
```

Then extend `ServerEvent` with:

```ts
  | PlaywrightDiscoverySnapshotEvent
  | PlaywrightDiscoveryUpdatedEvent
  | PlaywrightDiscoverySettingsUpdatedEvent
```

#### Exact event type strings

- `playwright_discovery_snapshot`
- `playwright_discovery_updated`
- `playwright_discovery_settings_updated`

Semantics:

- `playwright_discovery_snapshot`: sent during WS bootstrap after `profiles_snapshot`
- `playwright_discovery_updated`: sent whenever a materially changed snapshot replaces the previous one
- `playwright_discovery_settings_updated`: sent after persisted settings change or env-forced recalculation changes effective settings

(Sources: [UI §§4.4-4.6], [BE §§2, 7-8, 11-14])

### 3.5 HTTP endpoint contracts

#### `GET /api/playwright/sessions`

Response:

```ts
export interface GetPlaywrightSessionsResponse {
  snapshot: PlaywrightDiscoverySnapshot
}
```

Behavior:

- returns `200` with current snapshot even when disabled
- returns `503` only if the discovery service was not instantiated or failed hard at startup

#### `POST /api/playwright/rescan`

Response:

```ts
export interface TriggerPlaywrightRescanResponse {
  ok: true
  snapshot: PlaywrightDiscoverySnapshot
}
```

Behavior:

- triggers an immediate serialized rescan
- if feature is disabled, returns `200` with unchanged disabled snapshot
- if service unavailable, returns `503`

#### `GET /api/settings/playwright`

Response:

```ts
export interface GetPlaywrightSettingsResponse {
  settings: PlaywrightDiscoverySettings
}
```

Behavior:

- always available if backend is running
- includes `effectiveEnabled`, `source`, and `envOverride`

#### `PUT /api/settings/playwright`

Request:

```ts
export interface UpdatePlaywrightSettingsRequest {
  enabled?: boolean
  scanRoots?: string[]
  pollIntervalMs?: number
  socketProbeTimeoutMs?: number
  staleSessionThresholdMs?: number
}
```

Response:

```ts
export interface UpdatePlaywrightSettingsResponse {
  ok: true
  settings: PlaywrightDiscoverySettings
  snapshot: PlaywrightDiscoverySnapshot
}
```

Behavior:

- validates and persists a partial settings patch
- returns `409` if env override is active and mutation is attempted
- returns `400` on invalid payloads

Decision: keep settings endpoints under `/api/settings/*` and discovery data under `/api/playwright/*`, even though both are served from the same route bundle. (Sources: [BE §§1, 7, 11], [UI §5.3])

### 3.6 Settings persistence format

Persist to `~/.middleman/shared/playwright-dashboard.json`:

```json
{
  "version": 1,
  "enabled": false,
  "scanRoots": [],
  "pollIntervalMs": 10000,
  "socketProbeTimeoutMs": 750,
  "staleSessionThresholdMs": 3600000,
  "updatedAt": "2026-03-09T18:00:00.000Z"
}
```

Rules:

- `version` allows future migration
- `scanRoots` are **user-supplied additions**; they are merged with auto-detected roots at runtime
- `updatedAt` is written atomically on every successful mutation

(Sources: [BE §7], [DISC §13])

### 3.7 Backend-only types

Recommended backend-only types in `apps/backend/src/playwright/playwright-discovery-service.ts` or a colocated internal types block:

```ts
import type {
  AgentDescriptor,
} from '@middleman/protocol'
import type {
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  PlaywrightSessionArtifactCounts,
  PlaywrightSessionCorrelation,
  PlaywrightSessionPorts,
  PlaywrightSessionSchemaVersion,
} from '@middleman/protocol'

interface PlaywrightSessionFileV1 {
  version?: string
  socketPath?: string
  cli?: {
    headed?: boolean
    persistent?: boolean
  }
  userDataDirPrefix?: string
}

interface PlaywrightSessionFileV2 {
  name?: string
  version?: string
  timestamp?: number
  socketPath?: string
  cli?: {
    headed?: boolean
    persistent?: boolean
  }
  userDataDirPrefix?: string
  resolvedConfig?: {
    browser?: {
      browserName?: string
      launchOptions?: {
        channel?: string
        headless?: boolean
        assistantMode?: boolean
        chromiumSandbox?: boolean
        cdpPort?: number
      }
      isolated?: boolean
      cdpHeaders?: Record<string, string>
      userDataDir?: string
    }
    snapshot?: {
      mode?: string
      output?: string
    }
    timeouts?: {
      action?: number
      navigation?: number
    }
    outputMode?: string
    skillMode?: boolean
  }
}

type PlaywrightSessionFile = PlaywrightSessionFileV1 | PlaywrightSessionFileV2

interface PlaywrightPersistedSettingsFile {
  version: 1
  enabled: boolean
  scanRoots: string[]
  pollIntervalMs: number
  socketProbeTimeoutMs: number
  staleSessionThresholdMs: number
  updatedAt: string
}

interface PlaywrightScanRoot {
  rootPath: string
  rootKind: 'repo-root' | 'backend-root' | 'worktree-root'
  repoRootPath: string | null
  backendRootPath: string | null
  worktreePath: string | null
  worktreeName: string | null
  sessionDirPath: string
  artifactDirPath: string
  runtimeEnvPath: string | null
}

interface PlaywrightRuntimeEnvInfo {
  envFilePath: string
  stackId: string | null
  stackRoot: string | null
  frontendPort: number | null
  backendApiPort: number | null
  sandboxPort: number | null
  liteLlmPort: number | null
}

interface PlaywrightSessionCandidate {
  raw: PlaywrightSessionFile
  schemaVersion: PlaywrightSessionSchemaVersion
  sessionFilePath: string
  sessionFileRealPath: string
  sessionFileUpdatedAt: string
  sessionTimestampMs: number | null
  sessionName: string
  root: PlaywrightScanRoot
  runtimeEnv: PlaywrightRuntimeEnvInfo | null
  artifactCounts: PlaywrightSessionArtifactCounts
  warnings: string[]
}

interface PlaywrightProbeResult {
  socketExists: boolean
  socketResponsive: boolean | null
  cdpResponsive: boolean | null
}

interface PlaywrightCorrelationCandidate {
  agent: AgentDescriptor
  score: number
  confidence: PlaywrightSessionCorrelation['confidence']
  reasons: string[]
}

interface PlaywrightDiscoveryBuildResult {
  snapshot: PlaywrightDiscoverySnapshot
  changed: boolean
}
```

### 3.8 Frontend-only types

Recommended frontend-local types in `apps/ui/src/components/playwright/playwright-api.ts` or `PlaywrightDashboardView.tsx`:

```ts
import type {
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'

export type PlaywrightStatusFilter = 'all' | 'active' | 'inactive' | 'stale' | 'error'
export type PlaywrightSortKey = 'updatedAt' | 'worktree' | 'sessionName' | 'confidence'

export interface PlaywrightDashboardFiltersState {
  search: string
  status: PlaywrightStatusFilter
  worktree: string | 'all'
  onlyCorrelated: boolean
  onlyPreferred: boolean
}

export interface PlaywrightDashboardDerivedState {
  visibleSessions: PlaywrightDiscoveredSession[]
  worktreeOptions: string[]
  activeCount: number
  staleCount: number
  correlatedCount: number
  lastUpdatedLabel: string | null
  isEmpty: boolean
}

export interface PlaywrightDashboardViewProps {
  wsUrl: string
  connected: boolean
  snapshot: PlaywrightDiscoverySnapshot | null
  onOpenSettings: () => void
}
```

---

## 4. Backend Implementation Plan

### 4.1 `apps/backend/src/playwright/playwright-discovery-service.ts`

Create a new top-level service class.

#### Responsibilities

- own current snapshot and effective settings
- merge env override + persisted settings
- resolve candidate scan roots
- rescan filesystem on startup, watch, and interval
- serialize scans
- probe liveness
- correlate sessions to agents
- emit WS-forwardable events

#### Recommended public API

```ts
import { EventEmitter } from 'node:events'
import type {
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import type { PlaywrightSettingsService } from './playwright-settings-service.js'

export class PlaywrightDiscoveryService extends EventEmitter {
  constructor(options: {
    swarmManager: SwarmManager
    settingsService: PlaywrightSettingsService
    envEnabledOverride?: boolean
    now?: () => Date
  })

  async start(): Promise<void>
  async stop(): Promise<void>

  getSnapshot(): PlaywrightDiscoverySnapshot
  getSettings(): PlaywrightDiscoverySettings
  isEffectivelyEnabled(): boolean

  async triggerRescan(reason?: string): Promise<PlaywrightDiscoverySnapshot>
  async updateSettings(patch: {
    enabled?: boolean
    scanRoots?: string[]
    pollIntervalMs?: number
    socketProbeTimeoutMs?: number
    staleSessionThresholdMs?: number
  }): Promise<{
    settings: PlaywrightDiscoverySettings
    snapshot: PlaywrightDiscoverySnapshot
  }>
}
```

#### Recommended internal methods

```ts
private createDisabledSnapshot(): PlaywrightDiscoverySnapshot
private computeEffectiveSettings(): PlaywrightDiscoverySettings
private startPolling(): void
private stopPolling(): void
private rebuildWatchers(snapshot: PlaywrightDiscoverySnapshot): Promise<void>
private clearWatchers(): void
private requestScan(reason: string): void
private runScan(reason: string): Promise<void>
private buildSnapshot(reason: string): Promise<PlaywrightDiscoverySnapshot>
private resolveScanRoots(settings: PlaywrightDiscoverySettings): Promise<PlaywrightScanRoot[]>
private collectAutoDetectedRoots(): Promise<string[]>
private collectConfiguredRoots(settings: PlaywrightDiscoverySettings): Promise<string[]>
private enumerateWorktrees(repoRoot: string): Promise<string[]>
private discoverSessionFiles(root: PlaywrightScanRoot): Promise<PlaywrightSessionCandidate[]>
private parseSessionFile(candidate: {
  root: PlaywrightScanRoot
  sessionFilePath: string
  artifactCounts: PlaywrightSessionArtifactCounts
  runtimeEnv: PlaywrightRuntimeEnvInfo | null
}): Promise<PlaywrightSessionCandidate | null>
private probeLiveness(candidate: PlaywrightSessionCandidate): Promise<PlaywrightProbeResult>
private correlateSession(candidate: PlaywrightSessionCandidate): PlaywrightSessionCorrelation
private deduplicateSessions(sessions: PlaywrightDiscoveredSession[]): PlaywrightDiscoveredSession[]
private buildSummary(sessions: PlaywrightDiscoveredSession[]): PlaywrightDiscoverySnapshot['summary']
private snapshotsEqual(a: PlaywrightDiscoverySnapshot, b: PlaywrightDiscoverySnapshot): boolean
private emitSnapshot(snapshot: PlaywrightDiscoverySnapshot, eventType: 'playwright_discovery_snapshot' | 'playwright_discovery_updated'): void
```

#### Scan/poll/watch behavior

- `start()`:
  - compute effective settings
  - if disabled: set disabled snapshot, emit settings updated, start no pollers
  - if enabled: run immediate scan, then start watchers + interval poll
- `triggerRescan()`:
  - serialized forced scan, returns latest snapshot
- `updateSettings()`:
  - persist validated patch via settings service
  - recompute effective settings
  - if disabled after update: clear watchers, stop interval, publish disabled snapshot
  - if enabled after update: run immediate rescan and rebuild watchers
- `stop()`:
  - clear interval
  - close all watchers
  - await active scan if any

#### Event emission contract

The service emits these exact events:

- `playwright_discovery_snapshot`
- `playwright_discovery_updated`
- `playwright_discovery_settings_updated`

Payloads are protocol-shaped event objects, so `SwarmWebSocketServer` can forward them directly. (Sources: [BE §§2-3, 6, 10-14], [DISC §§12-13])

### 4.2 `apps/backend/src/playwright/playwright-settings-service.ts`

Create a small persistence/validation service.

#### Responsibilities

- read/write `shared/playwright-dashboard.json`
- provide validated persisted settings defaults
- apply atomic temp-file + rename writes
- expose typed settings snapshots for the discovery service

#### Recommended public API

```ts
import type { PlaywrightDiscoverySettings } from '@middleman/protocol'

export class PlaywrightSettingsService {
  constructor(options: {
    dataDir: string
    now?: () => Date
  })

  async load(): Promise<void>
  getPersisted(): {
    enabled: boolean
    scanRoots: string[]
    pollIntervalMs: number
    socketProbeTimeoutMs: number
    staleSessionThresholdMs: number
    updatedAt: string | null
  }
  async update(patch: {
    enabled?: boolean
    scanRoots?: string[]
    pollIntervalMs?: number
    socketProbeTimeoutMs?: number
    staleSessionThresholdMs?: number
  }): Promise<void>
}
```

#### Validation rules

- `enabled`: boolean
- `scanRoots`: array of non-empty absolute paths, deduped after realpath normalization where possible
- `pollIntervalMs`: integer between `2000` and `60000`
- `socketProbeTimeoutMs`: integer between `100` and `5000`
- `staleSessionThresholdMs`: integer between `60000` and `86400000`

Decision: settings validation lives here so route handlers stay thin and discovery service receives normalized values only. (Sources: [BE §7])

### 4.3 `apps/backend/src/ws/routes/playwright-routes.ts`

Create a single route bundle that serves both discovery and settings endpoints.

#### Exact endpoints

- `GET /api/playwright/sessions`
- `POST /api/playwright/rescan`
- `GET /api/settings/playwright`
- `PUT /api/settings/playwright`

#### Factory signature

```ts
export function createPlaywrightRoutes(options: {
  discoveryService: PlaywrightDiscoveryService | null
}): HttpRoute[]
```

#### Route behavior

- manual `OPTIONS` handling with existing CORS helpers
- use shared request parsing pattern from existing routes
- `GET /api/playwright/sessions`
  - `200` with `{ snapshot }`
  - `503` if `discoveryService` is null
- `POST /api/playwright/rescan`
  - `200` with `{ ok: true, snapshot }`
  - `503` if service null
- `GET /api/settings/playwright`
  - `200` with `{ settings }`
- `PUT /api/settings/playwright`
  - parse JSON body
  - `200` with `{ ok: true, settings, snapshot }`
  - `400` invalid JSON/payload
  - `409` env override prevents mutation

Decision: keep one cohesive feature route bundle rather than splitting settings into `settings-routes.ts`; this minimizes cross-file coupling while keeping URL namespaces intuitive. (Sources: [BE §§1, 7, 11, 14])

### 4.4 `apps/backend/src/ws/server.ts`

Modify server wiring.

#### Exact changes

1. Import `PlaywrightDiscoveryService` type and `createPlaywrightRoutes`.
2. Add constructor option:

```ts
playwrightDiscovery?: PlaywrightDiscoveryService
```

3. Store:

```ts
private readonly playwrightDiscovery: PlaywrightDiscoveryService | null
```

4. Add event forwarders:

```ts
private readonly onPlaywrightDiscoverySnapshot = (event: ServerEvent): void => {
  if (event.type !== 'playwright_discovery_snapshot') return
  this.wsHandler.broadcastToSubscribed(event)
}

private readonly onPlaywrightDiscoveryUpdated = (event: ServerEvent): void => {
  if (event.type !== 'playwright_discovery_updated') return
  this.wsHandler.broadcastToSubscribed(event)
}

private readonly onPlaywrightDiscoverySettingsUpdated = (event: ServerEvent): void => {
  if (event.type !== 'playwright_discovery_settings_updated') return
  this.wsHandler.broadcastToSubscribed(event)
}
```

5. Pass service into `WsHandler`.
6. Register routes:

```ts
...createPlaywrightRoutes({ discoveryService: this.playwrightDiscovery }),
```

7. Subscribe/unsubscribe in `start()` / `stop()`.

Decision: follow the existing manual event forwarding pattern rather than trying to introduce generic auto-forwarding. (Sources: [BE §§1-3, 13-14], [AGENTS])

### 4.5 `apps/backend/src/ws/ws-handler.ts`

Modify bootstrap behavior.

#### Exact changes

1. Add optional constructor dependency:

```ts
playwrightDiscovery: PlaywrightDiscoveryService | null
```

2. Store it on the class.
3. In `sendSubscriptionBootstrap()`, after `profiles_snapshot` and before conversation history, send:

```ts
if (this.playwrightDiscovery) {
  this.send(socket, {
    type: 'playwright_discovery_snapshot',
    snapshot: this.playwrightDiscovery.getSnapshot(),
  })
  this.send(socket, {
    type: 'playwright_discovery_settings_updated',
    settings: this.playwrightDiscovery.getSettings(),
  })
}
```

4. Do **not** add Playwright-specific filtering in `broadcastToSubscribed()`; treat them as global events.

Decision: bootstrap must include a snapshot so newly connected clients do not wait for the next scan. (Sources: [UI §4.6], [BE §2])

### 4.6 `apps/backend/src/index.ts`

Modify startup/lifecycle.

#### Exact changes

1. Import new services.
2. Instantiate settings service after `swarmManager.boot()`:

```ts
const playwrightSettingsService = new PlaywrightSettingsService({
  dataDir: config.paths.dataDir,
})
await playwrightSettingsService.load()
```

3. Instantiate discovery service:

```ts
const playwrightDiscovery = new PlaywrightDiscoveryService({
  swarmManager,
  settingsService: playwrightSettingsService,
  envEnabledOverride: readPlaywrightDashboardEnvOverride(),
})
await playwrightDiscovery.start()
```

4. Pass to `SwarmWebSocketServer`.
5. Add `playwrightDiscovery.stop()` to shutdown `Promise.allSettled(...)`.
6. If service startup throws, log clearly and continue with `playwrightDiscovery = null` rather than killing the whole backend.

Decision: startup failure of an optional experimental feature should degrade the feature, not the entire daemon. (Sources: [BE §§3-4, 13-14])

### 4.7 `apps/backend/src/config.ts`

Add env parsing helper for `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`.

#### Exact changes

Add:

```ts
export function readPlaywrightDashboardEnvOverride(): boolean | undefined {
  return parseOptionalBooleanEnv(process.env.MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED)
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) return undefined
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  console.warn(
    `[config] Ignoring invalid MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED value: ${value}`,
  )
  return undefined
}
```

No `SwarmConfig` type change is required; `index.ts` can read the helper directly.

Decision: avoid broad config-shape churn for one optional feature while still centralizing env parsing logic in `config.ts`. (Sources: [BE §4])

### 4.8 `apps/backend/src/swarm/data-paths.ts`

Add a new helper:

```ts
export function getSharedPlaywrightDashboardSettingsPath(dataDir: string): string {
  return join(getSharedDir(dataDir), 'playwright-dashboard.json')
}
```

Decision: shared feature settings belong in `shared/`, not profile/session directories. (Sources: [BE §7, §13.9])

### 4.9 `packages/protocol/src/playwright.ts`

New shared protocol file described in section 3.

### 4.10 `packages/protocol/src/server-events.ts`

Add imports and three new interfaces; extend `ServerEvent` union.

### 4.11 `packages/protocol/src/index.ts`

Add:

```ts
export * from './playwright.js'
```

---

## 5. Frontend Implementation Plan

### 5.1 New shadcn primitives to add

From `apps/ui/` run:

```bash
pnpm dlx shadcn@latest add table card skeleton
```

These are used as follows:

- `card`: summary stats and empty/error surfaces
- `table`: desktop session list layout
- `skeleton`: initial loading state

(Sources: [UI §6], [AGENTS])

### 5.2 `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`

Create the main center-pane dashboard.

#### Responsibilities

- fetch initial snapshot on mount/activation using `playwright-api.ts`
- read live WS snapshot/settings from `ManagerWsState`
- render disabled state, loading state, empty state, error state, and populated view
- own local filter/search/sort state
- trigger manual rescan
- render summary bar + filters + list/table

#### Suggested props

```ts
export interface PlaywrightDashboardViewProps {
  wsUrl: string
  connected: boolean
  snapshot: PlaywrightDiscoverySnapshot | null
  onOpenSettings: () => void
}
```

#### Render states

1. **Disabled**
   - headline: “Playwright Dashboard is disabled”
   - CTA: “Open Settings” unless disabled by env override
2. **Loading**
   - summary skeletons + row skeletons
3. **Empty**
   - no sessions found / no roots found / no worktrees found messaging
4. **Ready**
   - `PlaywrightSummaryBar`
   - `PlaywrightFilters`
   - table on desktop, cards on mobile
5. **Error**
   - banner for `snapshot.lastError`

Decision: the view owns only transient UI state; live discovered data stays in WS store. (Sources: [UI §§3.1, 4, 7-9, 12-13])

### 5.3 `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`

Create a session presentation component for mobile and optional compact desktop cards.

#### Show

- session name + schema badge (`v1`/`v2`)
- liveness badge (`active` / `inactive` / `stale` / `error`)
- worktree/repo path with truncation + tooltip
- correlation badge + confidence label
- port chips (frontend/api/CDP when present)
- artifact counts
- last updated timestamp
- duplicate badge if shared daemon group

Decision: cards are the mobile-friendly representation even if desktop uses a table. (Sources: [UI §§3.1, 6, 8, 12.3], [DISC §§4, 10-13])

### 5.4 `apps/ui/src/components/playwright/PlaywrightSummaryBar.tsx`

Create a compact summary surface using `Card`.

Suggested metrics:

- total sessions
- active sessions
- stale sessions
- correlated sessions
- worktrees represented
- last scan completed time

### 5.5 `apps/ui/src/components/playwright/PlaywrightFilters.tsx`

Create filter/search controls.

Controls:

- search input
- status select (`all`, `active`, `inactive`, `stale`, `error`)
- worktree select (`all` + detected worktrees)
- checkbox/switch: correlated only
- checkbox/switch: preferred rows only
- refresh/rescan button

Use existing `Input`, `Select`, `Checkbox`/`Switch`, `Button`. (Sources: [UI §§3, 6-7])

### 5.6 `apps/ui/src/components/playwright/playwright-api.ts`

Create REST helpers for discovery endpoints.

Suggested exports:

```ts
export async function fetchPlaywrightSnapshot(wsUrl: string): Promise<PlaywrightDiscoverySnapshot>
export async function triggerPlaywrightRescan(wsUrl: string): Promise<PlaywrightDiscoverySnapshot>
```

These should validate response shape from shared DTO types and surface readable error messages.

### 5.7 `apps/ui/src/hooks/index-page/use-route-state.ts`

Extend route state.

#### Exact changes

```ts
export type ActiveView = 'chat' | 'settings' | 'playwright'
export type AppRouteState =
  | { view: 'chat'; agentId: string }
  | { view: 'settings' }
  | { view: 'playwright' }
```

Update parsing/normalization/search helpers so `?view=playwright` resolves to `{ view: 'playwright' }`.

Decision: use `?view=playwright` rather than a new route file because `navigateToRoute()` already targets `/`. (Sources: [UI §§1, 9.3, 12.1])

### 5.8 `apps/ui/src/routes/index.tsx`

Modify center-pane rendering.

#### Exact changes

1. Import `PlaywrightDashboardView`.
2. Add sidebar active prop(s).
3. Render branch:

```tsx
{activeView === 'settings' ? (
  <SettingsPanel ... />
) : activeView === 'playwright' ? (
  <PlaywrightDashboardView
    wsUrl={wsUrl}
    connected={state.connected}
    snapshot={state.playwrightSnapshot}
    onOpenSettings={handleOpenSettingsPanel}
  />
) : (
  <>
    <ChatHeader ... />
    <MessageList ... />
    <MessageInput ... />
  </>
)}
```

4. Keep right drawer hidden whenever `activeView !== 'chat'` (existing behavior already covers this).

### 5.9 `apps/ui/src/components/chat/AgentSidebar.tsx`

Add Playwright nav button near Settings.

#### Prop additions

```ts
isPlaywrightActive: boolean
showPlaywrightNav: boolean
onOpenPlaywright: () => void
```

#### Footer behavior

- render Playwright button above Settings when `showPlaywrightNav`
- selected styling mirrors Settings button
- mobile close behavior mirrors Settings behavior

Decision: keep Playwright as a global tool nav item, not part of the session tree. (Sources: [UI §§2, 12.7-12.8])

### 5.10 `apps/ui/src/components/settings/SettingsGeneral.tsx`

Add an “Experimental features” section.

#### New behavior

- fetch current Playwright settings on mount via `settings-api.ts`
- render `Switch`
- disable switch when `settings.source === 'env'`
- show helper text for env override and default-off behavior
- optimistic update optional, but not required; conservative fetch/update/refetch is acceptable

Suggested copy:

- Label: `Playwright Dashboard`
- Description: `Discover Playwright CLI sessions across repo roots and worktrees, and correlate them with Middleman agents.`

### 5.11 `apps/ui/src/components/settings/settings-api.ts`

Add helpers:

```ts
export async function fetchPlaywrightSettings(wsUrl: string): Promise<PlaywrightDiscoverySettings>
export async function updatePlaywrightSettings(
  wsUrl: string,
  patch: UpdatePlaywrightSettingsRequest,
): Promise<{ settings: PlaywrightDiscoverySettings; snapshot: PlaywrightDiscoverySnapshot }>
```

These should hit `/api/settings/playwright`.

### 5.12 `apps/ui/src/lib/ws-state.ts`

Add fields:

```ts
import type {
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
} from '@middleman/protocol'

playwrightSnapshot: PlaywrightDiscoverySnapshot | null
playwrightSettings: PlaywrightDiscoverySettings | null
```

Initialize both to `null` in `createInitialManagerWsState()`.

### 5.13 `apps/ui/src/lib/ws-client.ts`

Handle new events.

#### Exact switch additions

```ts
case 'playwright_discovery_snapshot':
case 'playwright_discovery_updated':
  this.updateState({
    playwrightSnapshot: event.snapshot,
    playwrightSettings: event.snapshot.settings,
  })
  break

case 'playwright_discovery_settings_updated':
  this.updateState({
    playwrightSettings: event.settings,
    playwrightSnapshot: this.state.playwrightSnapshot
      ? { ...this.state.playwrightSnapshot, settings: event.settings }
      : this.state.playwrightSnapshot,
  })
  break
```

Do not treat them as conversation events.

Decision: WS state is the single live source; the dashboard does not own a parallel polling store. (Sources: [UI §§4.1-4.4, 7])

---

## 6. Discovery Engine Specification

### 6.1 Exact scan algorithm

Each scan runs the following steps in order:

1. Read effective settings (`env override` + persisted settings + defaults).
2. If disabled:
   - produce disabled snapshot with empty `sessions`
   - `serviceStatus = 'disabled'`
   - stop further work
3. Resolve scan roots:
   - auto-detected roots from active/known agent CWDs and `config.cwdAllowlistRoots`
   - merge with user-configured `scanRoots`
   - normalize with `realpath` when possible
4. Expand each root into concrete Playwright scan roots:
   - repo root `.playwright-cli`
   - repo `backend/.playwright-cli`
   - enumerated worktrees under companion worktrees directories
5. For each concrete scan root:
   - load runtime env metadata if available
   - count top-level artifacts in `.playwright-cli/`
   - find `.session` files in `sessions/` (v1 flat + v2 hash subdirs)
6. Parse each readable session file into a candidate row.
7. Probe liveness:
   - socket stat
   - socket connect if socket exists
   - CDP probe if v2 `cdpPort` present and candidate is preferred/latest in duplicate group
8. Correlate candidates to agents from `swarmManager.listAgents()`.
9. Deduplicate shared-daemon groups by `socketPath`, mark preferred row, but keep all rows.
10. Sort rows stably:
    - preferred rows first
    - active before inactive/stale
    - newer timestamps first
    - fallback session path lexical order
11. Build summary and snapshot metadata.
12. Compare to prior snapshot after normalization.
13. Emit `playwright_discovery_updated` only if materially changed.

(Sources: [BE §10], [DISC §§2-13])

### 6.2 Paths to scan and scan order

For each resolved repo root, scan in this order:

1. `<repoRoot>/.playwright-cli/sessions/`
2. `<repoRoot>/backend/.playwright-cli/sessions/`
3. `<worktree>/.playwright-cli/sessions/` for each enumerated worktree
4. `<worktree>/backend/.playwright-cli/sessions/` only if present

Artifact counts come from the sibling `.playwright-cli/` directory for each root.

#### Worktree sources

Candidate worktree directories come from:

1. sibling `../worktrees/` directory if present
2. existing paths referenced by `<repoRoot>/.git/worktree-runtime/registry.tsv`
3. any user-configured `scanRoots` that are themselves worktree directories

Enumeration rule: **only actual directories on disk are scanned**. Registry paths that no longer exist are ignored after recording a warning.

Decision: filesystem existence wins over registry declarations. (Sources: [DISC §§1, 2, 7, 11, 13-14])

### 6.3 Session file parsing: v1 and v2

#### v1 legacy layout

Pattern:

- `<root>/.playwright-cli/sessions/<name>.session`

Expected fields:

- `version`
- `socketPath`
- `cli.headed?`
- `userDataDirPrefix`

Derived fields:

- `sessionName` from filename
- `schemaVersion = 'v1'`
- `ports.cdp = null`
- `browserName/channel/headless/isolated` mostly null/derived

#### v2 current layout

Pattern:

- `<root>/.playwright-cli/sessions/<daemonId>/<name>.session`

Expected fields:

- `name`
- `version`
- `timestamp`
- `socketPath`
- `cli.persistent`
- `userDataDirPrefix`
- `resolvedConfig.browser.*`

Derived fields:

- `daemonId` from parent hash directory
- `ports.cdp` from `resolvedConfig.browser.launchOptions.cdpPort`
- `userDataDirPath` from `resolvedConfig.browser.userDataDir` when present
- `headless`, `browserChannel`, `isolated` from resolved config

If a readable file is structurally partial, keep the row when core fields exist and append warnings rather than dropping it.

(Sources: [DISC §3])

### 6.4 Socket liveness detection strategy

Use a tiered strategy, in this exact order:

1. **Stat check**
   - `lstat(socketPath)` / `stat(socketPath)`
   - if missing: `socketExists = false`, `socketResponsive = false`, skip connect
2. **Socket connect probe**
   - `net.createConnection(socketPath)` with timeout `socketProbeTimeoutMs`
   - on connect, immediately destroy connection and record `socketResponsive = true`
3. **CDP probe**
   - only when a v2 `cdpPort` is present
   - prefer probing only preferred/latest row per duplicate group
   - request `http://127.0.0.1:${port}/json/version` with timeout

#### Liveness mapping

- `active`: socket exists and socketResponsive is true
- `inactive`: no socket and not beyond stale threshold
- `stale`: no socket and age exceeds stale threshold
- `error`: socket exists but is non-responsive, or parsing/probing produced contradictory failure state

Decision: stat -> connect -> CDP matches the feasibility research and avoids overusing slower probes. (Sources: [DISC §6, §13])

### 6.5 Worktree enumeration strategy

Use **filesystem scan, not registry-only**.

Algorithm:

1. Read registry file if it exists for candidate metadata only.
2. Read sibling `worktrees/` dir entries if present.
3. Union both sets of candidate worktree paths.
4. Normalize with `realpath` when possible.
5. Keep only existing directories.
6. Scan each worktree for `.playwright-cli` roots.

Registry helps with env lookup and orphaned paths, but never determines liveness or existence on its own. (Sources: [DISC §1, §11, §13-14])

### 6.6 Port/env file resolution

For each worktree root, resolve env metadata in this order:

1. `<worktree>/backend/.env.worktree.runtime`
2. matching file under `<repoRoot>/.git/worktree-runtime/*.env` where `STACK_ROOT` matches the worktree realpath

Parse these aliases:

- frontend: `WT_FRONTEND_PORT` or `FRONTEND_HOST_PORT`
- backend API: `WT_API_PORT` or `AGENT_BACKEND_HOST_PORT`
- sandbox: `WT_SANDBOX_PORT` or `SANDBOX_HOST_PORT`
- LiteLLM: `LITELLM_HOST_PORT`
- stack id: `STACK_ID`
- stack root: `STACK_ROOT`

If env file format drifts, parse only the keys present and leave others `null`.

(Sources: [DISC §7, §13])

### 6.7 Agent correlation algorithm with confidence scoring

Correlation is calculated in backend only.

#### Candidate pool

Use all descriptors from `swarmManager.listAgents()`.

#### Scoring rules

For each discovered session, score agents as follows:

- `+100` exact realpath match between agent `cwd` and session `worktreePath`/`rootPath`
- `+80` agent `cwd` is descendant of session root, or session root is descendant of agent `cwd`
- `+25` same repo root after realpath normalization
- `+15` agent updated within 10 minutes of session timestamp or file mtime
- `+10` agent status is `idle` or `streaming` and session is `active`
- `+10` agent is a worker and exact path match exists
- `+5` agent is a manager and exact path match exists

#### Tie-breakers

1. higher score
2. worker over manager
3. non-terminated over terminated/stopped
4. newer `updatedAt`
5. lexical `agentId`

#### Confidence mapping

- `high`: score `>= 100`
- `medium`: score `>= 80`
- `low`: score `>= 40`
- `none`: below `40`

#### Returned reasons

Examples:

- `cwd_exact_match`
- `cwd_ancestor_match`
- `same_repo_root`
- `timestamp_proximity`
- `agent_active_and_session_live`
- `worker_preferred`

Decision: explicit confidence + reasons is mandatory because first-class Playwright ownership metadata does not exist in agents today. (Sources: [BE §5], [DISC §§4, 11, 13], [UI §10])

### 6.8 Deduplication strategy for shared daemon sockets

Group rows by normalized `socketPath` when present.

Within a group:

- sort by `sessionTimestamp` descending, then `sessionFileUpdatedAt` descending
- mark the first row `preferredInDuplicateGroup = true`, `duplicateRank = 0`
- keep all rows visible because stale references are operationally useful
- summary counts should count only preferred rows toward “active daemon” style totals where appropriate

If `socketPath` is absent, use `sessionFileRealPath` as its own group.

Decision: discovery research shows multiple worktrees can reference one shared daemon socket; hiding duplicates would erase useful stale-reference evidence. (Sources: [DISC §4, §11, §13])

### 6.9 Artifact counting for activity indicators

For each `.playwright-cli/` root, count only top-level files matching:

- `page-*.yml` -> `pageSnapshots`
- `*.png` -> `screenshots`
- `console-*.log` -> `consoleLogs`
- `network-*.log` -> `networkLogs`

Also compute `lastArtifactAt` from the newest matching file mtime.

Do not read file contents.

### 6.10 Error handling for missing/corrupt/inaccessible files

- unreadable session file -> skip row, append snapshot warning with path
- invalid JSON session file -> skip row, append warning
- missing socket directory -> not fatal; treat sockets as absent
- unreadable runtime env file -> ports remain `null`, append row warning
- unreadable worktree root -> append snapshot warning and continue
- partial v2 config -> keep row if basic metadata parses, fill nulls + warnings

Decision: discovery is observational and should be resilient; partial evidence is still valuable. (Sources: [DISC §§11-13], [BE §10])

### 6.11 Performance constraints: what not to scan

Do **not**:

- recursively traverse entire repo trees
- inspect contents of `ud-*-chrome/` directories
- parse snapshot YAML/log bodies
- trust registry.tsv as authoritative inventory
- run CDP probes for every stale duplicate row

Only inspect known Playwright/session/runtime paths. (Sources: [DISC §13])

### 6.12 Poll/watch strategy

#### Watch targets

Rebuild watchers after each scan for:

- each discovered `.../.playwright-cli/sessions/` directory
- each discovered `.../.playwright-cli/` root for artifact changes
- `/tmp/playwright-cli-sockets/`
- any discovered daemon-id subdirs under `/tmp/playwright-cli-sockets/`
- registry file / runtime env directory when present

#### Poll fallback

Run a full serialized scan every `pollIntervalMs` (default `10000`).

#### Serialization

Use scheduler-style fields:

- `running`
- `scanning`
- `pendingScan`
- `activeScanPromise`
- `requestScan(reason)`

Watcher events only enqueue scans; they never perform parsing inline.

Decision: watcher + polling hybrid matches existing backend patterns and tolerates `fs.watch` unreliability. (Sources: [BE §6, §10], [DISC §13])

---

## 7. Configuration & Feature Toggle Specification

### 7.1 Env var: `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED`

#### Behavior

- unset -> no env override
- truthy -> force feature enabled
- falsy -> force feature disabled
- invalid -> log warning, ignore as unset

#### Precedence

```text
env override > persisted settings file > default false
```

#### UI exposure

The UI should show:

- current effective state
- source (`env`, `settings`, `default`)
- disabled switch if source is `env`

(Sources: [UI §5.4, §13], [BE §§4, 7, 13-14])

### 7.2 Persistence file

Path:

- `~/.middleman/shared/playwright-dashboard.json`

Exact format:

```json
{
  "version": 1,
  "enabled": false,
  "scanRoots": [],
  "pollIntervalMs": 10000,
  "socketProbeTimeoutMs": 750,
  "staleSessionThresholdMs": 3600000,
  "updatedAt": "2026-03-09T18:00:00.000Z"
}
```

### 7.3 Precedence rules

| Source | Priority | Notes |
|---|---:|---|
| `MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED` | 1 | authoritative when set |
| persisted file `enabled` | 2 | used only when env override absent |
| hardcoded default `false` | 3 | initial startup fallback |

Other persisted values (`scanRoots`, `pollIntervalMs`, `socketProbeTimeoutMs`, `staleSessionThresholdMs`) remain usable even when env override controls only the enabled state.

### 7.4 Additional configurable values

#### Scan roots

- persisted as `scanRoots: string[]`
- semantics: additional roots merged with auto-detected roots
- default: `[]`

#### Poll interval

- key: `pollIntervalMs`
- default: `10000`
- allowed range: `2000` - `60000`

#### Socket probe timeout

- key: `socketProbeTimeoutMs`
- default: `750`
- allowed range: `100` - `5000`

#### Stale session threshold

- key: `staleSessionThresholdMs`
- default: `3600000` (1 hour)
- allowed range: `60000` - `86400000`

Decision: keep configuration minimal and operationally useful; do not introduce more knobs in v1. (Sources: [DISC §13], [BE §7])

---

## 8. Phased Implementation Plan

All implementation should happen in an isolated worktree/test instance; do not disturb active production sessions. (Source: [AGENTS])

### Phase 1 — Protocol types + settings service + discovery service

#### Files to create/modify

Create:

- `packages/protocol/src/playwright.ts`
- `apps/backend/src/playwright/playwright-settings-service.ts`
- `apps/backend/src/playwright/playwright-discovery-service.ts`

Modify:

- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `apps/backend/src/index.ts`

#### Acceptance criteria

- backend boots with feature disabled by default
- settings file can be loaded/created atomically
- discovery service can compute disabled snapshot and enabled snapshot
- v1/v2 parsing logic exists
- snapshot shape matches protocol types

#### Validation

- `pnpm exec tsc --noEmit`
- targeted unit tests if added for parsing and settings validation
- manual node-level test harness for sample session fixtures (recommended)

### Phase 2 — HTTP routes + WS event wiring

#### Files to create/modify

Create:

- `apps/backend/src/ws/routes/playwright-routes.ts`

Modify:

- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `apps/backend/src/index.ts`

#### Acceptance criteria

- `GET /api/settings/playwright` returns typed settings
- `PUT /api/settings/playwright` persists valid updates
- `GET /api/playwright/sessions` returns current snapshot
- `POST /api/playwright/rescan` triggers immediate rescan
- WS bootstrap includes Playwright snapshot/settings events
- live snapshot updates are broadcast when scan results change

#### Validation

- `pnpm exec tsc --noEmit`
- `curl http://127.0.0.1:<port>/api/settings/playwright`
- `curl http://127.0.0.1:<port>/api/playwright/sessions`
- `curl -X PUT .../api/settings/playwright -d '{"enabled":true}'`
- `curl -X POST .../api/playwright/rescan`
- `wscat -c ws://127.0.0.1:<port>` then `{"type":"subscribe"}` and verify bootstrap events

### Phase 3 — UI shell + routing + empty dashboard view

#### Files to create/modify

Create:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`

Modify:

- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`

#### Acceptance criteria

- `?view=playwright` renders dedicated center-pane surface
- sidebar button appears only when effective feature enabled
- disabled and empty states render cleanly
- no regression to chat/settings views

#### Validation

- `pnpm exec tsc --noEmit`
- manual UI check in isolated instance:
  - open chat
  - switch to settings
  - switch to Playwright
  - confirm right drawer remains hidden outside chat

### Phase 4 — Dashboard UI with real data + live WS updates

#### Files to create/modify

Create:

- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
- `apps/ui/src/components/playwright/PlaywrightSummaryBar.tsx`
- `apps/ui/src/components/playwright/PlaywrightFilters.tsx`

Modify:

- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`

#### Acceptance criteria

- initial load fetches snapshot via HTTP
- WS events replace snapshot live without manual refresh
- filters/search work locally
- desktop table + mobile cards render correctly
- summary counts match backend summary

#### Validation

- `pnpm exec tsc --noEmit`
- manual check with sample data / real worktree data
- rescan button updates UI without reload
- browser reload rehydrates from backend snapshot

### Phase 5 — Feature toggle in settings + conditional rendering

#### Files to create/modify

Modify:

- `apps/ui/src/components/settings/SettingsGeneral.tsx`
- `apps/ui/src/components/settings/settings-api.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`

#### Acceptance criteria

- settings page shows Playwright toggle
- env override disables editing and explains why
- enabling feature shows sidebar entry
- disabling feature hides nav and dashboard data view

#### Validation

- `pnpm exec tsc --noEmit`
- manual setting toggles through UI
- verify `GET /api/settings/playwright` and sidebar stay in sync

### Phase 6 — Polish, edge cases, error states

#### Files to create/modify

Modify any of:

- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/ws/routes/playwright-routes.ts`
- `apps/ui/src/components/playwright/*`
- `apps/ui/src/components/settings/SettingsGeneral.tsx`

#### Acceptance criteria

- corrupt files produce warnings, not crashes
- missing worktrees/session dirs show intelligible empty states
- all-stale sessions render clearly
- mobile layout remains usable
- loading/error states use existing app visual language

#### Validation

- `pnpm exec tsc --noEmit`
- manual smoke with missing dirs, bad JSON fixture, disabled feature, no sessions, many sessions

---

## 9. Edge Cases & Error Handling

### 9.1 No project configured / no worktrees found

Behavior:

- snapshot returns `ready` with `sessions = []`
- `warnings` may include “No Playwright scan roots resolved”
- UI shows empty state with explanation and Settings CTA

### 9.2 Feature disabled (env/settings)

Behavior:

- snapshot `serviceStatus = 'disabled'`
- empty `sessions`
- settings endpoint still available
- sidebar nav hidden
- direct dashboard route renders disabled-state surface

### 9.3 Discovery service not started

Behavior:

- `/api/playwright/sessions` and `/api/playwright/rescan` return `503`
- settings endpoint remains available
- UI shows retryable error banner

### 9.4 Corrupt/unreadable session files

Behavior:

- skip unreadable file
- append snapshot warning containing path
- continue scanning remaining files

### 9.5 Missing socket directory

Behavior:

- treat all sockets as absent
- no fatal error
- rows fall back to inactive/stale based on age

### 9.6 All sessions stale

Behavior:

- valid snapshot with rows
- summary shows zero active, non-zero stale
- UI should not frame this as backend failure

### 9.7 Large number of worktrees

Behavior:

- scan only known Playwright/session paths
- reuse per-root artifact counts
- avoid recursive file walks
- serialize scans to avoid overlap

### 9.8 Path normalization (realpath/symlinks)

Behavior:

- normalize roots, session file paths, worktree paths, and agent cwd paths with `realpath` when possible
- if `realpath` fails, fall back to resolved absolute path and append warning only if needed

### 9.9 WS reconnect behavior

Current app may reload the page after reconnect. Therefore:

- backend bootstrap must include a Playwright snapshot
- dashboard must tolerate a null snapshot briefly after reload
- local filters may reset in v1; this is acceptable

### 9.10 Mobile/responsive layout

Behavior:

- desktop: summary cards + table/list
- mobile: stacked cards with truncated paths and badges
- all tall regions use `min-h-0` + `overflow-y-auto` / `ScrollArea`

(Sources: [UI §§8, 12], [BE §13], [DISC §§11-13])

---

## 10. Future Enhancements (documented, not in scope)

These are intentionally deferred:

1. **CDP integration for live screenshots/URL**
   - use `http://127.0.0.1:<cdpPort>/json/version` and target inspection endpoints for richer data
2. **Session detail drill-down panel**
   - right-side sheet/dialog for full metadata and duplicate-group detail
3. **Quick actions**
   - open frontend URL, reveal path in Finder, copy socket path, trigger snapshot utility
4. **Custom tool for agents to query session status**
   - read-only tool backed by the discovery snapshot
5. **Multi-project support**
   - multiple configured repo roots with project grouping
6. **Session history/timeline tracking**
   - persist scan deltas and row history for forensic views

Decision: these are valuable but would substantially expand scope beyond the v1 discovery dashboard. (Sources: [UI §11], [BE §14], [DISC §13])

---

## Appendix A — Recommended file change matrix

### Create

- `docs/playwright-dashboard/DESIGN.md`
- `apps/backend/src/playwright/playwright-discovery-service.ts`
- `apps/backend/src/playwright/playwright-settings-service.ts`
- `apps/backend/src/ws/routes/playwright-routes.ts`
- `packages/protocol/src/playwright.ts`
- `apps/ui/src/components/playwright/PlaywrightDashboardView.tsx`
- `apps/ui/src/components/playwright/PlaywrightSessionCard.tsx`
- `apps/ui/src/components/playwright/PlaywrightSummaryBar.tsx`
- `apps/ui/src/components/playwright/PlaywrightFilters.tsx`
- `apps/ui/src/components/playwright/playwright-api.ts`

### Modify

- `apps/backend/src/index.ts`
- `apps/backend/src/config.ts`
- `apps/backend/src/swarm/data-paths.ts`
- `apps/backend/src/ws/server.ts`
- `apps/backend/src/ws/ws-handler.ts`
- `packages/protocol/src/server-events.ts`
- `packages/protocol/src/index.ts`
- `apps/ui/src/hooks/index-page/use-route-state.ts`
- `apps/ui/src/routes/index.tsx`
- `apps/ui/src/components/chat/AgentSidebar.tsx`
- `apps/ui/src/components/settings/SettingsGeneral.tsx`
- `apps/ui/src/components/settings/settings-api.ts`
- `apps/ui/src/lib/ws-state.ts`
- `apps/ui/src/lib/ws-client.ts`

---

## Appendix B — Final implementation decisions at a glance

- **Center-pane dashboard view, not right drawer**
- **Top-level backend discovery service, not `SwarmManager` internals**
- **HTTP bootstrap + WS snapshot updates**
- **Full snapshot event model, no incremental patches**
- **Dedicated shared settings file with env override precedence**
- **Filesystem-first worktree/session discovery**
- **Heuristic correlation with explicit confidence and reasons**
- **Observation only; no browser control**

(Sources: [UI], [BE], [DISC], [AGENTS])
