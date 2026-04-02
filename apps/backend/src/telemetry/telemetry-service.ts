import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  PersistedTelemetryConfig,
  TelemetryPayload,
  TelemetrySettingsResponse,
  TelemetrySettingsSource,
} from '@forge/protocol'
import { readTelemetryEnvOverride } from '../config.js'
import { getTelemetryConfigPath } from '../swarm/data-paths.js'
import { sendTelemetryPayload } from './telemetry-sender.js'

const SEND_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const FIRST_SEND_DELAY_MS = 15 * 60 * 1000

export interface TelemetryServiceOptions {
  dataDir: string
  debug: boolean
  assemblePayload: (installId: string) => Promise<TelemetryPayload>
  sendPayload?: (payload: TelemetryPayload) => Promise<boolean>
}

export class TelemetryService {
  private readonly debug: boolean
  private readonly configPath: string
  private readonly assemblePayload: (installId: string) => Promise<TelemetryPayload>
  private readonly sendPayload: (payload: TelemetryPayload) => Promise<boolean>

  private checkInterval: NodeJS.Timeout | null = null
  private firstSendTimeout: NodeJS.Timeout | null = null
  private configQueue: Promise<void> = Promise.resolve()

  constructor(options: TelemetryServiceOptions) {
    this.debug = options.debug
    this.configPath = getTelemetryConfigPath(options.dataDir)
    this.assemblePayload = options.assemblePayload
    this.sendPayload = options.sendPayload ?? sendTelemetryPayload
  }

  async start(): Promise<void> {
    if (this.checkInterval || this.firstSendTimeout) {
      return
    }

    this.log(`start: first send in ${FIRST_SEND_DELAY_MS / 1000}s`)

    this.firstSendTimeout = setTimeout(() => {
      this.firstSendTimeout = null
      void this.sendIfDue()
    }, FIRST_SEND_DELAY_MS)
    this.firstSendTimeout.unref?.()

    this.checkInterval = setInterval(() => {
      void this.sendIfDue()
    }, CHECK_INTERVAL_MS)
    this.checkInterval.unref?.()
  }

  stop(): void {
    if (this.firstSendTimeout) {
      clearTimeout(this.firstSendTimeout)
      this.firstSendTimeout = null
    }

    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
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

  async resetInstallId(): Promise<TelemetrySettingsResponse> {
    return this.enqueue(async () => {
      const persisted = await this.readConfigFromFile()
      persisted.installId = randomUUID()
      persisted.lastSentAt = null
      await this.writeConfigFile(persisted)
      return this.buildSettingsResponse(persisted)
    })
  }

  async forceSend(): Promise<boolean> {
    if (readTelemetryEnvOverride() === false) {
      this.log('forceSend: skipped (disabled by env override)')
      return false
    }

    return this.enqueue(async () => {
      const persisted = await this.readConfigFromFile()
      if (!this.isEffectivelyEnabled(persisted)) {
        this.log('forceSend: skipped (disabled)')
        return false
      }
      return this.doSend(persisted)
    })
  }

  async sendIfDue(): Promise<void> {
    if (readTelemetryEnvOverride() === false) {
      this.log('sendIfDue: skipped (disabled by env override)')
      return
    }

    try {
      await this.enqueue(async () => {
        const persisted = await this.readConfigFromFile()
        if (!this.isEffectivelyEnabled(persisted)) {
          this.log('sendIfDue: skipped (disabled)')
          return
        }

        if (persisted.lastSentAt) {
          const elapsed = Date.now() - Date.parse(persisted.lastSentAt)
          if (Number.isFinite(elapsed) && elapsed < SEND_INTERVAL_MS) {
            this.log(
              `sendIfDue: skipped (not due, next in ${Math.round((SEND_INTERVAL_MS - elapsed) / 3600000)}h)`,
            )
            return
          }
        }

        await this.doSend(persisted)
      })
    } catch {
      // Telemetry failures are always silent.
    }
  }

  private async doSend(persisted: PersistedTelemetryConfig): Promise<boolean> {
    try {
      const payload = await this.assemblePayload(persisted.installId)
      this.log(`doSend: sending (schemaVersion=${payload.schema_version})`)

      const ok = await this.sendPayload(payload)
      if (ok) {
        persisted.lastSentAt = new Date().toISOString()
        await this.writeConfigFile(persisted)
        this.log('doSend: success')
      } else {
        this.log('doSend: failed (server rejected)')
      }
      return ok
    } catch {
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
      lastSentAt: persisted.lastSentAt,
    }
  }

  private async readConfigFromFile(): Promise<PersistedTelemetryConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PersistedTelemetryConfig>
      const normalized: PersistedTelemetryConfig = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
        installId:
          typeof parsed.installId === 'string' && parsed.installId.trim().length > 0
            ? parsed.installId
            : randomUUID(),
        lastSentAt: typeof parsed.lastSentAt === 'string' ? parsed.lastSentAt : null,
      }

      if (
        parsed.enabled !== normalized.enabled ||
        parsed.installId !== normalized.installId ||
        parsed.lastSentAt !== normalized.lastSentAt
      ) {
        await this.writeConfigFile(normalized)
      }

      return normalized
    } catch {
      const config: PersistedTelemetryConfig = {
        enabled: true,
        installId: randomUUID(),
        lastSentAt: null,
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
