import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type {
  SecureGrantInput,
  SecureLeasePolicyView,
  SecurePrivateFulfillmentInput,
  SecureSecretBindingView,
  SecureSecretOption,
  SecureSessionSnapshotView,
} from '@/components/chat/secure-session/types'
import { fetchSecureSecretsCatalog, type SecureSecretsCatalog } from './secure-secrets-api'
import type {
  ApplySecureSessionProjectDefaultsRequest,
  GrantSecureSecretLeaseRequest,
  GrantSecureSecretLeasesRequest,
  ResolveSecureSecretAccessRequest,
  SecureAccessRequestSummary,
  SecureSecretBinding,
  SecureSecretLeaseKind,
  SecureSecretSummary,
  SecureSessionSnapshot,
} from '@forge/protocol'

export type SecureSessionUiErrorCode =
  | 'SECURE_BUILDER_ONLY'
  | 'SECURE_PRIVATE_API_UNAVAILABLE'
  | 'SECURE_PROJECT_DEFAULT_LIMIT_REACHED'
  | 'SECURE_REQUEST_INVALID'
  | 'SECURE_SECRET_ALIAS_CONFLICT'
  | 'SECURE_SESSION_UNSUPPORTED'
  | 'SECURE_SOURCE_UNAVAILABLE'
  | 'SECURE_STALE_REVISION'
  | 'SECURE_OPERATION_FAILED'

const ERROR_MESSAGES: Record<SecureSessionUiErrorCode, string> = {
  SECURE_BUILDER_ONLY: 'Secure Sessions are available only in the local Builder.',
  SECURE_PRIVATE_API_UNAVAILABLE: 'Private secret entry requires the Forge desktop app.',
  SECURE_PROJECT_DEFAULT_LIMIT_REACHED:
    'This project already has the maximum number of automatic secrets.',
  SECURE_REQUEST_INVALID: 'The secure session request is no longer valid.',
  SECURE_SECRET_ALIAS_CONFLICT:
    'A secret with this name was saved elsewhere. Refresh and choose the saved secret.',
  SECURE_SESSION_UNSUPPORTED: 'This runtime does not support Secure Sessions.',
  SECURE_SOURCE_UNAVAILABLE: 'The secure secret source is currently unavailable.',
  SECURE_STALE_REVISION: 'Secure session access changed elsewhere. Refresh and try again.',
  SECURE_OPERATION_FAILED: 'The secure session operation could not be completed.',
}

const KNOWN_CODES = new Set<SecureSessionUiErrorCode>(
  Object.keys(ERROR_MESSAGES) as SecureSessionUiErrorCode[],
)

type SecureVaultErrorCode =
  | 'SECURE_VAULT_INVALID_REQUEST'
  | 'SECURE_VAULT_PAYLOAD_TOO_LARGE'
  | 'SECURE_VAULT_STORAGE_UNAVAILABLE'
  | 'SECURE_VAULT_INSECURE_STORAGE'
  | 'SECURE_VAULT_ENCRYPT_FAILED'
  | 'SECURE_VAULT_DECRYPT_FAILED'

interface SecureVaultPrivateBridge {
  status(): Promise<
    | { ok: true; available: true }
    | { ok: false; errorCode: SecureVaultErrorCode }
  >
  encryptLocalValue(value: string): Promise<
    | { ok: true; encryptedPayloadBase64: string }
    | { ok: false; errorCode: SecureVaultErrorCode }
  >
}

export class SecureSessionUiError extends Error {
  constructor(readonly code: SecureSessionUiErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'SecureSessionUiError'
  }
}

export function secureSessionUiErrorMessage(error: unknown): string {
  return error instanceof SecureSessionUiError
    ? error.message
    : ERROR_MESSAGES.SECURE_OPERATION_FAILED
}

