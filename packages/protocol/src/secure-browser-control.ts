export const SECURE_BROWSER_CONTROL_SCOPES = [
  'secure-sessions:control',
  'secure-secrets:write',
  'private-entry:write',
] as const

export type SecureBrowserControlScope =
  (typeof SECURE_BROWSER_CONTROL_SCOPES)[number]

export interface SecureBrowserPairingRequestInput {
  deviceId: string
  deviceName: string
}

export interface SecureBrowserPairingRequestCreated {
  requestId: string
  verificationCode: string
  claimSecret: string
  expiresAt: string
}

export interface SecureBrowserPairingClaimRequest {
  claimSecret: string
}

export type SecureBrowserPairingClaimResponse =
  | { status: 'pending' }
  | { status: 'denied' }
  | {
      status: 'approved'
      device: SecureBrowserDeviceDescriptor
      scopes: SecureBrowserControlScope[]
    }

export interface SecureBrowserPendingPairingDescriptor {
  requestId: string
  deviceId: string
  deviceName: string
  verificationCode: string
  createdAt: string
  expiresAt: string
}

export interface SecureBrowserDeviceDescriptor {
  id: string
  deviceId: string
  deviceName: string
  createdAt: string
  lastUsedAt?: string
  revokedAt?: string
}

export interface SecureBrowserSettingsSnapshot {
  pendingRequests: SecureBrowserPendingPairingDescriptor[]
  devices: SecureBrowserDeviceDescriptor[]
}

export interface SecureBrowserControlStatus {
  available: boolean
  authorized: boolean
  privateEntryAvailable: boolean
  secureContextRequired: boolean
  /**
   * HTTPS browsers encrypt a private value before it reaches the Builder
   * backend. Trusted HTTP browser entry is intended for a known private
   * network and is sealed directly by the paired Forge Desktop vault.
   */
  privateEntryTransport?: 'browser_encrypted' | 'trusted_http'
  device?: SecureBrowserDeviceDescriptor
}

/**
 * A one-use P-256 public-key challenge owned by Electron main. The backend
 * never receives the private key or the value that will be sealed to it.
 */
export interface SecureBrowserPrivateEntryChallenge {
  challengeId: string
  keyId: string
  publicKey: string
  expiresAt: string
}

/**
 * Browser-produced AES-GCM envelope. Every byte here is ciphertext or public
 * key material and is safe to relay through the Builder backend.
 */
export interface SecureBrowserSealedPrivateEntry {
  challengeId: string
  keyId: string
  ephemeralPublicKey: string
  iv: string
  ciphertext: string
}

export interface SecureBrowserEncryptedPrivateEntry {
  encryptedMaterial: string
}
