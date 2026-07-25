import { describe, expect, it } from 'vitest'
import type { SecureSecretProviderSummary } from '@forge/protocol'
import {
  buildSafeSecureSessionsDiagnostics,
  serializeSafeSecureSessionsDiagnostics,
} from './secure-readiness-diagnostics'

describe('safe Secure Sessions diagnostics', () => {
  it('whitelists fixed fields and bounds contextual project defaults', () => {
    const provider = {
      providerId: 'provider-secret-id',
      kind: 'bitwarden_secrets_manager',
      displayName: 'Sensitive custom provider name',
      enabled: true,
      status: 'auth_required',
      lastVerifiedAt: '2026-07-24T12:00:00.000Z',
      lastStatusCode: 'provider_auth_required',
      serverOrigin: 'https://provider-sensitive.example',
      organizationId: 'org-sensitive',
      projectId: 'project-sensitive',
      encryptedAccessToken: 'ciphertext-sensitive',
      exception: 'exception-sensitive',
      commandOutput: 'command-output-sensitive',
      targetPath: '/private/path-sensitive',
    } as SecureSecretProviderSummary & Record<string, unknown>

    const serialized = serializeSafeSecureSessionsDiagnostics({
      readiness: { available: false, code: 'backend_unavailable' },
      privateEntryAvailable: false,
      providers: [provider],
      configuredProjectDefaultCount: 100,
      checkedAt: '2026-07-24T12:34:56.000Z',
    })
    const parsed = JSON.parse(serialized)

    expect(parsed).toEqual({
      schemaVersion: 1,
      checkedAt: '2026-07-24T12:34:56.000Z',
      execution: { code: 'backend_unavailable' },
      privateEntry: { available: false },
      sources: [{
        kind: 'bitwarden_secrets_manager',
        status: 'auth_required',
        statusCode: 'provider_auth_required',
      }],
      projectDefaults: Array.from(
        { length: 16 },
        () => ({ state: 'configured', statusCode: 'ok' }),
      ),
    })
    for (const forbidden of [
      'provider-secret-id',
      'Sensitive custom provider name',
      'provider-sensitive.example',
      'org-sensitive',
      'project-sensitive',
      'ciphertext-sensitive',
      'exception-sensitive',
      'command-output-sensitive',
      '/private/path-sensitive',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('omits project defaults without exact project context and normalizes unknown codes', () => {
    const diagnostics = buildSafeSecureSessionsDiagnostics({
      readiness: {
        available: true,
        code: 'future-unsafe-code',
      } as never,
      privateEntryAvailable: true,
      providers: [{
        providerId: 'future',
        kind: 'future-provider',
        displayName: 'Future',
        enabled: true,
        status: 'future-status',
        lastVerifiedAt: null,
        lastStatusCode: 'future-code',
      } as never],
      checkedAt: '2026-07-24T12:34:56.000Z',
    })

    expect(diagnostics).toEqual({
      schemaVersion: 1,
      checkedAt: '2026-07-24T12:34:56.000Z',
      execution: { code: 'backend_unavailable' },
      privateEntry: { available: true },
      sources: [],
    })
    expect('projectDefaults' in diagnostics).toBe(false)
  })
})