export function shouldRefreshAfterProjectDefaultsApplyError(
  error: unknown,
): boolean {
  return error instanceof SecureSessionUiError
    && (
      error.code === 'SECURE_STALE_REVISION'
      || error.code === 'SECURE_SOURCE_UNAVAILABLE'
      || error.code === 'SECURE_OPERATION_FAILED'
    )
}

export function isPrivateSecureFulfillmentAvailable(): boolean {
  return getPrivateBridge() !== null
}

export async function fetchSecureSessionCatalog(
  apiClient: SettingsApiClient,
): Promise<SecureSecretsCatalog> {
  assertBuilderTarget(apiClient)
  return fetchSecureSecretsCatalog(apiClient)
}

export async function fetchSecureSessionSnapshot(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
): Promise<SecureSessionSnapshot> {
  return requestSnapshot(apiClient, sessionPath(sessionAgentId))
}

export async function startSecureSession(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  baseRevision?: number,
): Promise<SecureSessionSnapshot> {
  return requestSnapshot(apiClient, `${sessionPath(sessionAgentId)}/start`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(baseRevision === undefined ? {} : { baseRevision }),
  })
}

export async function stopSecureSession(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  baseRevision: number,
): Promise<SecureSessionSnapshot> {
  return requestSnapshot(apiClient, `${sessionPath(sessionAgentId)}/stop`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ baseRevision, stopProcesses: true }),
  })
}

export async function applySecureSessionProjectDefaults(
  apiClient: SettingsApiClient,
  managerAgentId: string,
  baseRevision: number,
): Promise<SecureSessionSnapshot> {
  const input: ApplySecureSessionProjectDefaultsRequest = { baseRevision }
  return requestSnapshot(
    apiClient,
    `${sessionPath(managerAgentId)}/project-defaults/apply`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    },
  )
}

export async function grantSecureSessionLease(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  baseRevision: number,
  grant: SecureGrantInput,
): Promise<SecureSessionSnapshot> {
  const lease = toLeaseRequest(baseRevision, grant)
  if (grant.requestId) {
    const resolution: ResolveSecureSecretAccessRequest = {
      baseRevision,
      requestId: grant.requestId,
      decision: 'approve',
    }
    return requestSnapshot(
      apiClient,
      `${sessionPath(sessionAgentId)}/access-requests/${encodeURIComponent(grant.requestId)}/resolve`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          baseRevision: resolution.baseRevision,
          decision: resolution.decision,
          ...(grant.selectForMissingRequest
            ? { selectedSecretId: grant.secretId }
            : {}),
        }),
      },
    )
  }

  return requestSnapshot(apiClient, `${sessionPath(sessionAgentId)}/leases`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(lease),
  })
}

export async function grantSecureSessionLeases(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  baseRevision: number,
  grants: SecureGrantInput[],
): Promise<SecureSessionSnapshot> {
  if (
    grants.length === 0
    || grants.some((grant) => grant.requestId !== undefined)
  ) {
    throw new SecureSessionUiError('SECURE_REQUEST_INVALID')
  }
  const input: GrantSecureSecretLeasesRequest = {
    baseRevision,
    grants: grants.map((grant) => {
      const { baseRevision: _baseRevision, ...lease } = toLeaseRequest(
        baseRevision,
        grant,
      )
      void _baseRevision
      return lease
    }),
  }
  return requestSnapshot(apiClient, `${sessionPath(sessionAgentId)}/leases/batch`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(input),
  })
}

export async function revokeSecureSessionLease(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  leaseId: string,
  baseRevision: number,
): Promise<SecureSessionSnapshot> {
  return requestSnapshot(
    apiClient,
    `${sessionPath(sessionAgentId)}/leases/${encodeURIComponent(leaseId)}`,
    {
      method: 'DELETE',
      headers: jsonHeaders(),
      body: JSON.stringify({ baseRevision }),
    },
  )
}

