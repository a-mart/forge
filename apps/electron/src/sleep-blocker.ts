import { net, powerSaveBlocker } from 'electron'
import { readSettings, writeSettings } from './electron-settings.js'

const DEFAULT_GRACE_PERIOD_MINUTES = 30
const HEALTH_POLL_INTERVAL_MS = 5_000
const HEALTH_REQUEST_TIMEOUT_MS = 5_000
const MAX_CONSECUTIVE_FAILURES = 3

const EMPTY_ACTIVITY = {
  activeSessions: 0,
  activeWorkers: 0,
  hasActivity: false,
}

type BackendHealthResponse = {
  ok?: boolean
  swarm?: {
    activeSessions?: number
    activeWorkers?: number
    hasActiveSessions?: boolean
    hasActiveWorkers?: boolean
  }
}

type ActivitySnapshot = {
  activeSessions: number
  activeWorkers: number
  hasActivity: boolean
}

export type SleepBlockerSettingsPatch = {
  enabled?: boolean
  gracePeriodMinutes?: number
}

export interface SleepBlockerStatus {
  enabled: boolean
  gracePeriodMinutes: number
  blocking: boolean
  graceRemainingMs: number | null
  reason: string
}

export class SleepBlockerService {
  private enabled = false
  private gracePeriodMinutes = DEFAULT_GRACE_PERIOD_MINUTES
  private blockerId: number | null = null
  private graceTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private graceStartedAt: number | null = null
  private consecutiveFailures = 0
  private lastActivity: ActivitySnapshot = { ...EMPTY_ACTIVITY }
  private pollInFlight = false
  private disposed = false
  private lastEmittedStatusJson: string | null = null

  private readonly getBackendBaseUrl: () => string | null
  private readonly onStatusChange: (status: SleepBlockerStatus) => void

  constructor(options: {
    getBackendBaseUrl: () => string | null
    onStatusChange: (status: SleepBlockerStatus) => void
  }) {
    this.getBackendBaseUrl = options.getBackendBaseUrl
    this.onStatusChange = options.onStatusChange
  }

  initialize(): void {
    const settings = readSettings()
    this.enabled = settings.sleepBlockerEnabled === true
    this.gracePeriodMinutes = normalizeGracePeriodMinutes(
      settings.sleepBlockerGracePeriodMinutes,
      DEFAULT_GRACE_PERIOD_MINUTES,
    )

    if (this.enabled) {
      this.startPolling()
      this.emitStatusIfChanged()
      void this.pollHealth()
      return
    }

    this.emitStatusIfChanged()
  }

  updateSettings(patch: SleepBlockerSettingsPatch): SleepBlockerStatus {
    if (typeof patch.enabled === 'boolean') {
      this.enabled = patch.enabled
    }

    if (patch.gracePeriodMinutes !== undefined) {
      this.gracePeriodMinutes = normalizeGracePeriodMinutes(
        patch.gracePeriodMinutes,
        this.gracePeriodMinutes,
      )
    }

    const settings = readSettings()
    settings.sleepBlockerEnabled = this.enabled
    settings.sleepBlockerGracePeriodMinutes = this.gracePeriodMinutes
    writeSettings(settings)

    if (!this.enabled) {
      this.consecutiveFailures = 0
      this.lastActivity = { ...EMPTY_ACTIVITY }
      this.stopPolling()
      this.clearGraceTimer()
      this.stopBlocker()
      this.emitStatusIfChanged()
      return this.getStatus()
    }

    this.startPolling()
    this.refreshGraceTimerAfterSettingsChange()
    this.emitStatusIfChanged()
    void this.pollHealth()
    return this.getStatus()
  }

