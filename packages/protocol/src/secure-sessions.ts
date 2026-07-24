/**
 * Public Secure Sessions contracts.
 *
 * These contracts intentionally describe only catalog metadata, authorization,
 * and guest-side destinations. Provider locators, keychain references,
 * ciphertext, and plaintext values belong exclusively to the backend vault
 * boundary and must never be added here.
 */

export const SECURE_SECRET_PROVIDER_KINDS = [
  'local_keychain',
  'bitwarden_secrets_manager',
] as const

export type SecureSecretProviderKind = (typeof SECURE_SECRET_PROVIDER_KINDS)[number]

export const SECURE_SECRET_SOURCE_STATUSES = [
  'available',
  'locked',
  'auth_required',
  'unreachable',
  'missing',
  'disabled',
] as const

export type SecureSecretSourceStatus = (typeof SECURE_SECRET_SOURCE_STATUSES)[number]

export const SECURE_SECRET_SOURCE_STATUS_CODES = [
  'ok',
  'source_locked',
  'provider_auth_required',
  'source_unreachable',
  'source_missing',
  'provider_disabled',
  'provider_error',
] as const

export type SecureSecretSourceStatusCode =
  (typeof SECURE_SECRET_SOURCE_STATUS_CODES)[number]

export interface SecureSecretProviderSummary {
  providerId: string
  kind: SecureSecretProviderKind
  displayName: string
  enabled: boolean
  status: SecureSecretSourceStatus
  lastVerifiedAt: string | null
  /** Fixed code only. Provider exception messages are never public metadata. */
  lastStatusCode: SecureSecretSourceStatusCode | null
}

export const SECURE_SECRET_DELIVERY_KINDS = [
  'environment',
  'stdin',
  'file',
  'askpass',
  'ssh_agent',
] as const

export type SecureSecretDeliveryKind = (typeof SECURE_SECRET_DELIVERY_KINDS)[number]

/**
 * A guest-side destination for approved secret use.
 *
 * `targetName` and `targetPath` name destinations inside the secured
 * environment. They never identify a provider-side source.
 */
export type SecureSecretBinding =
  | {
      deliveryKind: 'environment'
      targetName: string
    }
  | {
      deliveryKind: 'stdin'
    }
  | {
      deliveryKind: 'file'
      targetPath: string
      fileMode?: number
    }
  | {
      deliveryKind: 'askpass'
      targetName: string
    }
  | {
      deliveryKind: 'ssh_agent'
    }

export const SECURE_SECRET_RETENTIONS = ['saved', 'session'] as const
export type SecureSecretRetention = (typeof SECURE_SECRET_RETENTIONS)[number]

export type SecureSecretScope =
  | { kind: 'instance' }
  | { kind: 'profile'; profileId: string }

/**
 * One project may automatically grant at most this many saved secrets.
 *
 * This matches the bounded lease-grant operation accepted by the secure
 * runner. Keeping the policy public lets clients disable impossible default
 * selections before they reach the value-entry boundary.
 */
export const SECURE_SECRET_MAX_PROJECT_DEFAULTS = 16

export interface SecureSecretSummary {
  secretId: string
  providerId: string
  displayAlias: string
  displayName: string | null
  scope: SecureSecretScope
  retention: SecureSecretRetention
  bindings: SecureSecretBinding[]
  available: boolean
  updatedAt: string
}

/**
 * Safe project-policy metadata. This record identifies only the project and
 * catalog secret; it never includes provider locators or secret material.
 */
export interface SecureSecretProjectDefaultSummary {
  profileId: string
  secretId: string
  createdAt: string
  updatedAt: string
}

export interface SecureSecretCatalog {
  revision: number
  providers: SecureSecretProviderSummary[]
  secrets: SecureSecretSummary[]
  /**
   * Additive project policy metadata. Older servers may omit it and clients
   * must interpret omission as no configured project defaults.
   */
  projectDefaults?: SecureSecretProjectDefaultSummary[]
  updatedAt: string
}

export const SECURE_SECRET_LEASE_KINDS = ['task', 'timed', 'one_use'] as const
export type SecureSecretLeaseKind = (typeof SECURE_SECRET_LEASE_KINDS)[number]