export async function denySecureAccessRequest(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  requestId: string,
  baseRevision: number,
): Promise<SecureSessionSnapshot> {
  const input: ResolveSecureSecretAccessRequest = {
    baseRevision,
    requestId,
    decision: 'deny',
  }
  return requestSnapshot(
    apiClient,
    `${sessionPath(sessionAgentId)}/access-requests/${encodeURIComponent(requestId)}/resolve`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        baseRevision: input.baseRevision,
        decision: input.decision,
      }),
    },
  )
}

export async function fulfillSecureAccessRequestPrivately(
  apiClient: SettingsApiClient,
  sessionAgentId: string,
  request: SecureAccessRequestSummary,
  baseRevision: number,
  input: SecurePrivateFulfillmentInput,
): Promise<SecureSessionSnapshot> {
  assertBuilderTarget(apiClient)
  let privateValue = ''
  let encryptedMaterial: string | undefined
  try {
    privateValue = typeof input.value === 'string'
      ? input.value
      : new TextDecoder('utf-8', { fatal: true }).decode(input.value)
    encryptedMaterial = await encryptPrivateValue(privateValue)
  } finally {
    if (typeof input.value !== 'string') input.value.fill(0)
    privateValue = ''
  }
  if (!encryptedMaterial) throw new SecureSessionUiError('SECURE_OPERATION_FAILED')
  return requestSnapshot(
    apiClient,
    `${sessionPath(sessionAgentId)}/access-requests/${encodeURIComponent(request.requestId)}/fulfill`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        baseRevision,
        displayAlias: request.displayAlias,
        encryptedMaterial,
        retention: input.retention,
        scope: input.scope,
        ...(input.makeProjectDefault ? { makeProjectDefault: true } : {}),
        leaseKind: request.requestedLeaseKind,
        ...(request.requestedDurationSeconds === undefined
          ? {}
          : { durationSeconds: request.requestedDurationSeconds }),
        exposures: request.requestedExposures,
      }),
    },
  )
}

export function toSecureSecretOptions(secrets: SecureSecretSummary[]): SecureSecretOption[] {
  return secrets.map((secret) => ({
    secretId: secret.secretId,
    displayAlias: secret.displayAlias,
    ...(secret.displayName ? { displayName: secret.displayName } : {}),
    available: secret.available,
    bindings: secret.bindings.map(toBindingView),
  }))
}

export function resolveSecureSecretsForProfile(
  secrets: SecureSecretSummary[],
  profileId: string | null | undefined,
): SecureSecretSummary[] {
  if (!profileId) return secrets.filter((secret) => secret.scope.kind === 'instance')

  const resolvedByAlias = new Map<string, SecureSecretSummary>()
  for (const secret of secrets) {
    if (secret.scope.kind === 'profile') {
      if (secret.scope.profileId !== profileId) continue
      resolvedByAlias.set(secret.displayAlias, secret)
      continue
    }
    if (!resolvedByAlias.has(secret.displayAlias)) {
      resolvedByAlias.set(secret.displayAlias, secret)
    }
  }
  return Array.from(resolvedByAlias.values())
}

