import type {
  SecureSecretLeaseGrantSource,
  SecureSecretRetention,
  SecureSecretScope,
  SecureSessionProjectDefaultState,
  SecureSessionProjectDefaultStatusCode,
} from '@forge/protocol'

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
  grantSource?: SecureSecretLeaseGrantSource
}

export interface SecureProjectDefaultStatusView {
  secretId: string
  displayAlias: string
  state: SecureSessionProjectDefaultState
  statusCode: SecureSessionProjectDefaultStatusCode
}

export interface SecureAccessRequestView {
  requestId: string
  sessionAgentId: string
  principalLabel?: string
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
  principalKind: 'manager' | 'worker'
  ownerManagerAgentId?: string
  revision: number
  executionMode: 'standard' | 'secure'
  environmentStatus: 'stopped' | 'starting' | 'ready' | 'degraded' | 'failed'
  outputState?: 'clear' | 'quarantined'
  outputStateCode?: 'SECURE_OUTPUT_QUARANTINED'
  leases: SecureLeaseView[]
  pendingRequests: SecureAccessRequestView[]
  projectDefaults?: SecureProjectDefaultStatusView[]
  updatedAt: string
}

export interface SecureSessionTeamMemberView {
  sessionAgentId: string
  displayName: string
  snapshot: SecureSessionSnapshotView
}

export interface SecureGrantInput {
  requestId?: string
  /** Selects a newly saved catalog secret for a request that began without one. */
  selectForMissingRequest?: boolean
  secretId: string
  bindings: SecureSecretBindingView[]
  policy: SecureLeasePolicyView
}

export interface SecureRevokeOptions {
  stopProcesses?: boolean
}

export interface SecureSessionProjectContext {
  profileId: string
  displayName: string
  projectDefaultLimitReached?: boolean
}

export type SecurePrivateFulfillmentInput =
  | {
      value: string | Uint8Array
      retention: 'session'
      scope: Extract<SecureSecretScope, { kind: 'profile' }>
      makeProjectDefault?: false
    }
  | {
      value: string | Uint8Array
      retention: Extract<SecureSecretRetention, 'saved'>
      scope: SecureSecretScope
      makeProjectDefault?: boolean
    }

export interface SecureSessionPickerConfig {
  /** Origin identity closes open controls when equal agent ids are viewed on another origin. */
  originId?: string
  availability: SecureSessionAvailability
  snapshot?: SecureSessionSnapshotView | null
  teamMembers?: SecureSessionTeamMemberView[]
  readOnly?: boolean
  secrets: SecureSecretOption[]
  disabled?: boolean
  outputState?: 'clear' | 'quarantined'
  outputStateReason?: string
  onStart?: () =>
    | SecureSessionSnapshotView
    | boolean
    | void
    | Promise<SecureSessionSnapshotView | boolean | void>
  onGrant?: (
    sessionAgentId: string,
    grants: SecureGrantInput[],
  ) => boolean | void | Promise<boolean | void>
  onApplyProjectDefaults?: (
    managerAgentId: string,
  ) => boolean | void | Promise<boolean | void>
  onReviewProjectSecrets?: () => void
  onRevoke?: (
    sessionAgentId: string,
    leaseId?: string,
    options?: SecureRevokeOptions,
  ) => void | Promise<void>
}

export interface SecureSessionRequestConfig {
  originId?: string
  sessionAgentId?: string
  availability: SecureSessionAvailability
  requests: SecureAccessRequestView[]
  secrets: SecureSecretOption[]
  project?: SecureSessionProjectContext
  disabled?: boolean
  outputState?: 'clear' | 'quarantined'
  outputStateReason?: string
  onGrant: (
    sessionAgentId: string,
    grant: SecureGrantInput,
  ) => boolean | void | Promise<boolean | void>
  onDeny: (sessionAgentId: string, requestId: string) => void | Promise<void>
  onRevoke?: (
    sessionAgentId: string,
    leaseId?: string,
    options?: SecureRevokeOptions,
  ) => void | Promise<void>
  onPrivateFulfill?: (
    sessionAgentId: string,
    requestId: string,
    input: SecurePrivateFulfillmentInput,
  ) => void | Promise<void>
}