export const SECURE_SECRET_LEASE_GRANT_SOURCES = [
  'manual',
  'access_request',
  'project_default',
] as const

export type SecureSecretLeaseGrantSource =
  (typeof SECURE_SECRET_LEASE_GRANT_SOURCES)[number]

export const SECURE_SECRET_MAX_TIMED_LEASE_SECONDS = 24 * 60 * 60

export type SecureSecretLeaseSpec =
  | { leaseKind: 'task' }
  | { leaseKind: 'timed'; durationSeconds: number }
  | { leaseKind: 'one_use' }

export const SECURE_SECRET_LEASE_STATUSES = [
  'active',
  'consumed',
  'revoked',
  'expired',
] as const

export type SecureSecretLeaseStatus = (typeof SECURE_SECRET_LEASE_STATUSES)[number]

export interface SecureSessionLeaseSummary {
  leaseId: string
  secretId: string
  displayAlias: string
  leaseKind: SecureSecretLeaseKind
  exposures: SecureSecretBinding[]
  status: SecureSecretLeaseStatus
  expiresAt: string | null
  lastUsedAt: string | null
  remainingUses: number | null
  /**
   * Safe authorization provenance. Older snapshots may omit it; current
   * producers always provide it.
   */
  grantSource?: SecureSecretLeaseGrantSource
}

/**
 * A pending authorization request. The requesting agent can name only catalog
 * metadata, guest destinations, a lease policy, and a bounded purpose summary.
 */
export interface SecureAccessRequestSummary {
  requestId: string
  secretId: string | null
  displayAlias: string
  requestedLeaseKind: SecureSecretLeaseKind
  requestedDurationSeconds?: number
  requestedExposures: SecureSecretBinding[]
  purposeSummary: string
  requestedByAgentId: string
  requestedByDisplayName: string
  createdAt: string
  expiresAt: string | null
}

export type SecureSessionExecutionMode = 'standard' | 'secure'

export type SecureSessionEnvironmentStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'

export type SecureSessionOutputState = 'clear' | 'quarantined'

export type SecureSessionOutputStateCode = 'SECURE_OUTPUT_QUARANTINED'

export const SECURE_SESSION_PROJECT_DEFAULT_STATES = [
  'configured',
  'active',
  'unavailable',
  'conflict',
] as const

export type SecureSessionProjectDefaultState =
  (typeof SECURE_SESSION_PROJECT_DEFAULT_STATES)[number]

export const SECURE_SESSION_PROJECT_DEFAULT_STATUS_CODES = [
  'ok',
  'source_unavailable',
  'binding_conflict',
] as const

export type SecureSessionProjectDefaultStatusCode =
  (typeof SECURE_SESSION_PROJECT_DEFAULT_STATUS_CODES)[number]

/**
 * Runtime-only project-default status. Fixed state and status codes keep
 * provider errors and protected values outside the public snapshot.
 */
export interface SecureSessionProjectDefaultStatus {
  secretId: string
  displayAlias: string
  state: SecureSessionProjectDefaultState
  statusCode: SecureSessionProjectDefaultStatusCode
}

export interface SecureSessionSnapshot {
  sessionAgentId: string
  profileId: string
  revision: number
  executionMode: SecureSessionExecutionMode
  environmentStatus: SecureSessionEnvironmentStatus
  /**
   * Additive runtime-only disclosure state. Older persisted/bootstrap
   * snapshots may omit it and clients must interpret omission as `clear`.
   */
  outputState?: SecureSessionOutputState
  /** Fixed code only; never include matched material or provider errors. */
  outputStateCode?: SecureSessionOutputStateCode | null
  leases: SecureSessionLeaseSummary[]
  pendingRequests: SecureAccessRequestSummary[]
  /**
   * Additive runtime status. Older snapshots may omit it and clients must
   * interpret omission as no configured defaults.
   */
  projectDefaults?: SecureSessionProjectDefaultStatus[]
  updatedAt: string
}

export interface SecureSessionSnapshotEvent extends SecureSessionSnapshot {
  type: 'secure_session_snapshot'
}

/**
 * Revision-only invalidation. Clients refetch the metadata catalog over HTTP;
 * provider details and secret material never travel in the WebSocket event.
 */
