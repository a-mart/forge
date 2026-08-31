import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  SECURE_VAULT_TRANSFER_ALGORITHM,
  SECURE_VAULT_TRANSFER_FORMAT,
  SECURE_VAULT_TRANSFER_VERSION,
  type ExportSecureVaultTransferResult,
  type ImportSecureVaultTransferRequest,
  type SecureVaultTransferBundle,
} from '../index.js'

describe('Secure Vault transfer protocol', () => {
  it('exports one versioned authenticated-ciphertext format', () => {
    expect(SECURE_VAULT_TRANSFER_FORMAT).toBe('forge-secure-vault-transfer')
    expect(SECURE_VAULT_TRANSFER_VERSION).toBe(1)
    expect(SECURE_VAULT_TRANSFER_ALGORITHM).toBe('aes-256-gcm')

    const bundle = {
      format: SECURE_VAULT_TRANSFER_FORMAT,
      version: SECURE_VAULT_TRANSFER_VERSION,
      algorithm: SECURE_VAULT_TRANSFER_ALGORITHM,
      createdAt: '2026-08-31T12:00:00.000Z',
      itemCount: 2,
      nonce: 'nonce',
      authTag: 'tag',
      ciphertext: 'ciphertext',
    } satisfies SecureVaultTransferBundle
    const exported = {
      bundle,
      transferCode: 'one-time-code',
      localSecretCount: 1,
      providerCredentialCount: 1,
    } satisfies ExportSecureVaultTransferResult
    const imported = {
      bundle,
      transferCode: exported.transferCode,
    } satisfies ImportSecureVaultTransferRequest

    expect(imported.bundle.itemCount).toBe(2)
  })

  it('has no plaintext value or provider locator field', () => {
    type ForbiddenField =
      | 'value'
      | 'secretValue'
      | 'plaintext'
      | 'sourceLocator'
      | 'accessToken'
    type ExposedField = Extract<
      | keyof SecureVaultTransferBundle
      | keyof ExportSecureVaultTransferResult
      | keyof ImportSecureVaultTransferRequest,
      ForbiddenField
    >

    expectTypeOf<ExposedField>().toEqualTypeOf<never>()
  })
})
