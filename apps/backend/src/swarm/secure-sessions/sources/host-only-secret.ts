import { inspect } from "node:util";

/**
 * A deliberately non-serializable, explicitly releasable secret value.
 *
 * This is not a magic memory-protection primitive. It makes the safe ownership
 * contract visible in types and prevents accidental JSON/log projection. The
 * callback must not retain the provided Buffer.
 */
export class HostOnlySecret {
  #bytes: Buffer | null;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength === 0) {
      throw new SecureSourceError("SECURE_SECRET_EMPTY");
    }
    this.#bytes = Buffer.from(bytes);
  }

  get released(): boolean {
    return this.#bytes === null;
  }

  async withBytes<T>(callback: (bytes: Buffer) => T | Promise<T>): Promise<T> {
    const bytes = this.#bytes;
    if (!bytes) {
      throw new SecureSourceError("SECURE_SECRET_RELEASED");
    }
    return callback(bytes);
  }

  release(): void {
    const bytes = this.#bytes;
    this.#bytes = null;
    bytes?.fill(0);
  }

  toJSON(): never {
    throw new SecureSourceError("SECURE_SECRET_SERIALIZATION_BLOCKED");
  }

  [inspect.custom](): string {
    return "[HostOnlySecret]";
  }
}

export type SecureSourceErrorCode =
  | "SECURE_SECRET_EMPTY"
  | "SECURE_SECRET_RELEASED"
  | "SECURE_SECRET_SERIALIZATION_BLOCKED"
  | "SECURE_SOURCE_UNAVAILABLE"
  | "SECURE_SOURCE_LOCKED"
  | "SECURE_SOURCE_NOT_FOUND"
  | "SECURE_SOURCE_AUTH_REQUIRED"
  | "SECURE_SOURCE_RESPONSE_INVALID"
  | "SECURE_SOURCE_TIMEOUT";

export class SecureSourceError extends Error {
  constructor(
    readonly code: SecureSourceErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "SecureSourceError";
  }
}

export interface SecureSecretResolution {
  readonly material: HostOnlySecret;
  readonly sourceVersion: string | null;
  readonly resolvedAt: string;
}

export interface SecureSecretSource {
  readonly kind: "local_keychain" | "bitwarden_secrets_manager";
  resolve(input: {
    sourceLocator: string;
    encryptedCredential?: Uint8Array;
    encryptedMaterial?: Uint8Array;
    endpointOrigin?: string | null;
    signal?: AbortSignal;
  }): Promise<SecureSecretResolution>;
}
