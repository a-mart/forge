export type CredentialPoolStrategy = 'fill_first' | 'least_used'

export interface PooledCredentialInfo {
  id: string
  label: string
  autoLabel?: string
  isPrimary: boolean
  /** Optional for backward compatibility — missing means enabled. Backend always returns a concrete value. */
  enabled?: boolean
  health: 'healthy' | 'cooldown' | 'auth_error'
  cooldownUntil?: number | null
  requestCount: number
  createdAt: string
}

export interface CredentialPoolState {
  strategy: CredentialPoolStrategy
  credentials: PooledCredentialInfo[]
}