export function toSecureSessionSnapshotView(
  snapshot: SecureSessionSnapshot,
): SecureSessionSnapshotView {
  return {
    sessionAgentId: snapshot.sessionAgentId,
    principalKind: snapshot.principalKind,
    ...(snapshot.ownerManagerAgentId
      ? { ownerManagerAgentId: snapshot.ownerManagerAgentId }
      : {}),
    revision: snapshot.revision,
    executionMode: snapshot.executionMode,
    environmentStatus: snapshot.environmentStatus,
    outputState: snapshot.outputState ?? 'clear',
    ...(snapshot.outputStateCode
      ? { outputStateCode: snapshot.outputStateCode }
      : {}),
    leases: snapshot.leases.map((lease) => ({
      leaseId: lease.leaseId,
      secretId: lease.secretId,
      displayAlias: lease.displayAlias,
      policy: toLeasePolicy(lease.leaseKind, snapshot.updatedAt, lease.expiresAt),
      status: lease.status,
      bindings: lease.exposures.map(toBindingView),
      ...(lease.expiresAt ? { expiresAt: lease.expiresAt } : {}),
      ...(lease.lastUsedAt ? { lastUsedAt: lease.lastUsedAt } : {}),
      ...(lease.remainingUses === null ? {} : { remainingUses: lease.remainingUses }),
      grantSource: lease.grantSource ?? 'manual',
    })),
    pendingRequests: snapshot.pendingRequests.map((request) => ({
      requestId: request.requestId,
      sessionAgentId: snapshot.sessionAgentId,
      requestedByAgentId: request.requestedByAgentId,
      ...(request.requestedByDisplayName
        ? { requestedByLabel: request.requestedByDisplayName }
        : {}),
      ...(request.displayAlias ? { secretAlias: request.displayAlias } : {}),
      ...(request.secretId ? { secretId: request.secretId } : {}),
      purpose: request.purposeSummary,
      requestedBindings: request.requestedExposures.map(toBindingView),
      requestedPolicy: toLeasePolicy(
        request.requestedLeaseKind,
        request.createdAt,
        request.requestedDurationSeconds === undefined
          ? null
          : new Date(
              new Date(request.createdAt).getTime() + request.requestedDurationSeconds * 1_000,
            ).toISOString(),
      ),
      status: 'pending',
    })),
    projectDefaults: (snapshot.projectDefaults ?? []).map((projectDefault) => ({
      secretId: projectDefault.secretId,
      displayAlias: projectDefault.displayAlias,
      state: projectDefault.state,
      statusCode: projectDefault.statusCode,
    })),
    updatedAt: snapshot.updatedAt,
  }
}

export function toProtocolBindings(bindings: SecureSecretBindingView[]): SecureSecretBinding[] {
  return bindings.map((binding) => {
    switch (binding.kind) {
      case 'env':
        return { deliveryKind: 'environment', targetName: binding.variable }
      case 'stdin':
        return { deliveryKind: 'stdin' }
      case 'file':
        return {
          deliveryKind: 'file',
          targetPath: binding.targetPath,
          ...(binding.fileMode === undefined ? {} : { fileMode: binding.fileMode }),
        }
      case 'askpass':
        if (!binding.variable) {
          throw new SecureSessionUiError('SECURE_REQUEST_INVALID')
        }
        return { deliveryKind: 'askpass', targetName: binding.variable }
      case 'ssh_agent':
        return { deliveryKind: 'ssh_agent' }
    }
  })
}

function toBindingView(binding: SecureSecretBinding): SecureSecretBindingView {
  switch (binding.deliveryKind) {
    case 'environment':
      return { kind: 'env', variable: binding.targetName }
    case 'stdin':
      return { kind: 'stdin' }
    case 'file':
      return {
        kind: 'file',
        targetPath: binding.targetPath,
        ...(binding.fileMode === undefined ? {} : { fileMode: binding.fileMode }),
      }
    case 'askpass':
      return { kind: 'askpass', variable: binding.targetName }
    case 'ssh_agent':
      return { kind: 'ssh_agent' }
  }
}

function toLeasePolicy(
  leaseKind: SecureSecretLeaseKind,
  startAt: string,
  expiresAt: string | null,
): SecureLeasePolicyView {
  if (leaseKind === 'task') return { kind: 'task' }
  if (leaseKind === 'one_use') return { kind: 'one_use' }
  const durationSeconds = expiresAt
    ? Math.max(1, Math.round((Date.parse(expiresAt) - Date.parse(startAt)) / 1_000))
    : 1
  return { kind: 'timed', durationSeconds }
}

function toLeaseRequest(
  baseRevision: number,
  grant: SecureGrantInput,
): GrantSecureSecretLeaseRequest {
  const base = {
    baseRevision,
    secretId: grant.secretId,
    exposures: toProtocolBindings(grant.bindings),
  }
  switch (grant.policy.kind) {
    case 'task':
      return { ...base, leaseKind: 'task' }
    case 'one_use':
      return { ...base, leaseKind: 'one_use' }
    case 'timed':
      return {
        ...base,
        leaseKind: 'timed',
        durationSeconds: grant.policy.durationSeconds,
      }
  }
}

