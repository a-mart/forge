import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { getSharedPlaywrightDashboardSettingsPath } from '../swarm/data-paths.js'

const SETTINGS_FILE_VERSION = 1

export const DEFAULT_PLAYWRIGHT_POLL_INTERVAL_MS = 10_000
export const DEFAULT_PLAYWRIGHT_SOCKET_PROBE_TIMEOUT_MS = 750
export const DEFAULT_PLAYWRIGHT_STALE_SESSION_THRESHOLD_MS = 60 * 60 * 1000

const MIN_POLL_INTERVAL_MS = 2_000
const MAX_POLL_INTERVAL_MS = 60_000
const MIN_SOCKET_PROBE_TIMEOUT_MS = 100
const MAX_SOCKET_PROBE_TIMEOUT_MS = 5_000
const MIN_STALE_SESSION_THRESHOLD_MS = 60_000
const MAX_STALE_SESSION_THRESHOLD_MS = 86_400_000

export interface PlaywrightPersistedSettings {
  enabled: boolean
  scanRoots: string[]
  pollIntervalMs: number
  socketProbeTimeoutMs: number
  staleSessionThresholdMs: number
  updatedAt: string | null
}

interface PlaywrightPersistedSettingsFile {
  version: 1
  enabled: boolean
  scanRoots: string[]
  pollIntervalMs: number
  socketProbeTimeoutMs: number
  staleSessionThresholdMs: number
  updatedAt: string
}

export class PlaywrightSettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlaywrightSettingsValidationError'
  }
}

