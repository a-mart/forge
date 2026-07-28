/** @vitest-environment jsdom */

import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import {
  createSecureBrowserPairingRequest,
  encryptRemoteSecureValue,
} from './secure-browser-control-api'

const AAD_PREFIX = 'forge-secure-browser-private-entry:v1'

function makeClient(
  fetchImpl: SettingsApiClient['fetch'],
): SettingsApiClient {
  return {
    target: {
      kind: 'builder',
      label: 'Builder',
      description: 'Builder',
      wsUrl: 'ws://127.0.0.1:47187',
      apiBaseUrl: 'http://127.0.0.1:47187/',
      fetchCredentials: 'same-origin',
      requiresAdmin: false,
      availableTabs: [],
    },
    endpoint: (path) => path,
    fetch: fetchImpl,
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

beforeEach(() => {
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size
      },
    },
  })
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  })
  Object.defineProperty(window, 'crypto', {
    configurable: true,
    value: webcrypto,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('secure browser control API', () => {
  it('sends browser identity metadata but keeps the pairing credential in the response only', async () => {
    const fetch = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(init?.credentials).toBe('include')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        deviceId: expect.stringMatching(/^browser-/u),
        deviceName: expect.stringContaining('Forge browser'),
      })
      return new Response(JSON.stringify({
        requestId: 'pairing-1',
        verificationCode: '482913',
        claimSecret: 'one-use-claim-secret',
        expiresAt: '2026-07-28T16:10:00.000Z',
      }), { status: 201 })
    })

    await expect(
      createSecureBrowserPairingRequest(makeClient(fetch)),
    ).resolves.toMatchObject({
      verificationCode: '482913',
      claimSecret: 'one-use-claim-secret',
    })
  })

  it('encrypts private entry in WebCrypto before any value reaches the backend', async () => {
    const hostKey = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )
    const publicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', hostKey.publicKey),
    )
    const challenge = {
      challengeId: 'd3e39ee9-3dd2-46c6-b820-ae041d4bb088',
      keyId: 'remote-entry-key-id',
      publicKey: toBase64(publicKey),
      expiresAt: '2026-07-28T16:02:00.000Z',
    }
    const rawSecret = 'browser-plaintext-never-in-http'
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      expect(init?.credentials).toBe('include')
      if (path.endsWith('/challenge')) {
        expect(String(init?.body)).not.toContain(rawSecret)
        return new Response(JSON.stringify(challenge), { status: 200 })
      }
      const serialized = String(init?.body)
      expect(serialized).not.toContain(rawSecret)
      const sealed = JSON.parse(serialized) as {
        ephemeralPublicKey: string
        iv: string
        ciphertext: string
      }
      await expect(
        decryptBrowserEnvelope(hostKey.privateKey, challenge, sealed),
      ).resolves.toBe(rawSecret)
      return new Response(JSON.stringify({
        encryptedMaterial: 'desktop-safe-storage-ciphertext',
      }), { status: 200 })
    })

    await expect(
      encryptRemoteSecureValue(makeClient(fetch), rawSecret),
    ).resolves.toBe('desktop-safe-storage-ciphertext')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

async function decryptBrowserEnvelope(
  hostPrivateKey: CryptoKey,
  challenge: { challengeId: string; keyId: string },
  sealed: {
    ephemeralPublicKey: string
    iv: string
    ciphertext: string
  },
): Promise<string> {
  const ephemeralPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(fromBase64(sealed.ephemeralPublicKey)),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeralPublicKey },
    hostPrivateKey,
    256,
  ))
  const aad = new TextEncoder().encode(
    `${AAD_PREFIX}:${challenge.keyId}:${challenge.challengeId}`,
  )
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(shared),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: toArrayBuffer(aad),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(fromBase64(sealed.iv)),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      key,
      toArrayBuffer(fromBase64(sealed.ciphertext)),
    )
    return new TextDecoder().decode(plaintext)
  } finally {
    shared.fill(0)
    aad.fill(0)
  }
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(window.atob(value), (character) =>
    character.charCodeAt(0)
  )
}

function toBase64(value: Uint8Array): string {
  return window.btoa(String.fromCharCode(...value))
}
