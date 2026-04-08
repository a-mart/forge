export type CredentialPoolStrategy = 'fill_first' | 'least_used'

export interface PooledCredentialInfo {
  id: string
  label: string
  autoLabel?: string
  isPrimary: boolean
  health: 'healthy' | 'cooldown' | 'auth_error'
  cooldownUntil?: number | null
  requestCount: number
  createdAt: string
}

export interface CredentialPoolState {
  strategy: CredentialPoolStrategy
  credentials: PooledCredentialInfo[]
}