function sessionPath(sessionAgentId: string): string {
  return `/api/secure-sessions/${encodeURIComponent(sessionAgentId)}`
}

function getPrivateBridge(): SecureVaultPrivateBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (
    window.electronBridge as unknown as
      | { secureVault?: SecureVaultPrivateBridge }
      | undefined
  )?.secureVault
  return typeof bridge?.encryptLocalValue === 'function' && typeof bridge.status === 'function'
    ? bridge
    : null
}

async function encryptPrivateValue(value: string): Promise<string> {
  const bridge = getPrivateBridge()
  if (!bridge) throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
  try {
    const status = await bridge.status()
    if (!status.ok || !status.available) {
      throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    const result = await bridge.encryptLocalValue(value)
    if (!result.ok || !result.encryptedPayloadBase64) {
      throw new SecureSessionUiError('SECURE_OPERATION_FAILED')
    }
    return result.encryptedPayloadBase64
  } catch (error) {
    if (error instanceof SecureSessionUiError) throw error
    throw new SecureSessionUiError('SECURE_OPERATION_FAILED')
  }
}

function assertBuilderTarget(apiClient: SettingsApiClient): void {
  if (apiClient.target.kind !== 'builder') {
    throw new SecureSessionUiError('SECURE_BUILDER_ONLY')
  }
}

async function requestSnapshot(
  apiClient: SettingsApiClient,
  path: string,
  init?: RequestInit,
): Promise<SecureSessionSnapshot> {
  assertBuilderTarget(apiClient)
  const controlledInit = withSecureControl(init)
  let response: Response
  try {
    response = await apiClient.fetch(path, {
      ...controlledInit,
      cache: 'no-store',
    })
  } catch {
    throw new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
  }
  if (!response.ok) throw await safeResponseError(response)
  try {
    return await response.json() as SecureSessionSnapshot
  } catch {
    throw new SecureSessionUiError('SECURE_OPERATION_FAILED')
  }
}

async function safeResponseError(response: Response): Promise<SecureSessionUiError> {
  try {
    const payload = await response.json() as { code?: unknown; error?: unknown }
    const candidate = typeof payload.code === 'string'
      ? payload.code
      : typeof payload.error === 'string'
        ? payload.error
        : ''
    if (KNOWN_CODES.has(candidate as SecureSessionUiErrorCode)) {
      return new SecureSessionUiError(candidate as SecureSessionUiErrorCode)
    }
  } catch {
    // Secure route failures are intentionally reduced to fixed UI messages.
  }
  if (response.status === 404 || response.status === 501) {
    return new SecureSessionUiError('SECURE_SESSION_UNSUPPORTED')
  }
  if (response.status === 400 || response.status === 422) {
    return new SecureSessionUiError('SECURE_REQUEST_INVALID')
  }
  if (response.status === 409) {
    return new SecureSessionUiError('SECURE_STALE_REVISION')
  }
  if (response.status >= 500) {
    return new SecureSessionUiError('SECURE_SOURCE_UNAVAILABLE')
  }
  return new SecureSessionUiError('SECURE_OPERATION_FAILED')
}

function jsonHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' }
}

function withSecureControl(init?: RequestInit): RequestInit | undefined {
  const method = init?.method?.toUpperCase() ?? 'GET'
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return init
  const token = typeof window === 'undefined'
    ? undefined
    : window.electronBridge?.secureControlToken
  if (!token) throw new SecureSessionUiError('SECURE_PRIVATE_API_UNAVAILABLE')
  const headers = new Headers(init?.headers)
  headers.set('X-Forge-Secure-Control', token)
  return { ...init, headers }
}
