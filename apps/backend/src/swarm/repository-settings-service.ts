import { access, constants as fsConstants, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type {
  PersistedRepositorySettings,
  RepositoryBasePathSource,
  RepositorySettings,
} from '@forge/protocol'
import { getRepositorySettingsPath } from './data-paths.js'
import { isEnoentError } from './swarm-manager-utils.js'
import { readJsonFileIfExists, writeJsonFileAtomic } from '../utils/atomic-files.js'
import {
  DirectoryValidationError,
  type CwdPolicy,
  validateDirectoryPath,
} from './cwd-policy.js'

export class RepositorySettingsValidationError extends Error {
  readonly code: 'invalid_repository_base_path'

  constructor(message: string) {
    super(message)
    this.name = 'RepositorySettingsValidationError'
    this.code = 'invalid_repository_base_path'
  }
}

interface RepositorySettingsServiceOptions {
  dataDir: string
  /** Optional override for tests. */
  homeDir?: string
  /**
   * Optional CWD policy. When provided, validateDirectoryPath is used (accepts
   * safe symlink/junction homes via realpath + containment).
   */
  cwdPolicy?: CwdPolicy
}

const EMPTY_PERSISTED: PersistedRepositorySettings = {
  configuredHome: null,
  lastUsedBasePath: null,
  updatedAt: null,
}

export class RepositorySettingsService {
  private readonly settingsPath: string
  private readonly homeDir: string
  private readonly cwdPolicy: CwdPolicy | undefined
  private persisted: PersistedRepositorySettings = { ...EMPTY_PERSISTED }
  private updateMutex: Promise<void> = Promise.resolve()

  constructor(options: RepositorySettingsServiceOptions) {
    this.settingsPath = getRepositorySettingsPath(options.dataDir)
    this.homeDir = options.homeDir ?? homedir()
    this.cwdPolicy = options.cwdPolicy
  }

  async load(): Promise<void> {
    return this.withUpdateLock(async () => {
      const raw = await readJsonFileIfExists<Partial<PersistedRepositorySettings>>(this.settingsPath)
      this.persisted = normalizePersisted(raw)
    })
  }

  getSettings(): RepositorySettings {
    return buildView(this.persisted, this.homeDir)
  }

  async getSettingsAsync(): Promise<RepositorySettings> {
    return this.withUpdateLock(async () => {
      const raw = await readJsonFileIfExists<Partial<PersistedRepositorySettings>>(this.settingsPath)
      this.persisted = normalizePersisted(raw)
      return buildView(this.persisted, this.homeDir)
    })
  }

  async updateConfiguredHome(configuredHome: string | null): Promise<RepositorySettings> {
    return this.withUpdateLock(async () => {
      const current = normalizePersisted(
        await readJsonFileIfExists<Partial<PersistedRepositorySettings>>(this.settingsPath),
      )

      let nextConfigured: string | null = null
      if (configuredHome !== null) {
        nextConfigured = await this.validateBasePath(configuredHome)
      }

      const next: PersistedRepositorySettings = {
        configuredHome: nextConfigured,
        lastUsedBasePath: current.lastUsedBasePath,
        updatedAt: new Date().toISOString(),
      }
      await writeJsonFileAtomic(this.settingsPath, next)
      this.persisted = next
      return buildView(this.persisted, this.homeDir)
    })
  }

  /**
   * Persist the base path used by a successfully published clone.
   * Does not change configuredHome.
   */
  async recordLastUsedBasePath(basePath: string): Promise<RepositorySettings> {
    return this.withUpdateLock(async () => {
      const current = normalizePersisted(
        await readJsonFileIfExists<Partial<PersistedRepositorySettings>>(this.settingsPath),
      )
      const canonical = await this.validateBasePath(basePath)
      const next: PersistedRepositorySettings = {
        configuredHome: current.configuredHome,
        lastUsedBasePath: canonical,
        updatedAt: new Date().toISOString(),
      }
      await writeJsonFileAtomic(this.settingsPath, next)
      this.persisted = next
      return buildView(this.persisted, this.homeDir)
    })
  }

  async validateBasePath(input: string): Promise<string> {
    const trimmed = input.trim()
    if (!trimmed) {
      throw new RepositorySettingsValidationError('Repository base path is required.')
    }
    if (!isAbsolute(trimmed)) {
      throw new RepositorySettingsValidationError('Repository base path must be an absolute directory.')
    }

    const resolved = resolve(trimmed)

    // Prefer established CWD validation when a policy is available (symlink-safe).
    if (this.cwdPolicy) {
      try {
        const canonical = await validateDirectoryPath(resolved, this.cwdPolicy)
        await assertWritableDirectory(canonical)
        return canonical
      } catch (error) {
        if (error instanceof DirectoryValidationError) {
          throw new RepositorySettingsValidationError(error.message)
        }
        if (error instanceof RepositorySettingsValidationError) {
          throw error
        }
        throw error
      }
    }

    // Default local Builder path: accept directories and symlink/junction homes via realpath.
    let stats
    try {
      stats = await stat(resolved)
    } catch (error) {
      if (isEnoentError(error)) {
        throw new RepositorySettingsValidationError('Repository base path does not exist.')
      }
      throw new RepositorySettingsValidationError('Unable to access repository base path.')
    }

    if (!stats.isDirectory()) {
      throw new RepositorySettingsValidationError('Repository base path must be a directory.')
    }

    let canonical: string
    try {
      canonical = await realpath(resolved)
    } catch {
      canonical = resolved
    }

    await assertWritableDirectory(canonical)
    return canonical
  }

  private async withUpdateLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex
    let release!: () => void
    this.updateMutex = new Promise<void>((resolveMutex) => {
      release = resolveMutex
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

async function assertWritableDirectory(pathValue: string): Promise<void> {
  try {
    await access(pathValue, fsConstants.W_OK | fsConstants.R_OK | fsConstants.X_OK)
  } catch {
    throw new RepositorySettingsValidationError('Repository base path is not writable.')
  }
}

function normalizePersisted(raw: Partial<PersistedRepositorySettings> | undefined): PersistedRepositorySettings {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_PERSISTED }
  }

  return {
    configuredHome: normalizeOptionalPath(raw.configuredHome),
    lastUsedBasePath: normalizeOptionalPath(raw.lastUsedBasePath),
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.trim().length > 0 ? raw.updatedAt : null,
  }
}

function normalizeOptionalPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildView(persisted: PersistedRepositorySettings, homeDir: string): RepositorySettings {
  const configuredHome = persisted.configuredHome
  const lastUsedBasePath = persisted.lastUsedBasePath

  let effectiveBasePath: string
  let source: RepositoryBasePathSource

  if (configuredHome) {
    effectiveBasePath = configuredHome
    source = 'configured'
  } else if (lastUsedBasePath) {
    effectiveBasePath = lastUsedBasePath
    source = 'last_used'
  } else {
    effectiveBasePath = resolve(homeDir)
    source = 'default'
  }

  return {
    configuredHome,
    lastUsedBasePath,
    effectiveBasePath,
    source,
    updatedAt: persisted.updatedAt,
  }
}