export interface SecureSecretCatalogChangedEvent {
  type: 'secure_secret_catalog_changed'
  revision: number
}

interface SecureSecretUseRequestBase {
  secretId: string
  exposures: SecureSecretBinding[]
}

export type GrantSecureSecretLeaseInput =
  & SecureSecretUseRequestBase
  & SecureSecretLeaseSpec

export type GrantSecureSecretLeaseRequest =
  & GrantSecureSecretLeaseInput
  & { baseRevision: number }

export interface GrantSecureSecretLeasesRequest {
  baseRevision: number
  grants: GrantSecureSecretLeaseInput[]
}

export interface RevokeSecureSecretLeaseRequest {
  baseRevision: number
  leaseId: string
}

export type RequestSecureSecretAccessRequest =
  & SecureSecretUseRequestBase
  & SecureSecretLeaseSpec
  & { purposeSummary: string }

export type SecureSecretAccessDecision = 'approve' | 'deny'

export interface ResolveSecureSecretAccessRequest {
  baseRevision: number
  requestId: string
  decision: SecureSecretAccessDecision
  selectedSecretId?: string
  reason?: string
}

export class SecureSessionsContractError extends Error {
  constructor(message: string) {
    super(`Invalid Secure Sessions input: ${message}`)
    this.name = 'SecureSessionsContractError'
  }
}

const SECURE_SESSIONS_MAX_ID_LENGTH = 256
const SECURE_SESSIONS_MAX_TARGET_LENGTH = 4_096
const SECURE_SESSIONS_MAX_PURPOSE_LENGTH = 2_000
const SECURE_SESSIONS_MAX_EXPOSURES = 16
const SECURE_SESSIONS_MAX_GRANTS = 16

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

export function isSecureSecretProviderKind(value: unknown): value is SecureSecretProviderKind {
  return isOneOf(SECURE_SECRET_PROVIDER_KINDS, value)
}

export function isSecureSecretDeliveryKind(value: unknown): value is SecureSecretDeliveryKind {
  return isOneOf(SECURE_SECRET_DELIVERY_KINDS, value)
}

export function isSecureSecretRetention(value: unknown): value is SecureSecretRetention {
  return isOneOf(SECURE_SECRET_RETENTIONS, value)
}

export function isSecureSecretLeaseKind(value: unknown): value is SecureSecretLeaseKind {
  return isOneOf(SECURE_SECRET_LEASE_KINDS, value)
}

function recordInput(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SecureSessionsContractError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function knownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const unexpected = Object.keys(input).find((key) => !allowed.includes(key))
  if (unexpected !== undefined) {
    throw new SecureSessionsContractError(`${field} has unexpected field ${unexpected}`)
  }
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > maximum
    || value.includes('\0')
  ) {
    throw new SecureSessionsContractError(
      `${field} must be a non-empty string of at most ${maximum} characters`,
    )
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SecureSessionsContractError(`${field} must be a non-negative safe integer`)
  }
  return value as number
}

export function parseSecureSecretScope(value: unknown): SecureSecretScope {
  const input = recordInput(value, 'scope')
  if (input.kind === 'instance') {
    knownKeys(input, ['kind'], 'scope')
    return { kind: 'instance' }
  }
  if (input.kind === 'profile') {
    knownKeys(input, ['kind', 'profileId'], 'scope')
    return {
      kind: 'profile',
      profileId: boundedString(
        input.profileId,
        'scope.profileId',
        SECURE_SESSIONS_MAX_ID_LENGTH,
      ),
    }
  }
  throw new SecureSessionsContractError('scope.kind must be instance or profile')
}

export function isSecureSecretScope(value: unknown): value is SecureSecretScope {
  try {
    parseSecureSecretScope(value)
    return true
  } catch {
    return false
  }
}

