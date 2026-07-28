import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import type {
  SecureBrowserControlStatus,
  SecureBrowserEncryptedPrivateEntry,
  SecureBrowserPairingClaimResponse,
  SecureBrowserPairingRequestCreated,
  SecureBrowserPrivateEntryChallenge,
  SecureBrowserSealedPrivateEntry,
  SecureBrowserSettingsSnapshot,
} from '@forge/protocol'

const ROOT = '/api/secure-browser-control'
const SETTINGS_ROOT = '/api/settings/secure-browsers'
const DEVICE_ID_KEY = 'forge.secure-browser.device-id'
const REMOTE_ENTRY_AAD_PREFIX = 'forge-secure-browser-private-entry:v1'

export async function fetchSecureBrowserControlStatus(
  apiClient: SettingsApiClient,
): Promise<SecureBrowserControlStatus> {
  const status = await requestJson<SecureBrowserControlStatus>(
    apiClient,
    `${ROOT}/status`,
  )
  return {
    ...status,
    privateEntryAvailable:
      status.privateEntryAvailable && isRemotePrivateEntryCapable(),
    secureContextRequired: !isSecureBrowserContext(),
  }
}

export async function createSecureBrowserPairingRequest(
  apiClient: SettingsApiClient,
): Promise<SecureBrowserPairingRequestCreated> {
  if (!isSecureBrowserContext()) {
    throw new Error('Remote secure control requires HTTPS.')
  }
  return await requestJson<SecureBrowserPairingRequestCreated>(
    apiClient,
    `${ROOT}/pairing/requests`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        deviceId: getOrCreateDeviceId(),
        deviceName: describeBrowser(),
      }),
    },
  )
}

export async function claimSecureBrowserPairing(
  apiClient: SettingsApiClient,
  requestId: string,
  claimSecret: string,
): Promise<SecureBrowserPairingClaimResponse> {
  return await requestJson<SecureBrowserPairingClaimResponse>(
    apiClient,
    `${ROOT}/pairing/requests/${encodeURIComponent(requestId)}/claim`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ claimSecret }),
    },
  )
}

export async function encryptRemoteSecureValue(
  apiClient: SettingsApiClient,
  value: string,
): Promise<string> {
  const challenge = await requestJson<SecureBrowserPrivateEntryChallenge>(
    apiClient,
    `${ROOT}/private-entry/challenge`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    },
  )
  const sealed = await sealPrivateEntry(value, challenge)
  const encrypted = await requestJson<SecureBrowserEncryptedPrivateEntry>(
    apiClient,
    `${ROOT}/private-entry/encrypt`,
    {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(sealed),
    },
  )
  return encrypted.encryptedMaterial
}

export async function fetchSecureBrowserSettings(
  apiClient: SettingsApiClient,
): Promise<SecureBrowserSettingsSnapshot> {
  return await requestJson<SecureBrowserSettingsSnapshot>(
    apiClient,
    SETTINGS_ROOT,
    withDesktopControl(),
  )
}

export async function decideSecureBrowserPairing(
  apiClient: SettingsApiClient,
  requestId: string,
  decision: 'approve' | 'deny',
): Promise<void> {
  await requestJson(
    apiClient,
    `${SETTINGS_ROOT}/requests/${encodeURIComponent(requestId)}/${decision}`,
    {
      ...withDesktopControl(),
      method: 'POST',
      headers: jsonHeaders(withDesktopControl()?.headers),
      body: '{}',
    },
  )
}

export async function revokeSecureBrowserDevice(
  apiClient: SettingsApiClient,
  deviceId: string,
): Promise<void> {
  await requestJson(
    apiClient,
    `${SETTINGS_ROOT}/devices/${encodeURIComponent(deviceId)}`,
    {
      ...withDesktopControl(),
      method: 'DELETE',
      headers: jsonHeaders(withDesktopControl()?.headers),
    },
  )
}

export function isSecureBrowserContext(): boolean {
  if (typeof window === 'undefined') return false
  return window.isSecureContext
    || window.location.hostname === 'localhost'
    || window.location.hostname === '127.0.0.1'
    || window.location.hostname === '::1'
}

function isRemotePrivateEntryCapable(): boolean {
  return isSecureBrowserContext()
    && typeof globalThis.crypto?.subtle?.deriveKey === 'function'
}

async function sealPrivateEntry(
  value: string,
  challenge: SecureBrowserPrivateEntryChallenge,
): Promise<SecureBrowserSealedPrivateEntry> {
  const publicKeyBytes = fromBase64(challenge.publicKey)
  const plaintext = new TextEncoder().encode(value)
  const additionalData = new TextEncoder().encode(
    `${REMOTE_ENTRY_AAD_PREFIX}:${challenge.keyId}:${challenge.challengeId}`,
  )
  let sharedBits: ArrayBuffer | null = null
  try {
    const hostPublicKey = await crypto.subtle.importKey(
      'raw',
      toArrayBuffer(publicKeyBytes),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    )
    sharedBits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: hostPublicKey },
      ephemeral.privateKey,
      256,
    )
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      sharedBits,
      'HKDF',
      false,
      ['deriveKey'],
    )
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info: toArrayBuffer(additionalData),
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(additionalData),
        tagLength: 128,
      },
      aesKey,
      toArrayBuffer(plaintext),
    ))
    const ephemeralPublicKey = new Uint8Array(
      await crypto.subtle.exportKey('raw', ephemeral.publicKey),
    )
    return {
      challengeId: challenge.challengeId,
      keyId: challenge.keyId,
      ephemeralPublicKey: toBase64(ephemeralPublicKey),
      iv: toBase64(iv),
      ciphertext: toBase64(ciphertext),
    }
  } finally {
    publicKeyBytes.fill(0)
    plaintext.fill(0)
    additionalData.fill(0)
    if (sharedBits) new Uint8Array(sharedBits).fill(0)
  }
}

async function requestJson<T = unknown>(
  apiClient: SettingsApiClient,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await apiClient.fetch(path, {
    ...init,
    cache: 'no-store',
    credentials: 'include',
  })
  if (!response.ok) throw new Error(`Secure browser request failed (${response.status}).`)
  return await response.json() as T
}

function withDesktopControl(): RequestInit | undefined {
  const token = typeof window === 'undefined'
    ? undefined
    : window.electronBridge?.secureControlToken
  if (!token) return undefined
  return { headers: { 'X-Forge-Secure-Control': token } }
}

function jsonHeaders(existing?: HeadersInit): Headers {
  const headers = new Headers(existing)
  headers.set('Content-Type', 'application/json')
  return headers
}

function getOrCreateDeviceId(): string {
  const existing = window.localStorage.getItem(DEVICE_ID_KEY)
  if (existing && /^[A-Za-z0-9._:-]{8,160}$/u.test(existing)) return existing
  const created = `browser-${crypto.randomUUID()}`
  window.localStorage.setItem(DEVICE_ID_KEY, created)
  return created
}

function describeBrowser(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform
    || navigator.platform
  return platform ? `Forge browser on ${platform}` : 'Forge browser'
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}

function fromBase64(value: string): Uint8Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function toBase64(value: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < value.byteLength; index += 1) {
    binary += String.fromCharCode(value[index])
  }
  return window.btoa(binary)
}
