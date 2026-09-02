import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { encryptRemoteSecureValue } from './secure-browser-control-api'
import type {
  GetSecureSecretSettingsResponse,
  SecureSecretBinding,
  SecureSecretAutomaticGrantPolicy,
  BitwardenPasswordManagerSettings,
  SecureSecretCatalog,
  SecureSecretProjectDefaultSummary,
  SecureSecretProviderSummary,
  SecureSecretScope,
  SecureSecretSummary,
  SecureSecretProviderTestResult,
  SecureSessionReadiness,
  SecureSshTrustedHostSummary,
  CreateSecureSshTrustedHostRequest,
  UpdateSecureSshTrustedHostRequest,
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferRequest,
  ImportSecureVaultTransferResult,
  UpdateBitwardenPasswordManagerCollectionsResult,
  UpdateSecureSecretSettingsRequest,
  UpdateSecureSecretSettingsResponse,
} from '@forge/protocol'
import {
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  parseMaxProjectDefaults,
} from '@forge/protocol'

export type {
  SecureSecretBinding,
  SecureSecretAutomaticGrantPolicy,
  SecureSecretDeliveryKind,
  SecureSecretProviderKind,
  SecureSecretProjectDefaultSummary,
  SecureSecretProviderSummary,
  SecureSecretProviderTestResult,
  SecureSecretScope,
  SecureSecretSourceStatus,
  SecureSecretSummary,
  SecureSessionReadiness,
  SecureSessionReadinessCode,
  SecureSshTrustedHostSummary,
  SecureVaultTransferBundle,
  BitwardenPasswordManagerCollectionSummary,
  BitwardenPasswordManagerSettings,
  ExportSecureVaultTransferResult,
  ImportSecureVaultTransferResult,
  UpdateBitwardenPasswordManagerCollectionsResult,
} from '@forge/protocol'

export type SecureSecretsCatalog =
  Pick<SecureSecretCatalog, 'providers' | 'secrets'>
  & {
    projectDefaults: SecureSecretProjectDefaultSummary[]
    sshTrustedHosts?: SecureSshTrustedHostSummary[]
    /**
     * Live per-project secure-grant limit for automatic grants and manual
     * grant request batches. Older backends may omit it; clients treat
     * omission as `SECURE_SECRET_MAX_PROJECT_DEFAULTS`.
     */
    maxProjectDefaults?: number
  }

export interface CreateLocalSecretInput {
  displayAlias: string
  displayName?: string
  username?: string
  note?: string
  material: string
  scope: SecureSecretScope
}

export interface CreateBitwardenPasswordManagerSecretInput extends CreateLocalSecretInput {
  collectionId: string
}

export interface UpdateSecureSecretInput {
  displayAlias?: string
  displayName?: string | null
  username?: string | null
  note?: string | null
  material?: string
  bindings?: SecureSecretBinding[]
  scope?: SecureSecretScope
}

export interface ConnectBitwardenInput {
  displayName: string
  serverOrigin: string
  organizationId?: string
  projectId?: string
  accessToken: string
}

export interface ImportBitwardenSecretInput {
  providerId: string
  sourceLocator: string
  displayAlias: string
  displayName?: string
  bindings?: SecureSecretBinding[]
  scope: SecureSecretScope
}

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
  unlock(): Promise<
    | { ok: true; available: true }
    | { ok: false; errorCode: SecureVaultErrorCode }
  >
  encryptLocalValue(value: string): Promise<
    | { ok: true; encryptedPayloadBase64: string }
    | { ok: false; errorCode: SecureVaultErrorCode }
  >
}

export type SecureSecretsErrorCode =
  | 'SECURE_BUILDER_ONLY'
  | 'SECURE_PRIVATE_API_UNAVAILABLE'
  | 'SECURE_REQUEST_INVALID'
  | 'SECURE_SOURCE_LOCKED'
  | 'SECURE_SOURCE_UNAVAILABLE'
  | 'SECURE_PROVIDER_AUTH_REQUIRED'
  | 'SECURE_PROJECT_DEFAULT_LIMIT_REACHED'
  | 'SECURE_SECRET_ALIAS_CONFLICT'
  | 'SECURE_SECRET_NOT_FOUND'
  | 'SECURE_SSH_HOST_KEY_CONFLICT'
  | 'SECURE_SSH_HOST_NOT_FOUND'
  | 'SECURE_VAULT_TRANSFER_EMPTY'
  | 'SECURE_VAULT_TRANSFER_INVALID'
  | 'SECURE_VAULT_TRANSFER_MISMATCH'
  | 'SECURE_STALE_REVISION'
  | 'SECURE_OPERATION_FAILED'

