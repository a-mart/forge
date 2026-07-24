import type { SecureVaultCipher } from "./electron-safe-storage-client.js";
import {
  SecureSourceError,
  type SecureSecretResolution,
  type SecureSecretSource,
} from "./host-only-secret.js";

export class LocalEncryptedSecretSource implements SecureSecretSource {
  readonly kind = "local_keychain" as const;

  constructor(private readonly cipher: SecureVaultCipher) {}

  async resolve(input: {
    sourceLocator: string;
    encryptedMaterial?: Uint8Array;
  }): Promise<SecureSecretResolution> {
    if (!input.encryptedMaterial || input.encryptedMaterial.byteLength === 0) {
      throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
    }
    const material = await this.cipher.decrypt(input.encryptedMaterial);
    return {
      material,
      sourceVersion: null,
      resolvedAt: new Date().toISOString(),
    };
  }
}
