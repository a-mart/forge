import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, realpathSync, watch, type FSWatcher } from 'node:fs'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  AgentDescriptor,
  PlaywrightDiscoveredSession,
  PlaywrightDiscoverySettings,
  PlaywrightDiscoverySnapshot,
  PlaywrightSessionArtifactCounts,
  PlaywrightSessionCorrelation,
  PlaywrightSessionPorts,
  PlaywrightSessionSchemaVersion,
} from '@middleman/protocol'
import type { SwarmManager } from '../swarm/swarm-manager.js'
import {
  PlaywrightSettingsService,
  type PlaywrightPersistedSettings,
  createDefaultPersistedSettings,
} from './playwright-settings-service.js'

const SOCKETS_BASE_DIR = '/tmp/playwright-cli-sockets'

const LIVENESS_PRIORITY: Record<PlaywrightDiscoveredSession['liveness'], number> = {
  active: 0,
  inactive: 1,
  stale: 2,
  error: 3,
}

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
    sessionConfig?: {
      timestamp?: number
    }
  }
}

type PlaywrightSessionFile = PlaywrightSessionFileV1 | PlaywrightSessionFileV2

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
  sessionVersion: string | null
  root: PlaywrightScanRoot
  runtimeEnv: PlaywrightRuntimeEnvInfo | null
  artifactCounts: PlaywrightSessionArtifactCounts
  warnings: string[]
  daemonId: string | null
  socketPath: string | null
  browserName: string | null
  browserChannel: string | null
  headless: boolean | null
  persistent: boolean | null
  isolated: boolean | null
  userDataDirPath: string | null
  userDataDirExists: boolean
  ports: PlaywrightSessionPorts
  duplicateGroupKey: string
  duplicateRank: number
  preferredInDuplicateGroup: boolean
}

interface PlaywrightProbeResult {
  socketExists: boolean
  socketResponsive: boolean | null
  cdpResponsive: boolean | null
}

interface PlaywrightScanRootResolution {
  roots: PlaywrightScanRoot[]
  warnings: string[]
  watchPaths: string[]
}

export class PlaywrightSettingsConflictError extends Error {
  constructor(message = 'Playwright Dashboard settings are controlled by MIDDLEMAN_PLAYWRIGHT_DASHBOARD_ENABLED') {
    super(message)
    this.name = 'PlaywrightSettingsConflictError'
  }
}

export class PlaywrightDiscoveryService extends EventEmitter {
  private readonly swarmManager: SwarmManager
  private readonly settingsService: PlaywrightSettingsService
  private readonly envEnabledOverride: boolean | undefined
  private readonly now: () => Date

  private running = false
  private lifecycle: Promise<void> = Promise.resolve()
  private pollTimer: NodeJS.Timeout | null = null
  private readonly watchers = new Map<string, FSWatcher>()

  private currentSettings: PlaywrightDiscoverySettings
  private currentSnapshot: PlaywrightDiscoverySnapshot

  constructor(options: {
    swarmManager: SwarmManager
    settingsService: PlaywrightSettingsService
    envEnabledOverride?: boolean
    now?: () => Date
  }) {
    super()
    this.swarmManager = options.swarmManager
    this.settingsService = options.settingsService
    this.envEnabledOverride = options.envEnabledOverride
    this.now = options.now ?? (() => new Date())

    this.currentSettings = createEffectiveSettings(
      createDefaultPersistedSettings(),
      this.envEnabledOverride,
    )
    this.currentSnapshot = createEmptySnapshot(this.currentSettings, 'disabled')
  }

  async start(): Promise<void> {
    if (this.running) {
      return
    }

    this.running = true
    this.currentSettings = this.computeEffectiveSettings()
    this.emitSettingsUpdated()

    if (!this.currentSettings.effectiveEnabled) {
      this.currentSnapshot = createEmptySnapshot(this.currentSettings, 'disabled')
      this.emitSnapshot(this.currentSnapshot, 'playwright_discovery_snapshot')
      return
    }

    this.startPolling()
    await this.enqueueOperation(async () => {
      await this.runScan('startup', 'playwright_discovery_snapshot')
    })
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return
    }