const ERROR_MESSAGES: Record<SecureSecretsErrorCode, string> = {
  SECURE_BUILDER_ONLY: 'Secrets are available only on the local Builder backend.',
  SECURE_PRIVATE_API_UNAVAILABLE: 'Secret entry is available only in the Forge desktop app.',
  SECURE_REQUEST_INVALID: 'Check the secret or SSH host settings and try again.',
  SECURE_SOURCE_LOCKED: 'The secret source is locked. Unlock it and try again.',
  SECURE_SOURCE_UNAVAILABLE: 'The secret source is currently unavailable.',
  SECURE_PROVIDER_AUTH_REQUIRED: 'The secret source needs to be connected again.',
  SECURE_PROJECT_DEFAULT_LIMIT_REACHED:
    'One or more selected projects already have the maximum number of automatic grants. Remove one before adding another.',
  SECURE_SECRET_ALIAS_CONFLICT: 'A secret with this alias already exists in that scope.',
  SECURE_SECRET_NOT_FOUND: 'That saved secret no longer exists.',
  SECURE_SSH_HOST_KEY_CONFLICT:
    'This SSH alias already has different connection details or a different host key. Review the saved host before replacing it.',
  SECURE_SSH_HOST_NOT_FOUND: 'That trusted SSH host no longer exists.',
  SECURE_VAULT_TRANSFER_EMPTY:
    'There is no machine-bound secret material to transfer.',
  SECURE_VAULT_TRANSFER_INVALID:
    'The vault transfer file or transfer code is invalid.',
  SECURE_VAULT_TRANSFER_MISMATCH:
    'This transfer does not match the copied Forge data on this machine.',
  SECURE_STALE_REVISION: 'Secret settings changed elsewhere. Refresh and try again.',
  SECURE_OPERATION_FAILED: 'The secure secrets operation could not be completed.',
}

const KNOWN_ERROR_CODES = new Set<SecureSecretsErrorCode>(
  Object.keys(ERROR_MESSAGES) as SecureSecretsErrorCode[],
)

export class SecureSecretsError extends Error {
  constructor(readonly code: SecureSecretsErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'SecureSecretsError'
  }
}

export function secureSecretsErrorMessage(error: unknown): string {
  return error instanceof SecureSecretsError
    ? error.message
    : ERROR_MESSAGES.SECURE_OPERATION_FAILED
}

export function resolveMaxProjectDefaults(
  catalog: Pick<SecureSecretsCatalog, 'maxProjectDefaults'> | null | undefined,
): number {
  try {
    return parseMaxProjectDefaults(catalog?.maxProjectDefaults)
  } catch {
    return SECURE_SECRET_MAX_PROJECT_DEFAULTS
  }
}

export function isSecureMaterialEntryAvailable(): boolean {
  return getPrivateBridge() !== null
}

export async function checkSecureMaterialEntryAvailability(): Promise<boolean> {
  const bridge = getPrivateBridge()
  if (!bridge) return false
  try {
    const status = await bridge.status()
    return status.ok && status.available
  } catch {
    return false
  }
}

/**
 * Explicitly asks Forge Desktop to initialize or unlock operating-system
 * private storage. Passive readiness checks never call this method.
 */
export async function unlockSecureMaterialEntry(): Promise<boolean> {
  const bridge = getPrivateBridge()
  if (!bridge) return false
  try {
    const result = await bridge.unlock()
    return result.ok && result.available
  } catch {
    return false
  }
}

