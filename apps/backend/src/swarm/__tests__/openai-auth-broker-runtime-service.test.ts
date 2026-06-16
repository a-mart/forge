import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempConfig, type TempConfigHandle } from '../../test-support/temp-config.js'
import type { AgentDescriptor } from '../types.js'
import {
  buildOpenAICodexAuthCredentialFromLease,
  extractChatGptAccountIdFromAccessToken,
  OpenAIAuthBrokerRuntimeService,
} from '../openai-auth/openai-auth-broker-runtime-service.js'

const handles: TempConfigHandle[] = []
const originalEnv = { ...process.env }

afterEach(async () => {
  process.env = { ...originalEnv }
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(handles.splice(0).map((handle) => handle.cleanup()))
})

describe('OpenAIAuthBrokerRuntimeService', () => {
  it('builds Pi oauth credentials from broker leases using JWT account id claims', () => {
    const accountId = 'acct-from-jwt'
    const accessToken = `e30.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    })).toString('base64url')}.sig`

    expect(extractChatGptAccountIdFromAccessToken(accessToken)).toBe(accountId)
    expect(buildOpenAICodexAuthCredentialFromLease({
      leaseId: 'lease-1',
      credential: {
        type: 'oauth',
        access: accessToken,
        expires: 1_700_000_000_000,
        accountId: 'fallback-account',
      },
    })).toMatchObject({
      type: 'oauth',
      access: accessToken,
      expires: 1_700_000_000_000,
      accountId,
    })
  })

  it('acquires a broker lease for openai-codex runtimes without persisting tokens to auth.json', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        leaseId: 'lease-runtime-1',
        credential: {
          type: 'oauth',
          access: 'leased-access-token',
          expires: 1_700_000_000_000,
          accountId: 'broker-account-1',
        },
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const descriptor = makeDescriptor(handle.config.paths.dataDir)
    const prepared = await service.acquireForRuntime(descriptor)
    expect(prepared.handle.leaseId).toBe('lease-runtime-1')
    expect(prepared.authStorage.get('openai-codex')).toMatchObject({
      type: 'oauth',
      access: 'leased-access-token',
      accountId: 'broker-account-1',
    })
  })

  it('does not renew broker leases before an absolute renewAfterMs epoch time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('renew should not be called')
    })

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const renewed = await service.renewIfNeeded({
      leaseId: 'lease-current',
      identity: { clientId: 'forge', instanceId: 'forge' },
      renewedAtMs: Date.now() - 60_000,
      lease: {
        leaseId: 'lease-current',
        renewAfterMs: Date.now() + 60_000,
        credential: {
          type: 'oauth',
          access: 'current-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-1',
        },
      },
    })

    expect(renewed.leaseId).toBe('lease-current')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renews broker leases after an absolute renewAfterMs epoch time has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response(JSON.stringify({
      leaseId: 'lease-renewed',
      renewAfterMs: Date.now() + 120_000,
      credential: {
        type: 'oauth',
        access: 'renewed-access-token',
        expires: Date.now() + 3_600_000,
        accountId: 'broker-account-2',
      },
    })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const renewed = await service.renewIfNeeded({
      leaseId: 'lease-expired',
      identity: { clientId: 'forge', instanceId: 'forge' },
      renewedAtMs: Date.now() - 60_000,
      lease: {
        leaseId: 'lease-expired',
        renewAfterMs: Date.now() - 1,
        credential: {
          type: 'oauth',
          access: 'expired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-1',
        },
      },
    })

    expect(renewed.leaseId).toBe('lease-renewed')
    expect(renewed.lease.credential.access).toBe('renewed-access-token')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://broker.example.test/v1/leases/lease-expired/renew')
  })

  it('reacquires a broker lease when renewal reports the existing lease is stale', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        code: 'lease_not_found',
        error: 'Lease not found: lease-expired',
      }), { status: 404 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        leaseId: 'lease-reacquired',
        accountId: 'broker-account-2',
        accountLabel: 'Recovered Account',
        renewAfterMs: Date.now() + 120_000,
        expiresAtMs: Date.now() + 3_600_000,
        credential: {
          type: 'oauth',
          access: 'reacquired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-2',
        },
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const renewed = await service.renewIfNeeded({
      leaseId: 'lease-expired',
      identity: { clientId: 'forge', instanceId: 'forge' },
      renewedAtMs: Date.now() - 60_000,
      lease: {
        leaseId: 'lease-expired',
        renewAfterMs: Date.now() - 1,
        credential: {
          type: 'oauth',
          access: 'expired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-1',
        },
      },
    })

    expect(renewed).toMatchObject({
      leaseId: 'lease-reacquired',
      lease: {
        leaseId: 'lease-reacquired',
        accountId: 'broker-account-2',
        accountLabel: 'Recovered Account',
        credential: {
          access: 'reacquired-access-token',
          accountId: 'broker-account-2',
        },
      },
      renewedAtMs: Date.now(),
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://broker.example.test/v1/leases/lease-expired/renew')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://broker.example.test/v1/leases')
  })

  it('uses a reacquired lease id for subsequent broker report and release calls', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        code: 'lease_not_active',
        error: 'Lease is not active: lease-expired',
      }), { status: 409 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        leaseId: 'lease-reacquired',
        renewAfterMs: Date.now() + 120_000,
        credential: {
          type: 'oauth',
          access: 'reacquired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-2',
        },
      })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    const renewed = await service.renewIfNeeded({
      leaseId: 'lease-expired',
      identity: { clientId: 'forge', instanceId: 'forge' },
      renewedAtMs: Date.now() - 60_000,
      lease: {
        leaseId: 'lease-expired',
        renewAfterMs: Date.now() - 1,
        credential: {
          type: 'oauth',
          access: 'expired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-1',
        },
      },
    })
    await service.report(renewed, 'success')
    await service.release(renewed, 'test_complete')

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://broker.example.test/v1/leases/lease-expired/renew')
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('https://broker.example.test/v1/leases')
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('https://broker.example.test/v1/leases/lease-reacquired/report')
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe('https://broker.example.test/v1/leases/lease-reacquired/release')
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('https://broker.example.test/v1/leases/lease-expired/report')
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).not.toContain('https://broker.example.test/v1/leases/lease-expired/release')
  })

  it('preserves non-stale broker renewal failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => new Response(JSON.stringify({
      code: 'invalid_bearer',
      error: 'Broker bearer token is invalid.',
    }), { status: 401 }))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'local',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.renewIfNeeded({
      leaseId: 'lease-expired',
      identity: { clientId: 'forge', instanceId: 'forge' },
      renewedAtMs: Date.now() - 60_000,
      lease: {
        leaseId: 'lease-expired',
        renewAfterMs: Date.now() - 1,
        credential: {
          type: 'oauth',
          access: 'expired-access-token',
          expires: Date.now() + 3_600_000,
          accountId: 'broker-account-1',
        },
      },
    })).rejects.toMatchObject({ code: 'invalid_bearer' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://broker.example.test/v1/leases/lease-expired/renew')
  })

  it('maps broker contract usage snapshots with account identity and usage windows', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        provider: 'openai-codex',
        sampledAtMs: 1_780_000_000_000,
        status: {
          ok: true,
          mode: 'broker',
          provider: 'openai-codex',
          accounts: { healthy: 1, cooldown: 0, auth_error: 0, disabled: 0, draining: 0, unknown: 0 },
        },
        accounts: [{
          accountBrokerId: 'acct_001',
          accountLabel: 'Team OpenAI 1',
          accountEmail: 'us***@example.com',
          openaiAccountId: 'chatgpt-account-abc',
          status: 'healthy',
          available: true,
          plan: 'plus',
          sessionUsage: { percent: 12, resetInfo: '2.0h', resetAtMs: 1_780_007_200_000, windowSeconds: 18_000 },
          weeklyUsage: { percent: 35, resetInfo: '3.0d', resetAtMs: 1_780_259_200_000, windowSeconds: 604_800 },
          fetchedAtMs: 1_780_000_000_000,
        }],
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.fetchUsageSnapshot()).resolves.toEqual([{
      provider: 'openai',
      available: true,
      accountId: 'acct_001',
      accountLabel: 'Team OpenAI 1',
      accountEmail: 'us***@example.com',
      plan: 'plus',
      sessionUsage: {
        percent: 12,
        resetInfo: '2.0h',
        resetAtMs: 1_780_007_200_000,
        windowSeconds: 18_000,
      },
      weeklyUsage: {
        percent: 35,
        resetInfo: '3.0d',
        resetAtMs: 1_780_259_200_000,
        windowSeconds: 604_800,
      },
    }])
  })

  it('returns null usage snapshots outside broker mode and broker usage when active', async () => {
    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })

    await expect(service.fetchUsageSnapshot()).resolves.toBeNull()

    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        accounts: [{
          available: true,
          plan: 'Plus',
          primary_window: { used_percent: 12, reset_at: '2026-01-01T00:00:00.000Z' },
        }],
      })))

    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: 'broker-token' },
    })

    await expect(service.fetchUsageSnapshot()).resolves.toEqual([{
      provider: 'openai',
      available: true,
      plan: 'Plus',
      sessionUsage: {
        percent: 12,
        resetInfo: expect.any(String),
        resetAtMs: Date.parse('2026-01-01T00:00:00.000Z'),
      },
    }])
  })

  it('redacts broker usage detail strings before returning them for cache persistence', async () => {
    const brokerBearer = 'broker-secret-sentinel'
    const leakedOpenAIToken = 'sk-proj-' + 'a'.repeat(24)
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true })))
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        accounts: [{
          available: false,
          error: `capacity exhausted for ${brokerBearer} and ${leakedOpenAIToken}`,
        }],
      })))

    const handle = await makeHandle()
    const service = new OpenAIAuthBrokerRuntimeService({ config: handle.config })
    const settingsService = new (await import('../openai-auth/openai-auth-settings-service.js')).OpenAIAuthSettingsService({
      config: handle.config,
    })
    await settingsService.updateSettings({
      mode: 'central_broker',
      broker: { url: 'https://broker.example.test', token: brokerBearer },
    })

    const snapshot = await service.fetchUsageSnapshot()
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain(brokerBearer)
    expect(serialized).not.toContain(leakedOpenAIToken)
    expect(snapshot).toEqual([{
      provider: 'openai',
      available: false,
      error: 'capacity exhausted for [redacted] and [redacted]',
    }])
  })
})

async function makeHandle(): Promise<TempConfigHandle> {
  const handle = await createTempConfig({ prefix: 'forge-openai-broker-runtime-' })
  handles.push(handle)
  return handle
}

function makeDescriptor(_dataDir: string): AgentDescriptor {
  return {
    agentId: 'agent-test-1',
    profileId: 'profile-test',
    managerId: 'manager-test',
    role: 'worker',
    status: 'idle',
    model: { provider: 'openai-codex', modelId: 'gpt-5.1-codex' },
    cwd: process.cwd(),
    sessionFile: '/tmp/session.jsonl',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}