export class PlaywrightSettingsService {
  private readonly settingsPath: string
  private readonly now: () => Date
  private persisted: PlaywrightPersistedSettings = createDefaultPersistedSettings()

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.settingsPath = getSharedPlaywrightDashboardSettingsPath(options.dataDir)
    this.now = options.now ?? (() => new Date())
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      this.persisted = normalizeLoadedSettings(parsed)
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[playwright] Failed to load settings from ${this.settingsPath}: ${message}`)
      }
      this.persisted = createDefaultPersistedSettings()
    }
  }

  getPersisted(): PlaywrightPersistedSettings {
    return {
      enabled: this.persisted.enabled,
      scanRoots: [...this.persisted.scanRoots],
      pollIntervalMs: this.persisted.pollIntervalMs,
      socketProbeTimeoutMs: this.persisted.socketProbeTimeoutMs,
      staleSessionThresholdMs: this.persisted.staleSessionThresholdMs,
      updatedAt: this.persisted.updatedAt,
    }
  }

  async update(patch: {
    enabled?: boolean
    scanRoots?: string[]
    pollIntervalMs?: number
    socketProbeTimeoutMs?: number
    staleSessionThresholdMs?: number
  }): Promise<void> {
    const next: PlaywrightPersistedSettings = {
      enabled:
        patch.enabled === undefined
          ? this.persisted.enabled
          : normalizeBoolean(patch.enabled, 'enabled'),
      scanRoots:
        patch.scanRoots === undefined
          ? [...this.persisted.scanRoots]
          : normalizeScanRoots(patch.scanRoots),
      pollIntervalMs:
        patch.pollIntervalMs === undefined
          ? this.persisted.pollIntervalMs
          : normalizeIntegerInRange(
              patch.pollIntervalMs,
              MIN_POLL_INTERVAL_MS,
              MAX_POLL_INTERVAL_MS,
              'pollIntervalMs',
            ),
      socketProbeTimeoutMs:
        patch.socketProbeTimeoutMs === undefined
          ? this.persisted.socketProbeTimeoutMs
          : normalizeIntegerInRange(
              patch.socketProbeTimeoutMs,
              MIN_SOCKET_PROBE_TIMEOUT_MS,
              MAX_SOCKET_PROBE_TIMEOUT_MS,
              'socketProbeTimeoutMs',
            ),
      staleSessionThresholdMs:
        patch.staleSessionThresholdMs === undefined
          ? this.persisted.staleSessionThresholdMs
          : normalizeIntegerInRange(
              patch.staleSessionThresholdMs,
              MIN_STALE_SESSION_THRESHOLD_MS,
              MAX_STALE_SESSION_THRESHOLD_MS,
              'staleSessionThresholdMs',
            ),
      updatedAt: this.now().toISOString(),
    }

    await writeSettingsFile(this.settingsPath, next)
    this.persisted = next
  }
}

export function createDefaultPersistedSettings(): PlaywrightPersistedSettings {
  return {
    enabled: false,
    scanRoots: [],
    pollIntervalMs: DEFAULT_PLAYWRIGHT_POLL_INTERVAL_MS,
    socketProbeTimeoutMs: DEFAULT_PLAYWRIGHT_SOCKET_PROBE_TIMEOUT_MS,
    staleSessionThresholdMs: DEFAULT_PLAYWRIGHT_STALE_SESSION_THRESHOLD_MS,
    updatedAt: null,
  }
}

function normalizeLoadedSettings(value: unknown): PlaywrightPersistedSettings {
  const defaults = createDefaultPersistedSettings()

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults
  }

  const maybe = value as Partial<PlaywrightPersistedSettingsFile>

  return {
    enabled: typeof maybe.enabled === 'boolean' ? maybe.enabled : defaults.enabled,
    scanRoots: Array.isArray(maybe.scanRoots) ? normalizeScanRootsForLoad(maybe.scanRoots) : defaults.scanRoots,
    pollIntervalMs: normalizeIntegerForLoad(
      maybe.pollIntervalMs,
      defaults.pollIntervalMs,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
    socketProbeTimeoutMs: normalizeIntegerForLoad(
      maybe.socketProbeTimeoutMs,
      defaults.socketProbeTimeoutMs,
      MIN_SOCKET_PROBE_TIMEOUT_MS,
      MAX_SOCKET_PROBE_TIMEOUT_MS,
    ),
    staleSessionThresholdMs: normalizeIntegerForLoad(
      maybe.staleSessionThresholdMs,
      defaults.staleSessionThresholdMs,
      MIN_STALE_SESSION_THRESHOLD_MS,
      MAX_STALE_SESSION_THRESHOLD_MS,
    ),
    updatedAt: normalizeIsoTimestamp(maybe.updatedAt),
  }
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PlaywrightSettingsValidationError(`${fieldName} must be a boolean`)
  }

  return value
}

function normalizeScanRoots(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new PlaywrightSettingsValidationError('scanRoots must be an array of absolute paths')
  }

  const normalized = new Set<string>()

  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new PlaywrightSettingsValidationError('scanRoots must contain only strings')
    }

    const trimmed = entry.trim()
    if (!trimmed) {
      throw new PlaywrightSettingsValidationError('scanRoots entries must be non-empty absolute paths')
    }

    if (!isAbsolute(trimmed)) {
      throw new PlaywrightSettingsValidationError(`scanRoots entry must be an absolute path: ${entry}`)
    }

    normalized.add(resolveToNormalizedPath(trimmed))
  }

  return Array.from(normalized).sort((left, right) => left.localeCompare(right))
}

function normalizeScanRootsForLoad(value: unknown[]): string[] {
  const normalized = new Set<string>()

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }

    const trimmed = entry.trim()
    if (!trimmed || !isAbsolute(trimmed)) {
      continue
    }

    normalized.add(resolveToNormalizedPath(trimmed))
  }

  return Array.from(normalized).sort((left, right) => left.localeCompare(right))
}

function normalizeIntegerInRange(value: unknown, min: number, max: number, fieldName: string): number {
  if (!Number.isInteger(value)) {
    throw new PlaywrightSettingsValidationError(`${fieldName} must be an integer between ${min} and ${max}`)
  }

  const normalized = value as number
  if (normalized < min || normalized > max) {
    throw new PlaywrightSettingsValidationError(`${fieldName} must be between ${min} and ${max}`)
  }

  return normalized
}

function normalizeIntegerForLoad(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) {
    return fallback
  }

  const normalized = value as number
  if (normalized < min || normalized > max) {
    return fallback
  }

  return normalized
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    return null
  }

  return new Date(parsed).toISOString()
}

function resolveToNormalizedPath(pathValue: string): string {
  try {
    return resolve(realpathSync(pathValue))
  } catch {
    return resolve(pathValue)
  }
}

async function writeSettingsFile(targetPath: string, settings: PlaywrightPersistedSettings): Promise<void> {
  const payload: PlaywrightPersistedSettingsFile = {
    version: SETTINGS_FILE_VERSION,
    enabled: settings.enabled,
    scanRoots: [...settings.scanRoots],
    pollIntervalMs: settings.pollIntervalMs,
    socketProbeTimeoutMs: settings.socketProbeTimeoutMs,
    staleSessionThresholdMs: settings.staleSessionThresholdMs,
    updatedAt: settings.updatedAt ?? new Date().toISOString(),
  }
  const tempPath = `${targetPath}.tmp`

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tempPath, targetPath)
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT',
  )
}
