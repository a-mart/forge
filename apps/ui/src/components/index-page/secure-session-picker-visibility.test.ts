import { describe, expect, it } from 'vitest'
import type { SecureSessionPickerConfig } from '@/components/chat/secure-session/types'
import { shouldShowSecureSessionPicker } from './secure-session-picker-visibility'

function config(
  overrides: Partial<SecureSessionPickerConfig> = {},
): SecureSessionPickerConfig {
  return {
    availability: { state: 'available' },
    secrets: [],
    ...overrides,
  }
}

const usableSecret = {
  secretId: 'secret-1',
  displayAlias: 'deploy-token',
  available: true,
  bindings: [{ kind: 'env' as const, variable: 'DEPLOY_TOKEN' }],
}

describe('shouldShowSecureSessionPicker', () => {
  it('stays hidden until the manager has a usable secret or project default', () => {
    expect(shouldShowSecureSessionPicker(config())).toBe(false)
    expect(shouldShowSecureSessionPicker(config({
      secrets: [usableSecret],
    }))).toBe(true)
    expect(shouldShowSecureSessionPicker(config({
      snapshot: {
        sessionAgentId: 'manager-1',
        principalKind: 'manager',
        revision: 1,
        executionMode: 'standard',
        environmentStatus: 'stopped',
        leases: [],
        pendingRequests: [],
        projectDefaults: [{
          secretId: 'secret-1',
          displayAlias: 'deploy-token',
          state: 'conflict',
          statusCode: 'binding_conflict',
        }],
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
    }))).toBe(true)
  })

  it('hides idle controls when the source, runtime, or worker cannot act', () => {
    expect(shouldShowSecureSessionPicker(config({
      secrets: [{ ...usableSecret, available: false }],
    }))).toBe(false)
    expect(shouldShowSecureSessionPicker(config({
      availability: { state: 'source_unavailable' },
      secrets: [usableSecret],
    }))).toBe(false)
    expect(shouldShowSecureSessionPicker(config({
      availability: { state: 'unsupported_runtime' },
      secrets: [usableSecret],
    }))).toBe(false)
    expect(shouldShowSecureSessionPicker(config({
      availability: { state: 'remote_origin' },
      secrets: [usableSecret],
    }))).toBe(false)
    expect(shouldShowSecureSessionPicker(config({
      readOnly: true,
      secrets: [usableSecret],
    }))).toBe(false)
  })

  it('keeps recovery and active secure state visible after availability changes', () => {
    expect(shouldShowSecureSessionPicker(config({
      availability: { state: 'source_unavailable' },
      snapshot: {
        sessionAgentId: 'manager-1',
        principalKind: 'manager',
        revision: 1,
        executionMode: 'secure',
        environmentStatus: 'failed',
        leases: [],
        pendingRequests: [],
        updatedAt: '2026-07-28T00:00:00.000Z',
      },
    }))).toBe(true)
    expect(shouldShowSecureSessionPicker(config({
      readOnly: true,
      outputState: 'quarantined',
    }))).toBe(true)
  })
})
