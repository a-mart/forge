import { describe, expect, it, vi } from 'vitest'
import {
  OpenAIAuthBrokerClient,
  type OpenAIAuthBrokerRuntimeIdentity,
} from '../openai-auth/openai-auth-broker-client.js'

const identity: OpenAIAuthBrokerRuntimeIdentity = {
  clientId: 'forge-runtime',
  instanceId: 'forge-install-001',
  instanceLabel: 'Forge Install 001',
  userLabel: 'Adam',
  sessionId: 'session-1',
  projectId: 'profile-1',
  projectLabel: 'Profile One',
  agentId: 'agent-1',
  forgeVersion: '0.0.0-test',
  forgeTelemetryInstallId: 'telemetry-install-123',
}

const expectedClient = {
  clientId: 'forge-runtime',
  instanceId: 'forge-install-001',
  instanceLabel: 'Forge Install 001',
  userLabel: 'Adam',
  sessionId: 'session-1',
  projectId: 'profile-1',
  projectLabel: 'Profile One',
  agentId: 'agent-1',
  forgeVersion: '0.0.0-test',
  forgeTelemetryInstallId: 'telemetry-install-123',
}

const leaseCreateFixture = {
  leaseId: 'lease_test_001',
  provider: 'openai-codex',
  credential: {
    type: 'oauth',
    access: 'REDACTED_ACCESS_TOKEN',
    expires: 1_780_000_300_000,
    accountId: 'chatgpt-account-abc',
  },
  account: {
    accountBrokerId: 'acct_001',
    accountLabel: 'Team OpenAI 1',
    accountEmail: 'user@example.com',
    openaiAccountId: 'chatgpt-account-abc',
    status: 'healthy',
  },
  expiresAtMs: 1_780_000_300_000,
  renewAfterMs: 1_780_000_200_000,
}

const leaseRenewFixture = {
  leaseId: 'lease_test_renewed',
  provider: 'openai-codex',
  credential: {
    type: 'oauth',
    access: 'REDACTED_ACCESS_TOKEN_RENEWED',
    expires: 1_780_000_600_000,
    accountId: 'chatgpt-account-abc',
  },
  account: {
    accountBrokerId: 'acct_001',
    accountLabel: 'Team OpenAI 1',
    openaiAccountId: 'chatgpt-account-abc',
    status: 'healthy',
  },
  expiresAtMs: 1_780_000_600_000,
  renewAfterMs: 1_780_000_500_000,
}

const replacementFixture = {
  ok: true,
  replacement: {
    leaseId: 'lease_test_002',
    provider: 'openai-codex',
    credential: {
      type: 'oauth',
      access: 'REDACTED_ACCESS_TOKEN_2',
      expires: 1_780_001_300_000,
      accountId: 'chatgpt-account-def',
    },
    account: {
      accountBrokerId: 'acct_002',
      accountLabel: 'Team OpenAI 2',
      openaiAccountId: 'chatgpt-account-def',
      status: 'healthy',
    },
    expiresAtMs: 1_780_001_300_000,
    renewAfterMs: 1_780_001_200_000,
  },
}

describe('OpenAIAuthBrokerClient broker contract', () => {
  it('acquires leases with nested broker client identity and provider', async () => {
    const { client, requests } = makeClient([leaseCreateFixture])

    const lease = await client.acquireLease(identity)

    expect(lease.leaseId).toBe('lease_test_001')
    expect(requests).toEqual([{
      pathname: '/v1/leases',
      method: 'POST',
      body: {
        provider: 'openai-codex',
        client: expectedClient,
      },
    }])
  })

  it('renews leases with the broker renew body shape', async () => {
    const { client, requests } = makeClient([leaseRenewFixture])

    const lease = await client.renewLease('lease_test_001', identity)

    expect(lease.leaseId).toBe('lease_test_renewed')
    expect(requests).toEqual([{
      pathname: '/v1/leases/lease_test_001/renew',
      method: 'POST',
      body: { client: expectedClient },
    }])
  })

  it('reports acknowledgement-only events with the broker report body shape', async () => {
    const { client, requests } = makeClient([{ ok: true }])

    await expect(client.reportLease('lease_test_001', 'used', identity)).resolves.toBeNull()

    expect(requests).toEqual([{
      pathname: '/v1/leases/lease_test_001/report',
      method: 'POST',
      body: { client: expectedClient, event: 'used' },
    }])
  })

  it('parses replacement leases from capacity reports and maps error details to broker fields', async () => {
    const { client, requests } = makeClient([replacementFixture])

    const replacement = await client.reportLease('lease_test_001', 'capacity_error', identity, {
      message: 'rate limited',
      retryAfterMs: 60_000.9,
      errorCode: 'rate_limit_exceeded',
      requestReplacement: true,
    })

    expect(replacement?.leaseId).toBe('lease_test_002')
    expect(requests).toEqual([{
      pathname: '/v1/leases/lease_test_001/report',
      method: 'POST',
      body: {
        client: expectedClient,
        event: 'capacity_error',
        retryAfterMs: 60_000,
        errorCode: 'rate_limit_exceeded',
        errorMessage: 'rate limited',
        requestReplacement: true,
      },
    }])
  })

  it('normalizes broker status account counts including draining accounts', async () => {
    const { client, requests } = makeClient([{
      ok: true,
      accounts: { healthy: 1, cooldown: 2, auth_error: 3, disabled: 4, draining: 5, unknown: 6 },
    }])

    await expect(client.getStatus()).resolves.toMatchObject({
      ok: true,
      accounts: { healthy: 1, cooldown: 2, auth_error: 3, disabled: 4, draining: 5, unknown: 6 },
    })
    expect(requests).toEqual([{
      pathname: '/v1/status',
      method: 'GET',
      body: undefined,
    }])
  })

  it('releases leases with the broker release body shape', async () => {
    const { client, requests } = makeClient([{ ok: true }])

    await client.releaseLease('lease_test_001', 'turn_complete', identity)

    expect(requests).toEqual([{
      pathname: '/v1/leases/lease_test_001/release',
      method: 'POST',
      body: { client: expectedClient, reason: 'turn_complete' },
    }])
  })

  it('preserves nested broker error codes from non-2xx JSON bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: {
        code: 'lease_not_found',
        message: 'Lease not found: lease_test_001',
      },
    }), { status: 404 }))
    const client = new OpenAIAuthBrokerClient({
      baseUrl: 'https://broker.example.test',
      bearerToken: 'broker-test-token',
      fetchImpl,
    })

    await expect(client.renewLease('lease_test_001', identity)).rejects.toMatchObject({
      code: 'lease_not_found',
      status: 404,
    })
  })

  it('omits blank optional identity fields from the nested client object', async () => {
    const { client, requests } = makeClient([leaseCreateFixture])

    await client.acquireLease({
      clientId: 'forge-runtime',
      instanceId: 'forge-install-001',
      userLabel: '   ',
    })

    expect(requests[0]?.body).toEqual({
      provider: 'openai-codex',
      client: {
        clientId: 'forge-runtime',
        instanceId: 'forge-install-001',
      },
    })
  })
})

function makeClient(responses: unknown[]): {
  client: OpenAIAuthBrokerClient
  requests: Array<{ pathname: string; method: string; body: unknown }>
} {
  const requests: Array<{ pathname: string; method: string; body: unknown }> = []
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input))
    requests.push({
      pathname: url.pathname,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(responses.shift() ?? { ok: true }))
  })

  return {
    client: new OpenAIAuthBrokerClient({
      baseUrl: 'https://broker.example.test',
      bearerToken: 'broker-test-token',
      fetchImpl,
    }),
    requests,
  }
}