  getStatus(): SleepBlockerStatus {
    const blocking = this.isBlocking()
    const graceRemainingMs = this.getGraceRemainingMs()

    return {
      enabled: this.enabled,
      gracePeriodMinutes: this.gracePeriodMinutes,
      blocking,
      graceRemainingMs,
      reason: this.describeReason(blocking, graceRemainingMs),
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.clearGraceTimer()
    this.stopBlocker()
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return
    }

    this.pollTimer = setInterval(() => {
      void this.pollHealth()
    }, HEALTH_POLL_INTERVAL_MS)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (!this.pollTimer) {
      return
    }

    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  private async pollHealth(): Promise<void> {
    if (!this.enabled || this.disposed || this.pollInFlight) {
      return
    }

    const backendBaseUrl = this.getBackendBaseUrl()
    if (!backendBaseUrl) {
      this.handlePollFailure(new Error('Backend base URL is not available yet'))
      return
    }

    this.pollInFlight = true

    try {
      const response = await net.fetch(new URL('/api/health', backendBaseUrl).toString(), {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`Health check returned HTTP ${response.status}`)
      }

      const payload = (await response.json()) as BackendHealthResponse

      if (!this.enabled || this.disposed) {
        return
      }

      this.handlePollSuccess(summarizeActivity(payload))
    } catch (error) {
      if (!this.enabled || this.disposed) {
        return
      }

      this.handlePollFailure(error)
    } finally {
      this.pollInFlight = false
    }
  }

  private handlePollSuccess(activity: ActivitySnapshot): void {
    this.consecutiveFailures = 0
    this.lastActivity = activity

    if (activity.hasActivity) {
      this.clearGraceTimer()
      this.startBlocker()
      this.emitStatusIfChanged()
      return
    }

    if (this.isBlocking() && this.graceStartedAt === null) {
      this.startGraceTimer()
      this.emitStatusIfChanged()
      return
    }

    this.emitStatusIfChanged()
  }

  private handlePollFailure(error: unknown): void {
    this.consecutiveFailures += 1
    this.lastActivity = { ...EMPTY_ACTIVITY }
    console.warn(
      `[sleep-blocker] Health check failed (${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
      formatError(error),
    )

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.clearGraceTimer()
      this.stopBlocker()
      this.emitStatusIfChanged()
      return
    }

    if (this.isBlocking() && this.graceStartedAt === null) {
      this.startGraceTimer()
    }

    this.emitStatusIfChanged()
  }

  private startBlocker(): void {
    if (this.isBlocking()) {
      return
    }

    this.blockerId = powerSaveBlocker.start('prevent-app-suspension')
  }

  private stopBlocker(): void {
    if (this.blockerId === null) {
      return
    }

    const blockerId = this.blockerId
    this.blockerId = null

    if (powerSaveBlocker.isStarted(blockerId)) {
      powerSaveBlocker.stop(blockerId)
    }
  }

  private isBlocking(): boolean {
    return this.blockerId !== null && powerSaveBlocker.isStarted(this.blockerId)
  }

  private startGraceTimer(): void {
    if (!this.isBlocking()) {
      return
    }

    const gracePeriodMs = this.gracePeriodMinutes * 60_000
    if (gracePeriodMs <= 0) {
      this.clearGraceTimer()
      this.stopBlocker()
      return
    }

    this.graceStartedAt = Date.now()
    this.scheduleGraceTimer(gracePeriodMs)
  }

  private scheduleGraceTimer(delayMs: number): void {
    this.clearGraceTimerHandleOnly()

    this.graceTimer = setTimeout(() => {
      this.clearGraceTimer()
      this.stopBlocker()
      this.emitStatusIfChanged()
    }, Math.max(0, delayMs))
    this.graceTimer.unref?.()
  }

  private refreshGraceTimerAfterSettingsChange(): void {
    if (this.graceStartedAt === null) {
      return
    }

    const remainingMs = this.getGraceRemainingMs()
    if (remainingMs === null) {
      return
    }

    if (remainingMs <= 0 || this.gracePeriodMinutes <= 0) {
      this.clearGraceTimer()
      this.stopBlocker()
      return
    }

    this.scheduleGraceTimer(remainingMs)
  }

  private getGraceRemainingMs(): number | null {
    if (this.graceStartedAt === null) {
      return null
    }

    const remainingMs = this.gracePeriodMinutes * 60_000 - (Date.now() - this.graceStartedAt)
    return Math.max(0, remainingMs)
  }

  private clearGraceTimer(): void {
    this.clearGraceTimerHandleOnly()
    this.graceStartedAt = null
  }

  private clearGraceTimerHandleOnly(): void {
    if (!this.graceTimer) {
      return
    }

    clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private describeReason(blocking: boolean, graceRemainingMs: number | null): string {
    if (!this.enabled) {
      return 'Sleep prevention is disabled.'
    }

    if (blocking && graceRemainingMs !== null) {
      return `No active agents detected. Keeping the system awake for ${formatDuration(graceRemainingMs)} more.`
    }

    if (blocking && this.lastActivity.hasActivity) {
      return `${describeActivity(this.lastActivity)} active. Preventing system sleep.`
    }

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return `Backend health checks failed ${MAX_CONSECUTIVE_FAILURES} times in a row. Sleep prevention was released.`
    }

    return 'Sleep prevention is enabled and waiting for agent activity.'
  }

  private emitStatusIfChanged(): void {
    const status = this.getStatus()
    const nextJson = JSON.stringify(status)

    if (nextJson === this.lastEmittedStatusJson) {
      return
    }

    this.lastEmittedStatusJson = nextJson
    this.onStatusChange(status)
  }
}

function summarizeActivity(payload: BackendHealthResponse): ActivitySnapshot {
  const activeSessions = normalizeCount(payload.swarm?.activeSessions)
  const activeWorkers = normalizeCount(payload.swarm?.activeWorkers)
  const hasActivity =
    payload.swarm?.hasActiveSessions === true ||
    payload.swarm?.hasActiveWorkers === true ||
    activeSessions > 0 ||
    activeWorkers > 0

  return {
    activeSessions,
    activeWorkers,
    hasActivity,
  }
}

function normalizeGracePeriodMinutes(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }

  return Math.max(0, Math.round(value))
}

function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.round(value))
}

function describeActivity(activity: ActivitySnapshot): string {
  const parts: string[] = []

  if (activity.activeSessions > 0) {
    parts.push(`${activity.activeSessions} session${activity.activeSessions === 1 ? '' : 's'}`)
  }

  if (activity.activeWorkers > 0) {
    parts.push(`${activity.activeWorkers} worker${activity.activeWorkers === 1 ? '' : 's'}`)
  }

  if (parts.length === 0) {
    return 'Agents'
  }

  return parts.join(', ')
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1_000))

  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const totalMinutes = Math.ceil(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) {
    return `${hours}h`
  }

  return `${hours}h ${minutes}m`
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
