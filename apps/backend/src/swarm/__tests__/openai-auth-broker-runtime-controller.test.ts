import { describe, expect, it, vi } from 'vitest'
import type { AuthCredential } from '@mariozechner/pi-coding-agent'
import type { OpenAIAuthBrokerLeaseHandle } from '../openai-auth/openai-auth-broker-runtime-service.js'
import { OpenAIAuthBrokerRuntimeController } from '../runtime/pi/openai-auth-broker-runtime-controller.js'

function makeHandle(leaseId: string, access: string, accountId: string): OpenAIAuthBrokerLeaseHandle {
  return {
    leaseId,
    identity: { clientId: 'forge', instanceId: 'forge-test' },
    renewedAtMs: Date.now(),
    lease: {
      leaseId,
      accountId,
      credential: {
        type: 'oauth',
        access,
        expires: 1_700_000_000_000,
        accountId,
      },
    },
  }
}

function credentialFromHandle(handle: OpenAIAuthBrokerLeaseHandle): AuthCredential {
  return {
    type: 'oauth',
    access: handle.lease.credential.access,
    refresh: '',
    expires: handle.lease.credential.expires,
    accountId: handle.lease.credential.accountId,
  }
}

function makeAuthStorage(initial: AuthCredential) {
  const credentials = new Map<string, AuthCredential>([['openai-codex', initial]])
  return {
    get: vi.fn((key: string) => credentials.get(key)),
    set: vi.fn((key: string, value: AuthCredential) => {
      credentials.set(key, value)
    }),
  }
}

describe('OpenAIAuthBrokerRuntimeController', () => {
  it('closes cached OpenAI Codex websocket sessions when broker renewal changes the lease credential before dispatch', async () => {
    const initialHandle = makeHandle('lease-old', 'access-old', 'account-old')
    const renewedHandle = makeHandle('lease-renewed', 'access-renewed', 'account-renewed')
    const authStorage = makeAuthStorage(credentialFromHandle(initialHandle))
    const closeStaleOpenAICodexWebSocketSession = vi.fn()
    const service = {
      isBrokerModeActive: vi.fn(async () => true),
      renewIfNeeded: vi.fn(async () => renewedHandle),
      applyLeaseToAuthStorage: vi.fn(async (storage: typeof authStorage, handle: OpenAIAuthBrokerLeaseHandle) => {
        storage.set('openai-codex', credentialFromHandle(handle))
        return handle
      }),
    }

    const controller = new OpenAIAuthBrokerRuntimeController({
      service: service as any,
      handle: initialHandle,
      getAuthStorage: () => authStorage,
      getProvider: () => 'openai-codex',
      retryPromptLater: vi.fn(),
      closeStaleOpenAICodexWebSocketSession,
      logRuntimeError: vi.fn(),
      reportRuntimeError: vi.fn(async () => undefined),
    })

    await controller.beforeDispatch()

    expect(service.renewIfNeeded).toHaveBeenCalledWith(initialHandle)
    expect(service.applyLeaseToAuthStorage).toHaveBeenCalledWith(authStorage, renewedHandle)
    expect(closeStaleOpenAICodexWebSocketSession).toHaveBeenCalledTimes(1)
    expect(closeStaleOpenAICodexWebSocketSession).toHaveBeenCalledWith('broker_lease_rotated')
  })

  it('closes cached OpenAI Codex websocket sessions when success reporting returns a replacement broker credential', async () => {
    const initialHandle = makeHandle('lease-old', 'access-old', 'account-old')
    const replacementHandle = makeHandle('lease-replacement', 'access-replacement', 'account-replacement')
    const authStorage = makeAuthStorage(credentialFromHandle(initialHandle))
    const closeStaleOpenAICodexWebSocketSession = vi.fn()
    const service = {
      report: vi.fn(async () => replacementHandle),
      applyLeaseToAuthStorage: vi.fn(async (storage: typeof authStorage, handle: OpenAIAuthBrokerLeaseHandle) => {
        storage.set('openai-codex', credentialFromHandle(handle))
        return handle
      }),
    }

    const controller = new OpenAIAuthBrokerRuntimeController({
      service: service as any,
      handle: initialHandle,
      getAuthStorage: () => authStorage,
      getProvider: () => 'openai-codex',
      retryPromptLater: vi.fn(),
      closeStaleOpenAICodexWebSocketSession,
      logRuntimeError: vi.fn(),
      reportRuntimeError: vi.fn(async () => undefined),
    })

    await controller.reportSuccess()

    expect(service.report).toHaveBeenCalledWith(initialHandle, 'success')
    expect(service.applyLeaseToAuthStorage).toHaveBeenCalledWith(authStorage, replacementHandle)
    expect(closeStaleOpenAICodexWebSocketSession).toHaveBeenCalledTimes(1)
    expect(closeStaleOpenAICodexWebSocketSession).toHaveBeenCalledWith('broker_lease_rotated')
  })
})
