import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  PersistedTelemetryConfig,
  StatsSnapshot,
  TelemetryPayload,
  TelemetrySettingsResponse,
  TelemetrySettingsSource,
} from '@forge/protocol'
import { readTelemetryEnvOverride } from '../config.js'
import { getTelemetryConfigPath } from '../swarm/data-paths.js'
import { sendTelemetryPayload } from './telemetry-sender.js'

const SUCCESS_CAP_MS = 2 * 60 * 60 * 1000
const FAILURE_BACKOFF_MS = 10 * 60 * 1000

interface TelemetryAssembleContext {
  reportId: string
  stats?: StatsSnapshot | null
}

export interface TelemetryServiceOptions {
  dataDir: string
  debug: boolean
  assemblePayload: (installId: string, context: TelemetryAssembleContext) => Promise<TelemetryPayload>
  sendPayload?: (payload: TelemetryPayload) => Promise<boolean>
}

export class TelemetryService {
  private readonly debug: boolean
  private readonly configPath: string
  private readonly assemblePayload: (installId: string, context: TelemetryAssembleContext) => Promise<TelemetryPayload>
  private readonly sendPayload: (payload: TelemetryPayload) => Promise<boolean>

  private configQueue: Promise<void> = Promise.resolve()

  constructor(options: TelemetryServiceOptions) {
    this.debug = options.debug
    this.configPath = getTelemetryConfigPath(options.dataDir)
    this.assemblePayload = options.assemblePayload
    this.sendPayload = options.sendPayload ?? sendTelemetryPayload
  }

  async start(): Promise<void> {
    this.log('start: telemetry scheduling delegated to stats refresh completion')
  }

  stop(): void {
    // no-op: telemetry cadence is driven by backend stats refresh completion
  }

  async readSettings(): Promise<TelemetrySettingsResponse> {
    return this.enqueue(async () => {
      const persisted = await this.readConfigFromFile()
      return this.buildSettingsResponse(persisted)
    })
  }

  async updateConfig(patch: { enabled?: boolean }): Promise<TelemetrySettingsResponse> {
    return this.enqueue(async () => {
      const persisted = await this.readConfigFromFile()
      if (patch.enabled !== undefined) {
        persisted.enabled = patch.enabled
      }
      await this.writeConfigFile(persisted)
      return this.buildSettingsResponse(persisted)
    })
  }

  async forceSend(): Promise<boolean> {
    return this.attemptSend('forceSend')
  }

  async sendOnStatsRefresh(stats: StatsSnapshot | null): Promise<boolean> {
    if (!stats) {
      this.log('sendOnStatsRefresh: skipped (no all-range stats snapshot available)')
      return false
    }

    return this.attemptSend('sendOnStatsRefresh', { stats })
  }

  async sendIfDue(): Promise<void> {
    try {
      await this.attemptSend('sendIfDue')
    } catch {
      // Telemetry failures are always silent.
    }
  }

  private async attemptSend(
    source: 'forceSend' | 'sendOnStatsRefresh' | 'sendIfDue',
    options: { stats?: StatsSnapshot | null } = {},
  ): Promise<boolean> {
    if (readTelemetryEnvOverride() === false) {
      this.log(`${source}: skipped (disabled by env override)`)
      return false
    }

    try {
      return await this.enqueue(async () => {
        const persisted = await this.readConfigFromFile()
        if (!this.isEffectivelyEnabled(persisted)) {
          this.log(`${source}: skipped (disabled)`)
          return false
        }

        const throttle = getThrottleState(persisted)
        if (throttle.kind !== 'allowed') {
          this.log(`${source}: skipped (${formatThrottleLogMessage(throttle)})`)
          return false
        }

        return this.doSend(persisted, {
          reportId: randomUUID(),
          stats: options.stats ?? null,
        })
      })
    } catch {
      return false
    }
  }

