import type {
  SecureSecretProviderSummary,
  SecureSecretSourceStatus,
  SecureSecretSourceStatusCode,
} from '@forge/protocol'
import {
  type SecureSessionReadiness,
  type SecureSessionReadinessCode,
} from '@/lib/secure-secrets-api'

const MAX_DIAGNOSTIC_SOURCES = 8

const EXECUTION_CODES = new Set<SecureSessionReadinessCode>([
  'available',
  'backend_unavailable',
  'image_unavailable',
  'unsupported_platform',
])

const SOURCE_KINDS = new Set<SecureSecretProviderSummary['kind']>([
  'local_keychain',
  'bitwarden_secrets_manager',
  'bitwarden_password_manager',
])

const SOURCE_STATUSES = new Set<SecureSecretSourceStatus>([
  'available',
  'locked',
  'auth_required',
  'unreachable',
  'missing',
  'disabled',
])

const SOURCE_STATUS_CODES = new Set<SecureSecretSourceStatusCode>([
  'ok',
  'source_locked',
  'provider_auth_required',
  'source_unreachable',
  'source_missing',
  'provider_disabled',
  'provider_error',
])

const STATUS_CODE_BY_STATUS: Record<
  SecureSecretSourceStatus,
  SecureSecretSourceStatusCode
> = {
  available: 'ok',
  locked: 'source_locked',
  auth_required: 'provider_auth_required',
  unreachable: 'source_unreachable',
  missing: 'source_missing',
  disabled: 'provider_disabled',
}

export interface SafeSecureSessionsDiagnostics {
  schemaVersion: 1
  checkedAt: string
  execution: {
    code: SecureSessionReadinessCode
  }
  privateEntry: {
    available: boolean
  }
  sources: Array<{
    kind: SecureSecretProviderSummary['kind']
    status: SecureSecretSourceStatus
    statusCode: SecureSecretSourceStatusCode
  }>
  /**
   * Configuration-only project defaults for the contextual project.
   * Runtime activation remains authoritative in the Secure Session picker.
   */
  projectDefaults?: {
    configuredCount: number
    truncated: boolean
  }
}

export function buildSafeSecureSessionsDiagnostics({
  readiness,
  privateEntryAvailable,
  providers,
  configuredProjectDefaultCount,
  maxProjectDefaults,
  checkedAt = new Date().toISOString(),
}: {
  readiness: SecureSessionReadiness | null
  privateEntryAvailable: boolean
  providers: SecureSecretProviderSummary[]
  configuredProjectDefaultCount?: number
  maxProjectDefaults?: number
  checkedAt?: string
}): SafeSecureSessionsDiagnostics {
  const rawExecutionCode = readiness?.code
  const executionCode = EXECUTION_CODES.has(rawExecutionCode as SecureSessionReadinessCode)
    ? rawExecutionCode as SecureSessionReadinessCode
    : 'backend_unavailable'
  const sources = providers
    .slice(0, MAX_DIAGNOSTIC_SOURCES)
    .flatMap((provider) => {
      if (!SOURCE_KINDS.has(provider.kind) || !SOURCE_STATUSES.has(provider.status)) {
        return []
      }
      const statusCode = provider.lastStatusCode
      return [{
        kind: provider.kind,
        status: provider.status,
        statusCode:
          statusCode && SOURCE_STATUS_CODES.has(statusCode)
            ? statusCode
            : STATUS_CODE_BY_STATUS[provider.status],
      }]
    })
  const exactDefaultCount = configuredProjectDefaultCount === undefined
    ? undefined
    : Math.max(0, Math.floor(configuredProjectDefaultCount))
  const diagnosticBound = typeof maxProjectDefaults === 'number' && Number.isSafeInteger(maxProjectDefaults)
    ? Math.max(0, maxProjectDefaults)
    : exactDefaultCount

  return {
    schemaVersion: 1,
    checkedAt,
    execution: { code: executionCode },
    privateEntry: { available: privateEntryAvailable === true },
    sources,
    ...(exactDefaultCount === undefined
      ? {}
      : {
          projectDefaults: {
            configuredCount: exactDefaultCount,
            truncated: diagnosticBound !== undefined && exactDefaultCount > diagnosticBound,
          },
        }),
  }
}

export function serializeSafeSecureSessionsDiagnostics(
  input: Parameters<typeof buildSafeSecureSessionsDiagnostics>[0],
): string {
  return JSON.stringify(buildSafeSecureSessionsDiagnostics(input), null, 2)
}