export async function fetchSecureSecretsCatalog(
  apiClient: SettingsApiClient,
): Promise<SecureSecretsCatalog> {
  assertBuilderTarget(apiClient)
  const [
    providerPayload,
    secretPayload,
    projectDefaultPayload,
    sshTrustedHostPayload,
    settingsPayload,
  ] =
    await Promise.all([
    requestJson<SecureSecretProviderSummary[] | { providers: SecureSecretProviderSummary[] }>(
      apiClient,
      '/api/secure-secrets/providers',
    ),
    requestJson<SecureSecretSummary[] | { secrets: SecureSecretSummary[] }>(
      apiClient,
      '/api/secure-secrets',
    ),
    requestJson<
      SecureSecretProjectDefaultSummary[]
      | { projectDefaults: SecureSecretProjectDefaultSummary[] }
    >(
      apiClient,
      '/api/secure-secrets/project-defaults',
    ),
    requestJson<
      SecureSshTrustedHostSummary[]
      | { trustedHosts: SecureSshTrustedHostSummary[] }
    >(
      apiClient,
      '/api/secure-secrets/ssh-trusted-hosts',
    ),
    fetchSecureSecretSettings(apiClient).catch((error) => {
      if (error instanceof SecureSecretsError && error.code === 'SECURE_SECRET_NOT_FOUND') {
        return null
      }
      throw error
    }),
  ])

  return {
    providers: Array.isArray(providerPayload) ? providerPayload : providerPayload.providers,
    secrets: Array.isArray(secretPayload) ? secretPayload : secretPayload.secrets,
    projectDefaults: Array.isArray(projectDefaultPayload)
      ? projectDefaultPayload
      : projectDefaultPayload.projectDefaults,
    sshTrustedHosts: Array.isArray(sshTrustedHostPayload)
      ? sshTrustedHostPayload
      : sshTrustedHostPayload.trustedHosts,
    maxProjectDefaults: resolveMaxProjectDefaults(settingsPayload?.settings),
  }
}

export async function fetchSecureSecretSettings(
  apiClient: SettingsApiClient,
): Promise<GetSecureSecretSettingsResponse> {
  assertBuilderTarget(apiClient)
  return await requestJson<GetSecureSecretSettingsResponse>(
    apiClient,
    '/api/settings/secure-secrets',
  )
}

export async function updateSecureSecretSettings(
  apiClient: SettingsApiClient,
  patch: UpdateSecureSecretSettingsRequest,
): Promise<UpdateSecureSecretSettingsResponse> {
  assertBuilderTarget(apiClient)
  return await requestJson<UpdateSecureSecretSettingsResponse>(
    apiClient,
    '/api/settings/secure-secrets',
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  )
}

export async function exportSecureVaultTransfer(
  apiClient: SettingsApiClient,
): Promise<ExportSecureVaultTransferResult> {
  assertBuilderTarget(apiClient)
  return await requestJson<ExportSecureVaultTransferResult>(
    apiClient,
    '/api/secure-secrets/transfer/export',
    { method: 'POST' },
  )
}

export async function importSecureVaultTransfer(
  apiClient: SettingsApiClient,
  input: ImportSecureVaultTransferRequest,
): Promise<ImportSecureVaultTransferResult> {
  assertBuilderTarget(apiClient)
  return await requestJson<ImportSecureVaultTransferResult>(
    apiClient,
    '/api/secure-secrets/transfer/import',
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    },
  )
}

export async function createSecureSshTrustedHost(
  apiClient: SettingsApiClient,
  input: CreateSecureSshTrustedHostRequest,
): Promise<SecureSshTrustedHostSummary> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSshTrustedHostSummary>(
    apiClient,
    '/api/secure-secrets/ssh-trusted-hosts',
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    },
  )
}

