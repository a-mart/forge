export type SecureSessionAvailabilityState =
  | 'available'
  | 'unsupported_runtime'
  | 'remote_origin'
  | 'source_unavailable'

export interface SecureSessionAvailability {
  state: SecureSessionAvailabilityState
  reason?: string
}

export type SecureSecretBindingView =
  | { kind: 'env'; variable: string }
  | { kind: 'stdin' }
  | { kind: 'file'; targetPath: string; fileMode?: number }
  | { kind: 'askpass'; variable?: string }
  | { kind: 'ssh_agent' }

export type SecureLeasePolicyView =
  | { kind: 'one_use' }
  | { kind: 'task' }
  | { kind: 'timed'; durationSeconds: number }

export interface SecureSecretOption {
  secretId: string
  displayAlias: string
  displayName?: string
  available: boolean
  bindings: SecureSecretBindingView[]
}

export interface SecureLeaseView {
  leaseId: string
  secretId: string
  displayAlias: string
  policy: SecureLeasePolicyView
  status: 'active' | 'consumed' | 'revoked' | 'expired'
  bindings: SecureSecretBindingView[]
  expiresAt?: string
  lastUsedAt?: string
  remainingUses?: number
}

export interface SecureAccessRequestView {
  requestId: string
  requestedByAgentId: string
  requestedByLabel?: string
  secretId?: string
  secretAlias?: string
  purpose: string
  requestedBindings: SecureSecretBindingView[]
  requestedPolicy: SecureLeasePolicyView
  status: 'pending' | 'granted' | 'denied' | 'cancelled' | 'expired'
}

export interface SecureSessionSnapshotView {
  sessionAgentId: string
  revision: number
  executionMode: 'standard' | 'secure'
  environmentStatus: 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed'
  outputState?: 'clear' | 'quarantined'
  outputStateCode?: 'SECURE_OUTPUT_QUARANTINED'
  leases: SecureLeaseView[]
  pendingRequests: SecureAccessRequestView[]
  updatedAt: string
}

export interface SecureGrantInput {
  requestId?: string
  secretId: string
  bindings: SecureSecretBindingView[]
  policy: SecureLeasePolicyView
}

export interface SecureRevokeOptions {
  stopProcesses?: boolean
}

export interface SecureSessionPickerConfig {
  /** Origin identity closes open controls when equal agent ids are viewed on another origin. */
  originId?: string
  availability: SecureSessionAvailability
  snapshot?: SecureSessionSnapshotView | null
  secrets: SecureSecretOption[]
  disabled?: boolean
  outputState?: 'clear' | 'quarantined'
  outputStateReason?: string
  onStart?: () => void | Promise<void>
  onGrant: (grant: SecureGrantInput) => void | Promise<void>
  onRevoke: (
    leaseId?: string,
    options?: SecureRevokeOptions,
  ) => void | Promise<void>
}

export interface SecureSessionRequestConfig {
  originId?: string
  availability: SecureSessionAvailability
  requests: SecureAccessRequestView[]
  secrets: SecureSecretOption[]
  disabled?: boolean
  outputState?: 'clear' | 'quarantined'
  outputStateReason?: string
  onGrant: (grant: SecureGrantInput) => void | Promise<void>
  onDeny: (requestId: string) => void | Promise<void>
  onRevoke?: (
    leaseId?: string,
    options?: SecureRevokeOptions,
  ) => void | Promise<void>
  onPrivateFulfill?: (
    requestId: string,
    value: string | Uint8Array,
  ) => void | Promise<void>
}
