import type {
  CortexAutoReviewSettings,
  UpdateCortexAutoReviewSettingsRequest,
} from '@forge/protocol'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import {
  getCortexAutoReviewSettingsPath,
  getProfileScheduleFilePath,
} from './data-paths.js'
import { renameWithRetry } from './retry-rename.js'

const SETTINGS_FILE_VERSION = 1
const CORTEX_PROFILE_ID = 'cortex'
const CORTEX_AUTO_REVIEW_SCHEDULE_NAME = 'Cortex Auto-Review'
const CORTEX_AUTO_REVIEW_SCHEDULE_MESSAGE = 'Review all sessions that need attention'
const CORTEX_AUTO_REVIEW_SCHEDULE_TIMEZONE = 'UTC'

export const CORTEX_AUTO_REVIEW_SCHEDULE_ID = 'cortex-auto-review'
export const DEFAULT_CORTEX_AUTO_REVIEW_ENABLED = true
export const DEFAULT_CORTEX_AUTO_REVIEW_INTERVAL_MINUTES = 120
export const SUPPORTED_INTERVAL_MINUTES = [15, 30, 60, 120, 240, 480, 720, 1440] as const

interface CortexAutoReviewSettingsFile {
  version: 1
  enabled: boolean
  intervalMinutes: number
  updatedAt: string | null
}

interface ScheduleFileEnvelope {
  rawRoot: Record<string, unknown>
  schedules: unknown[]
}

interface ManagedScheduleEntry {
  raw?: Record<string, unknown>
  createdAt: string | null
  lastFiredAt: string | null
}

export class CortexAutoReviewSettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CortexAutoReviewSettingsValidationError'
  }
}

export class CortexAutoReviewSettingsService {
  private readonly dataDir: string
  private readonly settingsPath: string
  private readonly now: () => Date
  private settings: CortexAutoReviewSettings = createDefaultCortexAutoReviewSettings()
  private updateMutex: Promise<void> = Promise.resolve()

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.dataDir = options.dataDir
    this.settingsPath = getCortexAutoReviewSettingsPath(options.dataDir)
    this.now = options.now ?? (() => new Date())
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      this.settings = normalizeLoadedSettings(parsed)
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[cortex-auto-review] Failed to load settings from ${this.settingsPath}: ${message}`)
      }
      this.settings = createDefaultCortexAutoReviewSettings()
    }

    try {
      await syncCortexAutoReviewSchedule({
        dataDir: this.dataDir,
        settings: this.settings,
        now: this.now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `[cortex-auto-review] Failed to sync schedule during load from ${this.dataDir}: ${message}`,
      )
    }
  }

  getSettings(): CortexAutoReviewSettings {
    return {
      enabled: this.settings.enabled,
      intervalMinutes: this.settings.intervalMinutes,
      updatedAt: this.settings.updatedAt,
    }
  }

  async update(patch: UpdateCortexAutoReviewSettingsRequest): Promise<CortexAutoReviewSettings> {
    return this.withUpdateLock(async () => {
      const next: CortexAutoReviewSettings = {
        enabled:
          patch.enabled === undefined
            ? this.settings.enabled
            : normalizeBoolean(patch.enabled, 'enabled'),
        intervalMinutes:
          patch.intervalMinutes === undefined
            ? this.settings.intervalMinutes
            : normalizeIntervalMinutes(patch.intervalMinutes),
        updatedAt: this.now().toISOString(),
      }

      await syncCortexAutoReviewSchedule({
        dataDir: this.dataDir,
        settings: next,
        now: this.now,
      })

      await writeSettingsFile(this.settingsPath, next)
      this.settings = next

      return this.getSettings()
    })
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex
    let release: (() => void) | undefined
    this.updateMutex = new Promise<void>((resolve) => {
      release = resolve
    })

    await previous

    try {
      return await operation()
    } finally {
      release?.()
    }
  }
}

export async function syncCortexAutoReviewSchedule(options: {
  dataDir: string
  settings: CortexAutoReviewSettings
  now?: () => Date
}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const schedulesPath = getProfileScheduleFilePath(options.dataDir, CORTEX_PROFILE_ID)
  const envelope = await readScheduleFile(schedulesPath)
  const nextSchedules: unknown[] = []
  let changed = false
  let foundManagedEntry = false

  const cron = options.settings.enabled
    ? cronExpressionForIntervalMinutes(options.settings.intervalMinutes)
    : null

  for (const entry of envelope.schedules) {
    if (getScheduleId(entry) !== CORTEX_AUTO_REVIEW_SCHEDULE_ID) {
      nextSchedules.push(entry)
      continue
    }

    changed = true

    if (!options.settings.enabled) {
      continue
    }

    if (!foundManagedEntry) {
      foundManagedEntry = true

      if (getScheduleCron(entry) === cron) {
        nextSchedules.push(entry)
        changed = false
        continue
      }

      const existing = getManagedScheduleEntry(entry)
      nextSchedules.push(
        buildManagedScheduleEntry({
          cron: cron!,
          now: now(),
          existing,
        }),
      )
    }
  }

  if (options.settings.enabled && !foundManagedEntry) {
    nextSchedules.push(
      buildManagedScheduleEntry({
        cron: cronExpressionForIntervalMinutes(options.settings.intervalMinutes),
        now: now(),
      }),
    )
    changed = true
  }

  if (!changed) {
    return
  }

  await writeScheduleFile(schedulesPath, envelope.rawRoot, nextSchedules)
}

export function createDefaultCortexAutoReviewSettings(): CortexAutoReviewSettings {
  return {
    enabled: DEFAULT_CORTEX_AUTO_REVIEW_ENABLED,
    intervalMinutes: DEFAULT_CORTEX_AUTO_REVIEW_INTERVAL_MINUTES,
    updatedAt: null,
  }
}

export function cronExpressionForIntervalMinutes(intervalMinutes: number): string {
  const normalized = normalizeIntervalMinutes(intervalMinutes)

  if (normalized === 1440) {
    return '0 0 * * *'
  }

  if (normalized < 60) {
    return `*/${normalized} * * * *`
  }

  const hours = Math.max(1, Math.round(normalized / 60))
  if (hours >= 24) {
    return '0 0 * * *'
  }

  return `0 */${hours} * * *`
}

function normalizeLoadedSettings(value: unknown): CortexAutoReviewSettings {
  const defaults = createDefaultCortexAutoReviewSettings()

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaults
  }

  const maybe = value as Partial<CortexAutoReviewSettingsFile>

  return {
    enabled: typeof maybe.enabled === 'boolean' ? maybe.enabled : defaults.enabled,
    intervalMinutes: normalizeIntervalForLoad(maybe.intervalMinutes, defaults.intervalMinutes),
    updatedAt: normalizeIsoTimestamp(maybe.updatedAt),
  }
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new CortexAutoReviewSettingsValidationError(`${fieldName} must be a boolean`)
  }

  return value
}

function normalizeIntervalMinutes(value: unknown): number {
  if (!Number.isInteger(value)) {
    throw new CortexAutoReviewSettingsValidationError(
      `intervalMinutes must be one of: ${SUPPORTED_INTERVAL_MINUTES.join(', ')}`,
    )
  }

  const normalized = value as number
  if (!SUPPORTED_INTERVAL_MINUTES.includes(normalized as (typeof SUPPORTED_INTERVAL_MINUTES)[number])) {
    throw new CortexAutoReviewSettingsValidationError(
      `intervalMinutes must be one of: ${SUPPORTED_INTERVAL_MINUTES.join(', ')}`,
    )
  }

  return normalized
}

function normalizeIntervalForLoad(value: unknown, fallback: number): number {
  if (!Number.isInteger(value)) {
    return fallback
  }

  const normalized = value as number
  if (!SUPPORTED_INTERVAL_MINUTES.includes(normalized as (typeof SUPPORTED_INTERVAL_MINUTES)[number])) {
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

async function writeSettingsFile(targetPath: string, settings: CortexAutoReviewSettings): Promise<void> {
  const payload: CortexAutoReviewSettingsFile = {
    version: SETTINGS_FILE_VERSION,
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    updatedAt: settings.updatedAt,
  }
  const tempPath = `${targetPath}.tmp`

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await renameWithRetry(tempPath, targetPath, { retries: 8, baseDelayMs: 15 })
}

async function readScheduleFile(targetPath: string): Promise<ScheduleFileEnvelope> {
  try {
    const raw = await readFile(targetPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid schedules file at ${targetPath}: expected an object root`)
    }

    const rawRoot = { ...(parsed as Record<string, unknown>) }
    const schedulesValue = rawRoot.schedules
    if (schedulesValue === undefined) {
      return { rawRoot, schedules: [] }
    }

    if (!Array.isArray(schedulesValue)) {
      throw new Error(`Invalid schedules file at ${targetPath}: expected schedules to be an array`)
    }

    return {
      rawRoot,
      schedules: [...schedulesValue],
    }
  } catch (error) {
    if (isEnoentError(error)) {
      return {
        rawRoot: {},
        schedules: [],
      }
    }

    throw error
  }
}

