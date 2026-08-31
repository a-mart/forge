/**
 * Desktop-only Secure Vault transfer contracts.
 *
 * The bundle contains authenticated ciphertext only. `transferCode` is a
 * short-lived user-carried decryption capability and must never be logged,
 * persisted, or projected into agent-visible state.
 */

export const SECURE_VAULT_TRANSFER_FORMAT = 'forge-secure-vault-transfer' as const
export const SECURE_VAULT_TRANSFER_VERSION = 1 as const
export const SECURE_VAULT_TRANSFER_ALGORITHM = 'aes-256-gcm' as const
export const SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES = 32 * 1024 * 1024

export interface SecureVaultTransferBundle {
  format: typeof SECURE_VAULT_TRANSFER_FORMAT
  version: typeof SECURE_VAULT_TRANSFER_VERSION
  algorithm: typeof SECURE_VAULT_TRANSFER_ALGORITHM
  createdAt: string
  itemCount: number
  nonce: string
  authTag: string
  ciphertext: string
}

export interface ExportSecureVaultTransferResult {
  bundle: SecureVaultTransferBundle
  /** Random 256-bit base64url key shown only for the active export flow. */
  transferCode: string
  localSecretCount: number
  providerCredentialCount: number
}

export interface ImportSecureVaultTransferRequest {
  bundle: SecureVaultTransferBundle
  transferCode: string
}

export interface ImportSecureVaultTransferResult {
  importedItemCount: number
  localSecretCount: number
  providerCredentialCount: number
}