export function parseSecureSecretBinding(value: unknown): SecureSecretBinding {
  const input = recordInput(value, 'binding')
  switch (input.deliveryKind) {
    case 'environment':
    case 'askpass': {
      knownKeys(input, ['deliveryKind', 'targetName'], 'binding')
      return {
        deliveryKind: input.deliveryKind,
        targetName: boundedString(
          input.targetName,
          'binding.targetName',
          SECURE_SESSIONS_MAX_TARGET_LENGTH,
        ),
      }
    }
    case 'stdin':
    case 'ssh_agent':
      knownKeys(input, ['deliveryKind'], 'binding')
      return { deliveryKind: input.deliveryKind }
    case 'file': {
      knownKeys(input, ['deliveryKind', 'targetPath', 'fileMode'], 'binding')
      if (
        input.fileMode !== undefined
        && (!Number.isInteger(input.fileMode)
          || (input.fileMode as number) < 0
          || (input.fileMode as number) > 0o777)
      ) {
        throw new SecureSessionsContractError(
          'binding.fileMode must be an integer from 0 to 0777',
        )
      }
      const fileMode = input.fileMode as number | undefined
      return {
        deliveryKind: 'file',
        targetPath: boundedString(
          input.targetPath,
          'binding.targetPath',
          SECURE_SESSIONS_MAX_TARGET_LENGTH,
        ),
        ...(fileMode === undefined ? {} : { fileMode }),
      }
    }
    default:
      throw new SecureSessionsContractError(
        `binding.deliveryKind must be one of ${SECURE_SECRET_DELIVERY_KINDS.join(', ')}`,
      )
  }
}

export function isSecureSecretBinding(value: unknown): value is SecureSecretBinding {
  try {
    parseSecureSecretBinding(value)
    return true
  } catch {
    return false
  }
}

export function parseSecureSecretLeaseSpec(value: unknown): SecureSecretLeaseSpec {
  const input = recordInput(value, 'lease')
  switch (input.leaseKind) {
    case 'task':
    case 'one_use':
      knownKeys(input, ['leaseKind'], 'lease')
      return { leaseKind: input.leaseKind }
    case 'timed': {
      knownKeys(input, ['leaseKind', 'durationSeconds'], 'lease')
      if (
        !Number.isSafeInteger(input.durationSeconds)
        || (input.durationSeconds as number) < 1
        || (input.durationSeconds as number) > SECURE_SECRET_MAX_TIMED_LEASE_SECONDS
      ) {
        throw new SecureSessionsContractError(
          `lease.durationSeconds must be an integer from 1 to ${SECURE_SECRET_MAX_TIMED_LEASE_SECONDS}`,
        )
      }
      return { leaseKind: 'timed', durationSeconds: input.durationSeconds as number }
    }
    default:
      throw new SecureSessionsContractError(
        `lease.leaseKind must be one of ${SECURE_SECRET_LEASE_KINDS.join(', ')}`,
      )
  }
}

export function isSecureSecretLeaseSpec(value: unknown): value is SecureSecretLeaseSpec {
  try {
    parseSecureSecretLeaseSpec(value)
    return true
  } catch {
    return false
  }
}

function parseExposures(value: unknown): SecureSecretBinding[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > SECURE_SESSIONS_MAX_EXPOSURES
  ) {
    throw new SecureSessionsContractError(
      `request.exposures must contain 1 to ${SECURE_SESSIONS_MAX_EXPOSURES} bindings`,
    )
  }
  return value.map((exposure) => parseSecureSecretBinding(exposure))
}

function leaseSpecFromRequest(input: Record<string, unknown>): SecureSecretLeaseSpec {
  return parseSecureSecretLeaseSpec({
    leaseKind: input.leaseKind,
    ...(input.durationSeconds === undefined
      ? {}
      : { durationSeconds: input.durationSeconds }),
  })
}

function parseGrantSecureSecretLeaseInput(
  value: unknown,
  field: string,
): GrantSecureSecretLeaseInput {
  const input = recordInput(value, field)
  const lease = leaseSpecFromRequest(input)
  knownKeys(
    input,
    lease.leaseKind === 'timed'
      ? ['secretId', 'exposures', 'leaseKind', 'durationSeconds']
      : ['secretId', 'exposures', 'leaseKind'],
    field,
  )
  return {
    secretId: boundedString(input.secretId, `${field}.secretId`, SECURE_SESSIONS_MAX_ID_LENGTH),
    exposures: parseExposures(input.exposures),
    ...lease,
  }
}