async function writeScheduleFile(
  targetPath: string,
  rawRoot: Record<string, unknown>,
  schedules: unknown[],
): Promise<void> {
  const payload: Record<string, unknown> = {
    ...rawRoot,
    schedules,
  }
  const tempPath = `${targetPath}.tmp`

  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await renameWithRetry(tempPath, targetPath, { retries: 8, baseDelayMs: 15 })
}

function getScheduleId(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined
  }

  return normalizeNonEmptyString((entry as { id?: unknown }).id)
}

function getScheduleCron(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined
  }

  return normalizeNonEmptyString((entry as { cron?: unknown }).cron)
}

function getManagedScheduleEntry(entry: unknown): ManagedScheduleEntry | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined
  }

  const raw = entry as Record<string, unknown>
  return {
    raw,
    createdAt: normalizeIsoTimestamp(raw.createdAt),
    lastFiredAt: normalizeIsoTimestamp(raw.lastFiredAt),
  }
}

function buildManagedScheduleEntry(options: {
  cron: string
  now: Date
  existing?: ManagedScheduleEntry
}): Record<string, unknown> {
  const nowIso = options.now.toISOString()
  const entry: Record<string, unknown> = {
    ...(options.existing?.raw ?? {}),
    id: CORTEX_AUTO_REVIEW_SCHEDULE_ID,
    name: CORTEX_AUTO_REVIEW_SCHEDULE_NAME,
    cron: options.cron,
    message: CORTEX_AUTO_REVIEW_SCHEDULE_MESSAGE,
    oneShot: false,
    timezone: CORTEX_AUTO_REVIEW_SCHEDULE_TIMEZONE,
    createdAt: options.existing?.createdAt ?? nowIso,
    nextFireAt: computeNextFireAt(options.cron, CORTEX_AUTO_REVIEW_SCHEDULE_TIMEZONE, options.now),
  }

  if (options.existing?.lastFiredAt) {
    entry.lastFiredAt = options.existing.lastFiredAt
  } else {
    delete entry.lastFiredAt
  }

  return entry
}

function computeNextFireAt(cron: string, timezone: string, afterDate: Date): string {
  const iterator = CronExpressionParser.parse(cron, {
    currentDate: afterDate,
    tz: timezone,
  })
  return iterator.next().toDate().toISOString()
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT',
  )
}