export async function updateSecureSshTrustedHost(
  apiClient: SettingsApiClient,
  trustedHostId: string,
  input: UpdateSecureSshTrustedHostRequest,
): Promise<SecureSshTrustedHostSummary> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSshTrustedHostSummary>(
    apiClient,
    `/api/secure-secrets/ssh-trusted-hosts/${encodeURIComponent(trustedHostId)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify(input),
    },
  )
}

export async function deleteSecureSshTrustedHost(
  apiClient: SettingsApiClient,
  trustedHostId: string,
): Promise<void> {
  assertBuilderTarget(apiClient)
  await requestEmpty(
    apiClient,
    `/api/secure-secrets/ssh-trusted-hosts/${encodeURIComponent(trustedHostId)}`,
    { method: 'DELETE' },
  )
}

export async function fetchSecureSessionReadiness(
  apiClient: SettingsApiClient,
): Promise<SecureSessionReadiness> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSessionReadiness>(
    apiClient,
    '/api/secure-sessions/readiness',
  )
}

export async function installSecureRunner(
  apiClient: SettingsApiClient,
): Promise<SecureSessionReadiness> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSessionReadiness>(
    apiClient,
    '/api/secure-sessions/runner/install',
    { method: 'POST' },
  )
}

export async function createLocalSecret(
  apiClient: SettingsApiClient,
  input: CreateLocalSecretInput,
): Promise<SecureSecretSummary> {
  assertBuilderTarget(apiClient)
  const encryptedMaterial = await encryptMaterial(apiClient, input.material)
  return requestJson<SecureSecretSummary>(apiClient, '/api/secure-secrets/local', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      displayAlias: input.displayAlias,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.note ? { note: input.note } : {}),
      encryptedMaterial,
      scope: input.scope,
    }),
  })
}

export async function createBitwardenPasswordManagerSecret(
  apiClient: SettingsApiClient,
  providerId: string,
  input: CreateBitwardenPasswordManagerSecretInput,
): Promise<SecureSecretSummary> {
  assertBuilderTarget(apiClient)
  const encryptedMaterial = await encryptMaterial(apiClient, input.material)
  return requestJson<SecureSecretSummary>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/items`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        collectionId: input.collectionId,
        displayAlias: input.displayAlias,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.username ? { username: input.username } : {}),
        ...(input.note ? { note: input.note } : {}),
        encryptedMaterial,
        scope: input.scope,
      }),
    },
  )
}

export async function updateSecureSecret(
  apiClient: SettingsApiClient,
  secretId: string,
  input: UpdateSecureSecretInput,
): Promise<SecureSecretSummary> {
  assertBuilderTarget(apiClient)
  const encryptedMaterial = input.material === undefined
    ? undefined
    : await encryptMaterial(apiClient, input.material)

  return requestJson<SecureSecretSummary>(
    apiClient,
    `/api/secure-secrets/${encodeURIComponent(secretId)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...(input.displayAlias === undefined ? {} : { displayAlias: input.displayAlias }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.username === undefined ? {} : { username: input.username }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(encryptedMaterial === undefined ? {} : { encryptedMaterial }),
      }),
    },
  )
}

export async function deleteSecureSecret(
  apiClient: SettingsApiClient,
  secretId: string,
): Promise<void> {
  assertBuilderTarget(apiClient)
  await requestEmpty(
    apiClient,
    `/api/secure-secrets/${encodeURIComponent(secretId)}`,
    { method: 'DELETE' },
  )
}

export async function connectBitwardenProvider(
  apiClient: SettingsApiClient,
  input: ConnectBitwardenInput,
): Promise<SecureSecretProviderSummary> {
  assertBuilderTarget(apiClient)
  const encryptedAccessToken = await encryptMaterial(apiClient, input.accessToken)

  return requestJson<SecureSecretProviderSummary>(
    apiClient,
    '/api/secure-secrets/providers/bitwarden',
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        displayName: input.displayName,
        serverOrigin: input.serverOrigin,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        encryptedAccessToken,
      }),
    },
  )
}

export async function reconnectBitwardenProvider(
  apiClient: SettingsApiClient,
  providerId: string,
  accessToken: string,
): Promise<SecureSecretProviderSummary> {
  assertBuilderTarget(apiClient)
  const encryptedAccessToken = await encryptMaterial(apiClient, accessToken)
  return requestJson<SecureSecretProviderSummary>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/credential`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ encryptedAccessToken }),
    },
  )
}

export async function connectBitwardenPasswordManager(
  apiClient: SettingsApiClient,
  displayName = 'Bitwarden Password Manager',
): Promise<SecureSecretProviderSummary> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSecretProviderSummary>(
    apiClient,
    '/api/secure-secrets/providers/bitwarden-password-manager',
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ displayName }),
    },
  )
}