export function parseGrantSecureSecretLeaseRequest(
  value: unknown,
): GrantSecureSecretLeaseRequest {
  const input = recordInput(value, 'request')
  const grant = parseGrantSecureSecretLeaseInput(
    Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== 'baseRevision'),
    ),
    'request',
  )
  return {
    baseRevision: nonNegativeInteger(input.baseRevision, 'request.baseRevision'),
    ...grant,
  }
}

export function parseGrantSecureSecretLeasesRequest(
  value: unknown,
): GrantSecureSecretLeasesRequest {
  const input = recordInput(value, 'request')
  knownKeys(input, ['baseRevision', 'grants'], 'request')
  if (
    !Array.isArray(input.grants)
    || input.grants.length === 0
    || input.grants.length > SECURE_SESSIONS_MAX_GRANTS
  ) {
    throw new SecureSessionsContractError(
      `request.grants must contain 1 to ${SECURE_SESSIONS_MAX_GRANTS} grants`,
    )
  }
  const grants = input.grants.map((grant, index) =>
    parseGrantSecureSecretLeaseInput(grant, `request.grants[${index}]`)
  )
  if (new Set(grants.map(({ secretId }) => secretId)).size !== grants.length) {
    throw new SecureSessionsContractError(
      'request.grants must contain unique secret IDs',
    )
  }
  return {
    baseRevision: nonNegativeInteger(input.baseRevision, 'request.baseRevision'),
    grants,
  }
}

export function parseRevokeSecureSecretLeaseRequest(
  value: unknown,
): RevokeSecureSecretLeaseRequest {
  const input = recordInput(value, 'request')
  knownKeys(input, ['baseRevision', 'leaseId'], 'request')
  return {
    baseRevision: nonNegativeInteger(input.baseRevision, 'request.baseRevision'),
    leaseId: boundedString(input.leaseId, 'request.leaseId', SECURE_SESSIONS_MAX_ID_LENGTH),
  }
}

export function parseRequestSecureSecretAccessRequest(
  value: unknown,
): RequestSecureSecretAccessRequest {
  const input = recordInput(value, 'request')
  const lease = leaseSpecFromRequest(input)
  knownKeys(
    input,
    lease.leaseKind === 'timed'
      ? ['secretId', 'exposures', 'leaseKind', 'durationSeconds', 'purposeSummary']
      : ['secretId', 'exposures', 'leaseKind', 'purposeSummary'],
    'request',
  )
  return {
    secretId: boundedString(input.secretId, 'request.secretId', SECURE_SESSIONS_MAX_ID_LENGTH),
    exposures: parseExposures(input.exposures),
    purposeSummary: boundedString(
      input.purposeSummary,
      'request.purposeSummary',
      SECURE_SESSIONS_MAX_PURPOSE_LENGTH,
    ),
    ...lease,
  }
}

export function parseResolveSecureSecretAccessRequest(
  value: unknown,
): ResolveSecureSecretAccessRequest {
  const input = recordInput(value, 'request')
  knownKeys(
    input,
    ['baseRevision', 'requestId', 'decision', 'selectedSecretId', 'reason'],
    'request',
  )
  if (input.decision !== 'approve' && input.decision !== 'deny') {
    throw new SecureSessionsContractError('request.decision must be approve or deny')
  }
  if (input.decision === 'deny' && input.selectedSecretId !== undefined) {
    throw new SecureSessionsContractError(
      'request.selectedSecretId is allowed only when approving',
    )
  }
  const selectedSecretId = input.selectedSecretId === undefined
    ? undefined
    : boundedString(
        input.selectedSecretId,
        'request.selectedSecretId',
        SECURE_SESSIONS_MAX_ID_LENGTH,
      )
  const reason = input.reason === undefined
    ? undefined
    : boundedString(input.reason, 'request.reason', SECURE_SESSIONS_MAX_PURPOSE_LENGTH)
  return {
    baseRevision: nonNegativeInteger(input.baseRevision, 'request.baseRevision'),
    requestId: boundedString(input.requestId, 'request.requestId', SECURE_SESSIONS_MAX_ID_LENGTH),
    decision: input.decision,
    ...(selectedSecretId === undefined ? {} : { selectedSecretId }),
    ...(reason === undefined ? {} : { reason }),
  }
}