  private async doSend(
    persisted: PersistedTelemetryConfig,
    context: TelemetryAssembleContext,
  ): Promise<boolean> {
    try {
      const payload = await this.assemblePayload(persisted.installId, context)
      this.log(`doSend: sending (schemaVersion=${payload.schema_version}, reportId=${payload.report_id})`)

      const ok = await this.sendPayload(payload)
      if (ok) {
        persisted.lastSuccessfulSendAt = new Date().toISOString()
        persisted.lastFailedAttemptAt = null
        await this.writeConfigFile(persisted)
        this.log('doSend: success')
      } else {
        persisted.lastFailedAttemptAt = new Date().toISOString()
        await this.writeConfigFile(persisted)
        this.log('doSend: failed (server rejected)')
      }
      return ok
    } catch {
      persisted.lastFailedAttemptAt = new Date().toISOString()
      await this.writeConfigFile(persisted)
      this.log('doSend: failed (exception)')
      return false
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.configQueue.then(fn, fn)
    this.configQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private isEffectivelyEnabled(persisted: PersistedTelemetryConfig): boolean {
    const envOverride = readTelemetryEnvOverride()
    if (envOverride === false) {
      return false
    }
    if (envOverride === true) {
      return true
    }
    return persisted.enabled
  }

  private buildSettingsResponse(
    persisted: PersistedTelemetryConfig,
  ): TelemetrySettingsResponse {
    const envOverride = readTelemetryEnvOverride() ?? null
    const source: TelemetrySettingsSource = envOverride !== null ? 'env' : 'settings'
    const effectiveEnabled = envOverride ?? persisted.enabled

    return {
      enabled: persisted.enabled,
      effectiveEnabled,
      source,
      envOverride,
      installId: persisted.installId,
      lastSentAt: persisted.lastSuccessfulSendAt,
    }
  }

  private async readConfigFromFile(): Promise<PersistedTelemetryConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedTelemetryConfig> & {
        lastSentAt?: unknown
        lastAttemptedAt?: unknown
      }
      const lastSuccessfulSendAt = normalizeTimestamp(parsed.lastSuccessfulSendAt ?? parsed.lastSentAt)
      const legacyAttemptAt = normalizeTimestamp(parsed.lastAttemptedAt)
      const normalized: PersistedTelemetryConfig = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
        installId:
          typeof parsed.installId === 'string' && parsed.installId.trim().length > 0
            ? parsed.installId
            : randomUUID(),
        lastSuccessfulSendAt,
        lastFailedAttemptAt:
          normalizeTimestamp(parsed.lastFailedAttemptAt) ??
          inferLegacyFailedAttemptTimestamp(legacyAttemptAt, lastSuccessfulSendAt),
      }

      if (
        parsed.enabled !== normalized.enabled ||
        parsed.installId !== normalized.installId ||
        parsed.lastSuccessfulSendAt !== normalized.lastSuccessfulSendAt ||
        parsed.lastFailedAttemptAt !== normalized.lastFailedAttemptAt ||
        parsed.lastSentAt !== undefined ||
        parsed.lastAttemptedAt !== undefined
      ) {
        await this.writeConfigFile(normalized)
      }

      return normalized
    } catch {
      const config: PersistedTelemetryConfig = {
        enabled: true,
        installId: randomUUID(),
        lastSuccessfulSendAt: null,
        lastFailedAttemptAt: null,
      }
      await this.writeConfigFile(config)
      return config
    }
  }

  private async writeConfigFile(config: PersistedTelemetryConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })
    await writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8')
  }

  private log(message: string): void {
    if (this.debug) {
      console.log(`[telemetry] ${message}`)
    }
  }
}

type ThrottleState =
  | { kind: 'allowed' }
  | { kind: 'success-cap'; remainingMs: number }
  | { kind: 'failure-backoff'; remainingMs: number }

function getThrottleState(config: PersistedTelemetryConfig, nowMs = Date.now()): ThrottleState {
  const failureAgeMs = getAgeMs(config.lastFailedAttemptAt, nowMs)
  if (failureAgeMs !== null && failureAgeMs < FAILURE_BACKOFF_MS) {
    return {
      kind: 'failure-backoff',
      remainingMs: FAILURE_BACKOFF_MS - failureAgeMs,
    }
  }

  const successAgeMs = getAgeMs(config.lastSuccessfulSendAt, nowMs)
  if (successAgeMs !== null && successAgeMs < SUCCESS_CAP_MS) {
    return {
      kind: 'success-cap',
      remainingMs: SUCCESS_CAP_MS - successAgeMs,
    }
  }

  return { kind: 'allowed' }
}

function getAgeMs(value: string | null, nowMs: number): number | null {
  if (!value) {
    return null
  }

  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  return Math.max(0, nowMs - parsed)
}

function formatThrottleLogMessage(state: Exclude<ThrottleState, { kind: 'allowed' }>): string {
  if (state.kind === 'failure-backoff') {
    return `failure backoff active for ${Math.ceil(state.remainingMs / 60000)}m`
  }

  return `2h cap active for ${Math.ceil(state.remainingMs / 60000)}m`
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }

  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null
}

function inferLegacyFailedAttemptTimestamp(
  legacyAttemptAt: string | null,
  lastSuccessfulSendAt: string | null,
): string | null {
  if (!legacyAttemptAt) {
    return null
  }

  if (!lastSuccessfulSendAt) {
    return legacyAttemptAt
  }

  const attemptMs = Date.parse(legacyAttemptAt)
  const successMs = Date.parse(lastSuccessfulSendAt)
  if (!Number.isFinite(attemptMs) || !Number.isFinite(successMs)) {
    return null
  }

  return attemptMs > successMs + 1_000 ? legacyAttemptAt : null
}