export async function fetchBitwardenPasswordManagerSettings(
  apiClient: SettingsApiClient,
  providerId: string,
): Promise<BitwardenPasswordManagerSettings> {
  assertBuilderTarget(apiClient)
  return requestJson<BitwardenPasswordManagerSettings>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/collections`,
  )
}

export async function unlockBitwardenPasswordManager(
  apiClient: SettingsApiClient,
  providerId: string,
  masterPassword: string,
): Promise<BitwardenPasswordManagerSettings> {
  assertBuilderTarget(apiClient)
  const encryptedMasterPassword = await encryptMaterial(apiClient, masterPassword)
  return requestJson<BitwardenPasswordManagerSettings>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/unlock`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ encryptedMasterPassword }),
    },
  )
}

export async function lockBitwardenPasswordManager(
  apiClient: SettingsApiClient,
  providerId: string,
): Promise<SecureSecretProviderSummary> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSecretProviderSummary>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/lock`,
    { method: 'POST' },
  )
}

export async function installBitwardenPasswordManagerCli(
  apiClient: SettingsApiClient,
  providerId: string,
): Promise<BitwardenPasswordManagerSettings> {
  assertBuilderTarget(apiClient)
  return requestJson<BitwardenPasswordManagerSettings>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/cli/install`,
    { method: 'POST' },
  )
}

export async function updateBitwardenPasswordManagerCli(
  apiClient: SettingsApiClient,
  providerId: string,
  executablePath: string | null,
): Promise<BitwardenPasswordManagerSettings> {
  assertBuilderTarget(apiClient)
  return requestJson<BitwardenPasswordManagerSettings>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/cli`,
    {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ executablePath }),
    },
  )
}

export async function replaceBitwardenPasswordManagerCollections(
  apiClient: SettingsApiClient,
  providerId: string,
  collectionIds: string[],
): Promise<UpdateBitwardenPasswordManagerCollectionsResult> {
  assertBuilderTarget(apiClient)
  return requestJson<UpdateBitwardenPasswordManagerCollectionsResult>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/collections`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ collectionIds }),
    },
  )
}

export async function importBitwardenSecret(
  apiClient: SettingsApiClient,
  input: ImportBitwardenSecretInput,
): Promise<SecureSecretSummary> {
  assertBuilderTarget(apiClient)
  return requestJson<SecureSecretSummary>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(input.providerId)}/secrets`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sourceLocator: input.sourceLocator,
        displayAlias: input.displayAlias,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.bindings ? { bindings: input.bindings } : {}),
        scope: input.scope,
      }),
    },
  )
}

export async function updateSecureSecretProjectDefault(
  apiClient: SettingsApiClient,
  profileId: string,
  secretId: string,
  enabled: boolean,
): Promise<SecureSecretProjectDefaultSummary | null> {
  assertBuilderTarget(apiClient)
  return await requestJson<SecureSecretProjectDefaultSummary | null>(
    apiClient,
    `/api/secure-secrets/project-defaults/${encodeURIComponent(profileId)}/${encodeURIComponent(secretId)}`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled }),
    },
  )
}

export async function updateSecureSecretAutomaticGrant(
  apiClient: SettingsApiClient,
  secretId: string,
  policy: SecureSecretAutomaticGrantPolicy,
): Promise<SecureSecretSummary> {
  assertBuilderTarget(apiClient)
  return await requestJson<SecureSecretSummary>(
    apiClient,
    `/api/secure-secrets/${encodeURIComponent(secretId)}/automatic-grant`,
    {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ policy }),
    },
  )
}

export async function testSecureSecretProvider(
  apiClient: SettingsApiClient,
  providerId: string,
): Promise<SecureSecretProviderTestResult> {
  assertBuilderTarget(apiClient)
  return await requestJson<SecureSecretProviderTestResult>(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}/test`,
    { method: 'POST' },
  )
}

