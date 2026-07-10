/**
 * Durable repository clone settings for Builder project creation.
 *
 * Persistence stores configured home and last-used base distinctly.
 * Effective base precedence: configured home → last-used base → user home.
 */

export type RepositoryBasePathSource = 'configured' | 'last_used' | 'default'

/** Persisted shape under shared/config/repository-settings.json */
export interface PersistedRepositorySettings {
  /** Explicitly configured repository home (Settings). Null means unset. */
  configuredHome: string | null
  /** Last base path that successfully published a clone. */
  lastUsedBasePath: string | null
  updatedAt: string | null
}

/** API view returned to clients. */
export interface RepositorySettings {
  configuredHome: string | null
  lastUsedBasePath: string | null
  /** Resolved default base for the clone dialog. */
  effectiveBasePath: string
  source: RepositoryBasePathSource
  updatedAt: string | null
}

export interface GetRepositorySettingsResponse {
  settings: RepositorySettings
}

export interface UpdateRepositorySettingsRequest {
  /** Set an absolute directory as the configured home, or null to clear it. */
  configuredHome: string | null
}

export interface UpdateRepositorySettingsResponse {
  ok: true
  settings: RepositorySettings
}