    this.running = false
    this.stopPolling()
    this.clearWatchers()
    await this.lifecycle
  }

  getSnapshot(): PlaywrightDiscoverySnapshot {
    return cloneSnapshot(this.currentSnapshot)
  }

  getSettings(): PlaywrightDiscoverySettings {
    return {
      ...this.currentSettings,
      scanRoots: [...this.currentSettings.scanRoots],
    }
  }

  getSessionById(sessionId: string): PlaywrightDiscoveredSession | null {
    const normalizedSessionId = sessionId.trim()
    if (!normalizedSessionId) {
      return null
    }

    const session = this.currentSnapshot.sessions.find((candidate) => candidate.id === normalizedSessionId)
    return session ? JSON.parse(JSON.stringify(session)) as PlaywrightDiscoveredSession : null
  }

  isEffectivelyEnabled(): boolean {
    return this.currentSettings.effectiveEnabled
  }

  async triggerRescan(reason = 'manual'): Promise<PlaywrightDiscoverySnapshot> {
    if (!this.currentSettings.effectiveEnabled) {
      return this.getSnapshot()
    }

    return await this.enqueueOperation(async () => {
      if (!this.running || !this.currentSettings.effectiveEnabled) {
        return this.getSnapshot()
      }

      await this.runScan(reason, 'playwright_discovery_updated')
      return this.getSnapshot()
    })
  }

  async updateSettings(patch: {
    enabled?: boolean
    scanRoots?: string[]
    pollIntervalMs?: number
    socketProbeTimeoutMs?: number
    staleSessionThresholdMs?: number
  }): Promise<{ settings: PlaywrightDiscoverySettings; snapshot: PlaywrightDiscoverySnapshot }> {
    return await this.enqueueOperation(async () => {
      if (this.envEnabledOverride !== undefined) {
        throw new PlaywrightSettingsConflictError()
      }

      await this.settingsService.update(patch)
      this.currentSettings = this.computeEffectiveSettings()
      this.emitSettingsUpdated()

      this.stopPolling()
      this.clearWatchers()

      if (!this.currentSettings.effectiveEnabled) {
        this.currentSnapshot = createEmptySnapshot(this.currentSettings, 'disabled')
        this.emitSnapshot(this.currentSnapshot, 'playwright_discovery_updated')
        return { settings: this.getSettings(), snapshot: this.getSnapshot() }
      }

      this.startPolling()
      await this.runScan('settings_update', 'playwright_discovery_updated')
      return { settings: this.getSettings(), snapshot: this.getSnapshot() }
    })
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation)
    this.lifecycle = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private computeEffectiveSettings(): PlaywrightDiscoverySettings {
    return createEffectiveSettings(this.settingsService.getPersisted(), this.envEnabledOverride)
  }

  private startPolling(): void {
    this.stopPolling()

    if (!this.currentSettings.effectiveEnabled) {
      return
    }

    this.pollTimer = setInterval(() => {
      this.requestScan('poll')
    }, this.currentSettings.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }

  private rebuildWatchers(paths: string[]): void {
    const nextPaths = new Set(paths)

    for (const [watchPath, watcher] of this.watchers.entries()) {
      if (nextPaths.has(watchPath)) {
        continue
      }
      watcher.close()
      this.watchers.delete(watchPath)
    }

    for (const watchPath of nextPaths) {
      if (this.watchers.has(watchPath) || !existsSync(watchPath)) {
        continue
      }

      try {
        const watcher = watch(watchPath, () => {
          this.requestScan(`watch:${watchPath}`)
        })
        watcher.on('error', (error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[playwright] watcher error for ${watchPath}: ${message}`)
          this.requestScan(`watch_error:${watchPath}`)
        })
        this.watchers.set(watchPath, watcher)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[playwright] failed to watch ${watchPath}: ${message}`)
      }
    }
  }

  private requestScan(reason: string): void {
    if (!this.running || !this.currentSettings.effectiveEnabled) {
      return
    }

    void this.enqueueOperation(async () => {
      if (!this.running || !this.currentSettings.effectiveEnabled) {
        return
      }

      await this.runScan(reason, 'playwright_discovery_updated')
    })
  }

  private async runScan(
    reason: string,
    eventType: 'playwright_discovery_snapshot' | 'playwright_discovery_updated',
  ): Promise<void> {
    const previousSnapshot = this.currentSnapshot
    const startedAt = this.now().toISOString()

    try {
      const resolution = await this.resolveScanRoots(this.currentSettings)
      const sessionScan = await this.scanSessions(resolution.roots)
      const completedAt = this.now().toISOString()

      const nextSnapshot: PlaywrightDiscoverySnapshot = {
        updatedAt: previousSnapshot.updatedAt,
        lastScanStartedAt: startedAt,
        lastScanCompletedAt: completedAt,
        scanDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        sequence: previousSnapshot.sequence,
        serviceStatus: 'ready',
        settings: this.getSettings(),
        rootsScanned: resolution.roots.map((root) => root.rootPath),
        summary: buildSummary(sessionScan.sessions),
        sessions: sessionScan.sessions,
        warnings: dedupeStrings([...resolution.warnings, ...sessionScan.warnings]),
        lastError: null,
      }

      const changed = !snapshotsEqual(previousSnapshot, nextSnapshot)
      this.currentSnapshot = {
        ...nextSnapshot,
        sequence: changed ? previousSnapshot.sequence + 1 : previousSnapshot.sequence,
        updatedAt: changed ? completedAt : previousSnapshot.updatedAt,
      }

      this.rebuildWatchers(resolution.watchPaths)

      if (changed || eventType === 'playwright_discovery_snapshot') {
        this.emitSnapshot(this.currentSnapshot, eventType)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const completedAt = this.now().toISOString()
      const failedSnapshot: PlaywrightDiscoverySnapshot = {
        ...createEmptySnapshot(this.getSettings(), 'error'),
        sequence: previousSnapshot.sequence + 1,
        updatedAt: completedAt,
        lastScanStartedAt: startedAt,
        lastScanCompletedAt: completedAt,
        scanDurationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        lastError: message,
      }

      this.currentSnapshot = failedSnapshot
      this.emitSnapshot(this.currentSnapshot, eventType)
    }
  }

  private async resolveScanRoots(
    settings: PlaywrightDiscoverySettings,
  ): Promise<PlaywrightScanRootResolution> {
    const warnings: string[] = []
    const roots = new Map<string, PlaywrightScanRoot>()
    const watchPaths = new Set<string>([SOCKETS_BASE_DIR])
    const baseRoots = new Set<string>()

    const config = this.swarmManager.getConfig()
    baseRoots.add(normalizePath(config.paths.rootDir))
    for (const root of config.cwdAllowlistRoots) {
      baseRoots.add(normalizePath(root))
    }
    for (const root of settings.scanRoots) {
      baseRoots.add(normalizePath(root))
    }
    for (const agent of this.swarmManager.listAgents()) {
      for (const discoveredRoot of discoverLikelyProjectRoots(agent.cwd)) {
        baseRoots.add(discoveredRoot)
      }
    }

    for (const baseRoot of Array.from(baseRoots).sort((left, right) => left.localeCompare(right))) {
      const expansion = await expandBaseRoot(baseRoot, warnings)
      for (const root of expansion.roots) {
        roots.set(root.rootPath, root)
      }
      for (const watchPath of expansion.watchPaths) {
        watchPaths.add(watchPath)
      }
    }

    return {
      roots: Array.from(roots.values()).sort((left, right) => left.rootPath.localeCompare(right.rootPath)),
      warnings: dedupeStrings(warnings),
      watchPaths: Array.from(watchPaths).sort((left, right) => left.localeCompare(right)),
    }
  }

  private async scanSessions(roots: PlaywrightScanRoot[]): Promise<{
    sessions: PlaywrightDiscoveredSession[]
    warnings: string[]
  }> {
    const agents = this.swarmManager.listAgents()
    const candidates: PlaywrightSessionCandidate[] = []
    const warnings: string[] = []

    for (const root of roots) {
      const runtimeEnv = await readRuntimeEnv(root.runtimeEnvPath)
      const artifactCounts = await countArtifacts(root.artifactDirPath)
      const sessionFiles = await listSessionFiles(root.sessionDirPath)

      for (const sessionFilePath of sessionFiles) {
        const parsed = await parseSessionFile(root, runtimeEnv, artifactCounts, sessionFilePath)
        if ('warning' in parsed) {
          warnings.push(parsed.warning)
          continue
        }

        candidates.push(parsed.candidate)
      }
    }

    assignDuplicateMetadata(candidates)

    const sessions: PlaywrightDiscoveredSession[] = []
    for (const candidate of candidates) {
      const probe = await probeSession(candidate, this.currentSettings.socketProbeTimeoutMs)
      const liveness = determineLiveness(candidate, probe, this.currentSettings.staleSessionThresholdMs, this.now())
      const correlation = correlateSession(candidate, liveness.liveness, agents, this.swarmManager)

      sessions.push({
        id: createHash('sha1').update(candidate.sessionFileRealPath).digest('hex'),
        sessionName: candidate.sessionName,
        sessionVersion: candidate.sessionVersion,
        schemaVersion: candidate.schemaVersion,
        sessionFilePath: candidate.sessionFilePath,
        sessionFileRealPath: candidate.sessionFileRealPath,
        sessionFileUpdatedAt: candidate.sessionFileUpdatedAt,
        sessionTimestamp: candidate.sessionTimestampMs ? new Date(candidate.sessionTimestampMs).toISOString() : null,
        rootPath: candidate.root.rootPath,
        rootKind: candidate.root.rootKind,
        repoRootPath: candidate.root.repoRootPath,
        backendRootPath: candidate.root.backendRootPath,
        worktreePath: candidate.root.worktreePath,
        worktreeName: candidate.root.worktreeName,
        daemonId: candidate.daemonId,
        socketPath: candidate.socketPath,
        socketExists: probe.socketExists,
        socketResponsive: probe.socketResponsive,
        cdpResponsive: probe.cdpResponsive,
        liveness: liveness.liveness,
        stale: liveness.stale,
        staleReason: liveness.staleReason,
        browserName: candidate.browserName,
        browserChannel: candidate.browserChannel,
        headless: candidate.headless,
        persistent: candidate.persistent,
        isolated: candidate.isolated,
        userDataDirPath: candidate.userDataDirPath,
        userDataDirExists: candidate.userDataDirExists,
        ports: { ...candidate.ports },
        artifactCounts: { ...candidate.artifactCounts },
        duplicateGroupKey: candidate.duplicateGroupKey,
        duplicateRank: candidate.duplicateRank,
        preferredInDuplicateGroup: candidate.preferredInDuplicateGroup,
        correlation,
        warnings: dedupeStrings(candidate.warnings),
      })
    }

    sessions.sort(compareSessions)
    return {
      sessions,
      warnings: dedupeStrings(warnings),
    }
  }

  private emitSnapshot(
    snapshot: PlaywrightDiscoverySnapshot,
    eventType: 'playwright_discovery_snapshot' | 'playwright_discovery_updated',
  ): void {
    this.emit(eventType, {
      type: eventType,
      snapshot: cloneSnapshot(snapshot),
    })
  }

  private emitSettingsUpdated(): void {
    this.emit('playwright_discovery_settings_updated', {
      type: 'playwright_discovery_settings_updated',
      settings: this.getSettings(),
    })
  }

}

function createEffectiveSettings(
  persisted: PlaywrightPersistedSettings,
  envEnabledOverride: boolean | undefined,
): PlaywrightDiscoverySettings {
  const source: PlaywrightDiscoverySettings['source'] =
    envEnabledOverride !== undefined ? 'env' : persisted.updatedAt ? 'settings' : 'default'

  return {
    enabled: persisted.enabled,
    effectiveEnabled: envEnabledOverride ?? persisted.enabled,
    source,
    envOverride: envEnabledOverride ?? null,
    scanRoots: [...persisted.scanRoots],
    pollIntervalMs: persisted.pollIntervalMs,
    socketProbeTimeoutMs: persisted.socketProbeTimeoutMs,
    staleSessionThresholdMs: persisted.staleSessionThresholdMs,
    updatedAt: persisted.updatedAt,
  }
}

function createEmptySnapshot(
  settings: PlaywrightDiscoverySettings,
  status: PlaywrightDiscoverySnapshot['serviceStatus'],
): PlaywrightDiscoverySnapshot {
  return {
    updatedAt: null,
    lastScanStartedAt: null,
    lastScanCompletedAt: null,
    scanDurationMs: null,
    sequence: 0,
    serviceStatus: status,
    settings,
    rootsScanned: [],
    summary: {
      totalSessions: 0,
      activeSessions: 0,
      inactiveSessions: 0,
      staleSessions: 0,
      legacySessions: 0,
      duplicateSessions: 0,
      correlatedSessions: 0,
      unmatchedSessions: 0,
      worktreeCount: 0,
    },
    sessions: [],
    warnings: [],
    lastError: null,
  }
}

function cloneSnapshot(snapshot: PlaywrightDiscoverySnapshot): PlaywrightDiscoverySnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as PlaywrightDiscoverySnapshot
}

function snapshotsEqual(left: PlaywrightDiscoverySnapshot, right: PlaywrightDiscoverySnapshot): boolean {
  return JSON.stringify(normalizeSnapshotForComparison(left)) === JSON.stringify(normalizeSnapshotForComparison(right))
}

function normalizeSnapshotForComparison(snapshot: PlaywrightDiscoverySnapshot): unknown {
  return {
    serviceStatus: snapshot.serviceStatus,
    settings: {
      ...snapshot.settings,
      scanRoots: [...snapshot.settings.scanRoots].sort((left, right) => left.localeCompare(right)),
    },
    rootsScanned: [...snapshot.rootsScanned].sort((left, right) => left.localeCompare(right)),
    summary: snapshot.summary,
    sessions: snapshot.sessions.map((session) => ({
      ...session,
      warnings: [...session.warnings].sort((left, right) => left.localeCompare(right)),
      correlation: {
        ...session.correlation,
        reasons: [...session.correlation.reasons].sort((left, right) => left.localeCompare(right)),
      },
    })),
    warnings: [...snapshot.warnings].sort((left, right) => left.localeCompare(right)),
    lastError: snapshot.lastError,
  }
}

async function expandBaseRoot(
  baseRoot: string,
  warnings: string[],
): Promise<{ roots: PlaywrightScanRoot[]; watchPaths: string[] }> {
  const roots: PlaywrightScanRoot[] = []
  const watchPaths = new Set<string>()
  const normalizedBase = normalizePath(baseRoot)
  const repoRoot = looksLikeRepoRoot(normalizedBase) ? normalizedBase : null

  if (await pathExists(join(normalizedBase, '.playwright-cli'))) {
    roots.push(await buildScanRoot(normalizedBase, repoRoot ? 'repo-root' : 'worktree-root', repoRoot, repoRoot ? null : normalizedBase))
  }

  const backendRoot = join(normalizedBase, 'backend')
  if (await pathExists(join(backendRoot, '.playwright-cli'))) {
    roots.push(await buildScanRoot(backendRoot, 'backend-root', repoRoot, repoRoot ? null : normalizedBase))
  }

  if (repoRoot) {
    const worktrees = await enumerateWorktrees(repoRoot, warnings)
    for (const worktreePath of worktrees) {
      if (await pathExists(join(worktreePath, '.playwright-cli'))) {
        roots.push(await buildScanRoot(worktreePath, 'worktree-root', repoRoot, worktreePath))
      }

      const worktreeBackendRoot = join(worktreePath, 'backend')
      if (await pathExists(join(worktreeBackendRoot, '.playwright-cli'))) {
        roots.push(await buildScanRoot(worktreeBackendRoot, 'backend-root', repoRoot, worktreePath))
      }
    }
  }

  for (const root of roots) {
    watchPaths.add(root.sessionDirPath)
    watchPaths.add(root.artifactDirPath)
    if (root.runtimeEnvPath) {
      watchPaths.add(dirname(root.runtimeEnvPath))
    }
  }

  return {
    roots,
    watchPaths: Array.from(watchPaths),
  }
}

function looksLikeRepoRoot(pathValue: string): boolean {
  return existsSync(join(pathValue, '.git', 'worktree-runtime')) || existsSync(join(dirname(pathValue), 'worktrees'))
}

async function enumerateWorktrees(repoRoot: string, warnings: string[]): Promise<string[]> {
  const worktrees = new Set<string>()
  const siblingWorktreesDir = join(dirname(repoRoot), 'worktrees')

  if (await pathExists(siblingWorktreesDir)) {
    try {
      const entries = await readdir(siblingWorktreesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          worktrees.add(normalizePath(join(siblingWorktreesDir, entry.name)))
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`Unable to enumerate worktrees in ${siblingWorktreesDir}: ${message}`)
    }
  }

  const registryPath = join(repoRoot, '.git', 'worktree-runtime', 'registry.tsv')
  if (await pathExists(registryPath)) {
    try {
      const raw = await readFile(registryPath, 'utf8')
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) {
          continue
        }

        const parts = trimmed.split('\t')
        const worktreePath = parts[1]?.trim()
        if (!worktreePath) {
          continue
        }

        const normalized = normalizePath(worktreePath)
        if (await pathExists(normalized)) {
          worktrees.add(normalized)
        } else {
          warnings.push(`Ignoring missing worktree from registry: ${worktreePath}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`Unable to read registry ${registryPath}: ${message}`)
    }
  }

  return Array.from(worktrees).sort((left, right) => left.localeCompare(right))
}

async function buildScanRoot(
  rootPath: string,
  rootKind: PlaywrightScanRoot['rootKind'],
  repoRootPath: string | null,
  worktreePath: string | null,
): Promise<PlaywrightScanRoot> {
  const normalizedRoot = normalizePath(rootPath)
  const normalizedWorktree = worktreePath ? normalizePath(worktreePath) : null

  return {
    rootPath: normalizedRoot,
    rootKind,
    repoRootPath: repoRootPath ? normalizePath(repoRootPath) : null,
    backendRootPath: rootKind === 'backend-root' ? normalizedRoot : null,
    worktreePath: normalizedWorktree,
    worktreeName: normalizedWorktree ? basename(normalizedWorktree) : null,
    sessionDirPath: join(normalizedRoot, '.playwright-cli', 'sessions'),
    artifactDirPath: join(normalizedRoot, '.playwright-cli'),
    runtimeEnvPath: await resolveRuntimeEnvPath(normalizedWorktree, repoRootPath ? normalizePath(repoRootPath) : null),
  }
}

function discoverLikelyProjectRoots(pathValue: string): string[] {
  const normalized = normalizePath(pathValue)
  const results = new Set<string>([normalized])
  let current = normalized

  for (let depth = 0; depth < 6; depth += 1) {
    const base = basename(current)
    if (base === 'backend') {
      results.add(normalizePath(dirname(current)))
    }

    if (existsSync(join(current, '.git')) || existsSync(join(current, '.playwright-cli'))) {
      results.add(current)
    }

    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return Array.from(results)
}

async function resolveRuntimeEnvPath(worktreePath: string | null, repoRootPath: string | null): Promise<string | null> {
  if (!worktreePath) {
    return null
  }

  const worktreeEnvPath = join(worktreePath, 'backend', '.env.worktree.runtime')
  if (await pathExists(worktreeEnvPath)) {
    return worktreeEnvPath
  }

  if (!repoRootPath) {
    return null
  }

  const runtimeDir = join(repoRootPath, '.git', 'worktree-runtime')
  if (!(await pathExists(runtimeDir))) {
    return null
  }

  try {
    const entries = await readdir(runtimeDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.env')) {
        continue
      }

      const candidatePath = join(runtimeDir, entry.name)
      const raw = await readFile(candidatePath, 'utf8')
      const env = parseEnvFile(raw)
      const stackRoot = normalizeOptionalPath(env.STACK_ROOT)
      if (stackRoot && normalizePath(stackRoot) === worktreePath) {
        return candidatePath
      }
    }
  } catch {
    return null
  }

  return null
}

async function readRuntimeEnv(pathValue: string | null): Promise<PlaywrightRuntimeEnvInfo | null> {
  if (!pathValue) {
    return null
  }

  try {
    const raw = await readFile(pathValue, 'utf8')
    const env = parseEnvFile(raw)
    return {
      envFilePath: pathValue,
      stackId: getNonEmptyString(env.STACK_ID),
      stackRoot: normalizeOptionalPath(env.STACK_ROOT),
      frontendPort: parseOptionalPort(env.WT_FRONTEND_PORT ?? env.FRONTEND_HOST_PORT),
      backendApiPort: parseOptionalPort(env.WT_API_PORT ?? env.AGENT_BACKEND_HOST_PORT),
      sandboxPort: parseOptionalPort(env.WT_SANDBOX_PORT ?? env.SANDBOX_HOST_PORT),
      liteLlmPort: parseOptionalPort(env.LITELLM_HOST_PORT),
    }
  } catch {
    return null
  }
}

function parseEnvFile(raw: string): Record<string, string> {
  const result: Record<string, string> = {}

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!key) {
      continue
    }

    result[key] = stripMatchingQuotes(value)
  }

  return result
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

async function listSessionFiles(sessionDirPath: string): Promise<string[]> {
  if (!(await pathExists(sessionDirPath))) {
    return []
  }

  const sessionFiles: string[] = []
  const entries = await readdir(sessionDirPath, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(sessionDirPath, entry.name)
    if (entry.isFile() && entry.name.endsWith('.session')) {
      sessionFiles.push(entryPath)
      continue
    }

    if (!entry.isDirectory()) {
      continue
    }

    const nestedEntries = await readdir(entryPath, { withFileTypes: true })
    for (const nested of nestedEntries) {
      if (nested.isFile() && nested.name.endsWith('.session')) {
        sessionFiles.push(join(entryPath, nested.name))
      }
    }
  }

  sessionFiles.sort((left, right) => left.localeCompare(right))
  return sessionFiles
}

async function parseSessionFile(
  root: PlaywrightScanRoot,
  runtimeEnv: PlaywrightRuntimeEnvInfo | null,
  artifactCounts: PlaywrightSessionArtifactCounts,
  sessionFilePath: string,
): Promise<{ candidate: PlaywrightSessionCandidate } | { warning: string }> {
  let rawText: string
  try {
    rawText = await readFile(sessionFilePath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { warning: `Unable to read Playwright session file ${sessionFilePath}: ${message}` }
  }

  let rawJson: unknown
  try {
    rawJson = JSON.parse(rawText) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { warning: `Invalid Playwright session JSON ${sessionFilePath}: ${message}` }
  }

  if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
    return { warning: `Invalid Playwright session payload ${sessionFilePath}: expected JSON object` }
  }

  try {
    const raw = rawJson as PlaywrightSessionFile
    const realPath = await realpathOrResolve(sessionFilePath)
    const fileStats = await stat(sessionFilePath)
    const sessionName = getNonEmptyString((raw as PlaywrightSessionFileV2).name) ?? basename(sessionFilePath, '.session')
    const sessionTimestampMs =
      getFiniteNumber((raw as PlaywrightSessionFileV2).timestamp) ??
      getFiniteNumber((raw as PlaywrightSessionFileV2).resolvedConfig?.sessionConfig?.timestamp)
    const schemaVersion: PlaywrightSessionSchemaVersion =
      getNonEmptyString((raw as PlaywrightSessionFileV2).name) || sessionTimestampMs !== null || Boolean((raw as PlaywrightSessionFileV2).resolvedConfig)
        ? 'v2'
        : 'v1'

    const socketPath = normalizeOptionalPath(raw.socketPath)
    const userDataDirPrefix = normalizeOptionalPath(raw.userDataDirPrefix)
    const userDataDirPath =
      normalizeOptionalPath((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.userDataDir) ??
      (userDataDirPrefix ? `${userDataDirPrefix}-chrome` : null)
    const warnings: string[] = []

    if (!socketPath) {
      warnings.push('missing_socket_path')
    }
    if (schemaVersion === 'v2' && sessionTimestampMs === null) {
      warnings.push('missing_timestamp')
    }
    if (runtimeEnv === null && root.worktreePath) {
      warnings.push('missing_runtime_env')
    }

    return {
      candidate: {
        raw,
        schemaVersion,
        sessionFilePath: normalizePath(sessionFilePath),
        sessionFileRealPath: realPath,
        sessionFileUpdatedAt: fileStats.mtime.toISOString(),
        sessionTimestampMs,
        sessionName,
        sessionVersion: getNonEmptyString(raw.version),
        root,
        runtimeEnv,
        artifactCounts,
        warnings,
        daemonId: inferDaemonId(root.sessionDirPath, sessionFilePath),
        socketPath,
        browserName: getNonEmptyString((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.browserName),
        browserChannel: getNonEmptyString((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.launchOptions?.channel),
        headless: getOptionalBoolean((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.launchOptions?.headless),
        persistent: getOptionalBoolean(raw.cli?.persistent),
        isolated: getOptionalBoolean((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.isolated),
        userDataDirPath,
        userDataDirExists: userDataDirPath ? await pathExists(userDataDirPath) : false,
        ports: {
          frontend: runtimeEnv?.frontendPort ?? null,
          backendApi: runtimeEnv?.backendApiPort ?? null,
          sandbox: runtimeEnv?.sandboxPort ?? null,
          liteLlm: runtimeEnv?.liteLlmPort ?? null,
          cdp: getFiniteNumber((raw as PlaywrightSessionFileV2).resolvedConfig?.browser?.launchOptions?.cdpPort),
        },
        duplicateGroupKey: socketPath ?? realPath,
        duplicateRank: 0,
        preferredInDuplicateGroup: true,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { warning: `Unable to process Playwright session file ${sessionFilePath}: ${message}` }
  }
}

async function countArtifacts(artifactDirPath: string): Promise<PlaywrightSessionArtifactCounts> {
  const counts: PlaywrightSessionArtifactCounts = {
    pageSnapshots: 0,
    screenshots: 0,
    consoleLogs: 0,
    networkLogs: 0,
    total: 0,
    lastArtifactAt: null,
  }

  if (!(await pathExists(artifactDirPath))) {
    return counts
  }

  const entries = await readdir(artifactDirPath, { withFileTypes: true })
  let newestArtifactMs = 0

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const fileName = entry.name
    let matched = false
    if (fileName.startsWith('page-') && fileName.endsWith('.yml')) {
      counts.pageSnapshots += 1
      matched = true
    } else if (fileName.endsWith('.png')) {
      counts.screenshots += 1
      matched = true
    } else if (fileName.startsWith('console-') && fileName.endsWith('.log')) {
      counts.consoleLogs += 1
      matched = true
    } else if (fileName.startsWith('network-') && fileName.endsWith('.log')) {
      counts.networkLogs += 1
      matched = true
    }

    if (!matched) {
      continue
    }

    counts.total += 1

    try {
      const fileStats = await stat(join(artifactDirPath, fileName))
      newestArtifactMs = Math.max(newestArtifactMs, fileStats.mtimeMs)
    } catch {
      // ignore artifact stat failures
    }
  }

  counts.lastArtifactAt = newestArtifactMs > 0 ? new Date(newestArtifactMs).toISOString() : null
  return counts
}

function assignDuplicateMetadata(candidates: PlaywrightSessionCandidate[]): void {
  const groups = new Map<string, PlaywrightSessionCandidate[]>()

  for (const candidate of candidates) {
    const existing = groups.get(candidate.duplicateGroupKey)
    if (existing) {
      existing.push(candidate)
    } else {
      groups.set(candidate.duplicateGroupKey, [candidate])
    }
  }

  for (const group of groups.values()) {
    group.sort((left, right) => {
      const leftTs = left.sessionTimestampMs ?? Date.parse(left.sessionFileUpdatedAt)
      const rightTs = right.sessionTimestampMs ?? Date.parse(right.sessionFileUpdatedAt)
      if (rightTs !== leftTs) {
        return rightTs - leftTs
      }
      return left.sessionFileRealPath.localeCompare(right.sessionFileRealPath)
    })

    group.forEach((candidate, index) => {
      candidate.duplicateRank = index
      candidate.preferredInDuplicateGroup = index === 0
    })
  }
}

async function probeSession(
  candidate: PlaywrightSessionCandidate,
  socketProbeTimeoutMs: number,
): Promise<PlaywrightProbeResult> {
  if (!candidate.socketPath) {
    return {
      socketExists: false,
      socketResponsive: false,
      cdpResponsive: null,
    }
  }

  let socketExists = false
  try {
    const socketStats = await lstat(candidate.socketPath)
    socketExists = socketStats.isSocket() || socketStats.isFile()
  } catch {
    socketExists = false
  }

  if (!socketExists) {
    return {
      socketExists: false,
      socketResponsive: false,
      cdpResponsive: null,
    }
  }

  const socketResponsive = await probeSocket(candidate.socketPath, socketProbeTimeoutMs)
  const cdpResponsive =
    candidate.preferredInDuplicateGroup && candidate.ports.cdp !== null
      ? await probeCdpPort(candidate.ports.cdp, socketProbeTimeoutMs)
      : null

  if (socketExists && socketResponsive === false && candidate.warnings.indexOf('socket_unresponsive') === -1) {
    candidate.warnings.push('socket_unresponsive')
  }
  if (candidate.ports.cdp !== null && cdpResponsive === false && candidate.warnings.indexOf('cdp_unresponsive') === -1) {
    candidate.warnings.push('cdp_unresponsive')
  }

  return {
    socketExists,
    socketResponsive,
    cdpResponsive,
  }
}

async function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const connection = createConnection(socketPath)
    const timeout = setTimeout(() => {
      connection.destroy()
      resolve(false)
    }, timeoutMs)

    connection.on('connect', () => {
      clearTimeout(timeout)
      connection.destroy()
      resolve(true)
    })

    connection.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

async function probeCdpPort(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

function determineLiveness(
  candidate: PlaywrightSessionCandidate,
  probe: PlaywrightProbeResult,
  staleThresholdMs: number,
  now: Date,
): {
  liveness: PlaywrightDiscoveredSession['liveness']
  stale: boolean
  staleReason: string | null
} {
  if (probe.socketExists && probe.socketResponsive === true) {
    return { liveness: 'active', stale: false, staleReason: null }
  }

  if (probe.socketExists && probe.socketResponsive === false) {
    return { liveness: 'error', stale: false, staleReason: 'socket_unresponsive' }
  }

  const referenceTimestamp = candidate.sessionTimestampMs ?? Date.parse(candidate.sessionFileUpdatedAt)
  const ageMs = now.getTime() - referenceTimestamp
  if (Number.isFinite(ageMs) && ageMs > staleThresholdMs) {
    return { liveness: 'stale', stale: true, staleReason: 'missing_socket_beyond_threshold' }
  }

  return { liveness: 'inactive', stale: false, staleReason: null }
}

function correlateSession(
  candidate: PlaywrightSessionCandidate,
  sessionLiveness: PlaywrightDiscoveredSession['liveness'],
  agents: AgentDescriptor[],
  swarmManager: SwarmManager,
): PlaywrightSessionCorrelation {
  const sessionPath = normalizePath(candidate.root.worktreePath ?? candidate.root.rootPath)
  const sessionRepoRoot = candidate.root.repoRootPath ? normalizePath(candidate.root.repoRootPath) : null
  const sessionTimestamp = candidate.sessionTimestampMs ?? Date.parse(candidate.sessionFileUpdatedAt)

  const ranked = agents
    .map((agent) => {
      const normalizedCwd = normalizePath(agent.cwd)
      let score = 0
      const reasons: string[] = []

      if (normalizedCwd === sessionPath) {
        score += 100
        reasons.push('cwd_exact_match')
        score += agent.role === 'worker' ? 10 : 5
        reasons.push(agent.role === 'worker' ? 'worker_preferred' : 'manager_exact_match')
      } else if (
        normalizedCwd.startsWith(`${sessionPath}/`) ||
        sessionPath.startsWith(`${normalizedCwd}/`)
      ) {
        score += 80
        reasons.push('cwd_ancestor_match')
      }

      const agentRepoRoot = guessRepoRoot(agent.cwd)
      if (sessionRepoRoot && agentRepoRoot && normalizePath(agentRepoRoot) === sessionRepoRoot) {
        score += 25
        reasons.push('same_repo_root')
      }

      const agentUpdatedAt = Date.parse(agent.updatedAt)
      if (Number.isFinite(agentUpdatedAt) && Math.abs(agentUpdatedAt - sessionTimestamp) <= 10 * 60 * 1000) {
        score += 15
        reasons.push('timestamp_proximity')
      }

      if ((agent.status === 'idle' || agent.status === 'streaming') && sessionLiveness === 'active') {
        score += 10
        reasons.push('agent_active_and_session_live')
      }

      return {
        agent,
        score,
        reasons,
      }
    })
    .filter((entry) => entry.score >= 40)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      if (left.agent.role !== right.agent.role) {
        return left.agent.role === 'worker' ? -1 : 1
      }
      const leftInactive = left.agent.status === 'terminated' || left.agent.status === 'stopped'
      const rightInactive = right.agent.status === 'terminated' || right.agent.status === 'stopped'
      if (leftInactive !== rightInactive) {
        return leftInactive ? 1 : -1
      }
      const updatedDiff = Date.parse(right.agent.updatedAt) - Date.parse(left.agent.updatedAt)
      if (updatedDiff !== 0) {
        return updatedDiff
      }
      return left.agent.agentId.localeCompare(right.agent.agentId)
    })

  const best = ranked[0]
  if (!best) {
    return {
      matchedAgentId: null,
      matchedAgentDisplayName: null,
      matchedManagerId: null,
      matchedManagerDisplayName: null,
      matchedProfileId: null,
      confidence: 'none',
      reasons: [],
    }
  }

  const manager = best.agent.role === 'manager' ? best.agent : swarmManager.getAgent(best.agent.managerId)
  return {
    matchedAgentId: best.agent.agentId,
    matchedAgentDisplayName: best.agent.sessionLabel ?? best.agent.displayName,
    matchedManagerId: manager?.agentId ?? best.agent.managerId,
    matchedManagerDisplayName: manager?.sessionLabel ?? manager?.displayName ?? null,
    matchedProfileId: manager?.profileId ?? (manager?.role === 'manager' ? manager.agentId : null),
    confidence: mapScoreToConfidence(best.score),
    reasons: [...best.reasons].sort((left, right) => left.localeCompare(right)),
  }
}

function mapScoreToConfidence(score: number): PlaywrightSessionCorrelation['confidence'] {
  if (score >= 100) {
    return 'high'
  }
  if (score >= 80) {
    return 'medium'
  }
  if (score >= 40) {
    return 'low'
  }
  return 'none'
}

function buildSummary(sessions: PlaywrightDiscoveredSession[]): PlaywrightDiscoverySnapshot['summary'] {
  const preferred = sessions.filter((session) => session.preferredInDuplicateGroup)
  const worktrees = new Set(sessions.map((session) => session.worktreePath).filter((value): value is string => Boolean(value)))
  const correlated = sessions.filter((session) => session.correlation.matchedAgentId !== null).length

  return {
    totalSessions: sessions.length,
    activeSessions: preferred.filter((session) => session.liveness === 'active').length,
    inactiveSessions: preferred.filter((session) => session.liveness === 'inactive').length,
    staleSessions: preferred.filter((session) => session.liveness === 'stale').length,
    legacySessions: sessions.filter((session) => session.schemaVersion === 'v1').length,
    duplicateSessions: sessions.filter((session) => session.duplicateRank > 0).length,
    correlatedSessions: correlated,
    unmatchedSessions: sessions.length - correlated,
    worktreeCount: worktrees.size,
  }
}

function compareSessions(left: PlaywrightDiscoveredSession, right: PlaywrightDiscoveredSession): number {
  if (left.preferredInDuplicateGroup !== right.preferredInDuplicateGroup) {
    return left.preferredInDuplicateGroup ? -1 : 1
  }

  const livenessDiff = LIVENESS_PRIORITY[left.liveness] - LIVENESS_PRIORITY[right.liveness]
  if (livenessDiff !== 0) {
    return livenessDiff
  }

  const leftTs = Date.parse(left.sessionTimestamp ?? left.sessionFileUpdatedAt)
  const rightTs = Date.parse(right.sessionTimestamp ?? right.sessionFileUpdatedAt)
  if (rightTs !== leftTs) {
    return rightTs - leftTs
  }

  return left.sessionFileRealPath.localeCompare(right.sessionFileRealPath)
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

async function realpathOrResolve(pathValue: string): Promise<string> {
  try {
    return normalizePath(await realpath(pathValue))
  } catch {
    return normalizePath(pathValue)
  }
}

function normalizePath(pathValue: string): string {
  try {
    return resolve(realpathSync(pathValue))
  } catch {
    return resolve(pathValue)
  }
}

function normalizeOptionalPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? normalizePath(trimmed) : null
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function getFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getOptionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function parseOptionalPort(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return null
  }
  return parsed
}

function inferDaemonId(sessionDirPath: string, sessionFilePath: string): string | null {
  const relative = normalizePath(sessionFilePath).slice(normalizePath(sessionDirPath).length + 1)
  const [firstSegment] = relative.split('/')
  return firstSegment && firstSegment !== basename(sessionFilePath) ? firstSegment : null
}

function guessRepoRoot(pathValue: string): string | null {
  let current = normalizePath(pathValue)

  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, '.git'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) =>
    left.localeCompare(right),
  )
}