export async function disconnectSecureSecretProvider(
  apiClient: SettingsApiClient,
  providerId: string,
): Promise<void> {
  assertBuilderTarget(apiClient)
  await requestEmpty(
    apiClient,
    `/api/secure-secrets/providers/${encodeURIComponent(providerId)}`,
    { method: 'DELETE' },
  )
}

function getPrivateBridge(): SecureVaultPrivateBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (
    window.electronBridge as unknown as
      | { secureVault?: SecureVaultPrivateBridge }
      | undefined
  )?.secureVault
  return typeof bridge?.encryptLocalValue === 'function'
    && typeof bridge.status === 'function'
    && typeof bridge.unlock === 'function'
    ? bridge
    : null
}

async function encryptMaterial(
  apiClient: SettingsApiClient,
  material: string,
): Promise<string> {
  const bridge = getPrivateBridge()
  if (!bridge) {
    try {
      return await encryptRemoteSecureValue(apiClient, material)
    } catch {
      throw new SecureSecretsError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
  }
  try {
    const status = await bridge.status()
    if (!status.ok || !status.available) {
      throw new SecureSecretsError('SECURE_PRIVATE_API_UNAVAILABLE')
    }
    const result = await bridge.encryptLocalValue(material)
    if (!result.ok || !result.encryptedPayloadBase64) {
      throw new SecureSecretsError('SECURE_OPERATION_FAILED')
    }
    return result.encryptedPayloadBase64
  } catch (error) {
    if (error instanceof SecureSecretsError) throw error
    throw new SecureSecretsError('SECURE_OPERATION_FAILED')
  }
}

function assertBuilderTarget(apiClient: SettingsApiClient): void {
  if (apiClient.target.kind !== 'builder') {
    throw new SecureSecretsError('SECURE_BUILDER_ONLY')
  }
}

async function requestEmpty(
  apiClient: SettingsApiClient,
  path: string,
  init?: RequestInit,
): Promise<void> {
  const controlledInit = withSecureControl(init)
  let response: Response
  try {
    response = await apiClient.fetch(path, {
      ...controlledInit,
      cache: 'no-store',
      credentials: 'include',
    })
  } catch {
    throw new SecureSecretsError('SECURE_SOURCE_UNAVAILABLE')
  }
  if (!response.ok) throw await safeResponseError(response)
}

async function requestJson<T>(
  apiClient: SettingsApiClient,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const controlledInit = withSecureControl(init)
  let response: Response
  try {
    response = await apiClient.fetch(path, {
      ...controlledInit,
      cache: 'no-store',
      credentials: 'include',
    })
  } catch {
    throw new SecureSecretsError('SECURE_SOURCE_UNAVAILABLE')
  }
  if (!response.ok) throw await safeResponseError(response)
  try {
    return await response.json() as T
  } catch {
    throw new SecureSecretsError('SECURE_OPERATION_FAILED')
  }
}

async function safeResponseError(response: Response): Promise<SecureSecretsError> {
  try {
    const payload = await response.json() as { code?: unknown; error?: unknown }
    const candidate = typeof payload.code === 'string'
      ? payload.code
      : typeof payload.error === 'string'
        ? payload.error
        : ''
    if (KNOWN_ERROR_CODES.has(candidate as SecureSecretsErrorCode)) {
      return new SecureSecretsError(candidate as SecureSecretsErrorCode)
    }
  } catch {
    // Secure routes never reflect raw response text into the UI.
  }
  return new SecureSecretsError(mapStatusToSafeCode(response.status))
}

function mapStatusToSafeCode(status: number): SecureSecretsErrorCode {
  if (status === 400) return 'SECURE_REQUEST_INVALID'
  if (status === 401 || status === 403) return 'SECURE_PROVIDER_AUTH_REQUIRED'
  if (status === 404) return 'SECURE_SECRET_NOT_FOUND'
  if (status === 409) return 'SECURE_STALE_REVISION'
  if (status === 423) return 'SECURE_SOURCE_LOCKED'
  if (status >= 500) return 'SECURE_SOURCE_UNAVAILABLE'
  return 'SECURE_OPERATION_FAILED'
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
  if (!token) return init
  const headers = new Headers(init?.headers)
  headers.set('X-Forge-Secure-Control', token)
  return { ...init, headers }
}
