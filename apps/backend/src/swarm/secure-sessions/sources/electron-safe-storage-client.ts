import { randomUUID } from "node:crypto";
import { HostOnlySecret, SecureSourceError } from "./host-only-secret.js";

const REQUEST_TYPE = "secure_vault_request";
const RESPONSE_TYPE = "secure_vault_response";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BYTES = 512 * 1024;

type SecureVaultOperation = "status" | "encrypt" | "decrypt";

type SecureVaultResponse =
  | {
      type: typeof RESPONSE_TYPE;
      requestId: string;
      ok: true;
      result:
        | { available: true }
        | { payload: string; reEncryptedPayload?: string };
    }
  | {
      type: typeof RESPONSE_TYPE;
      requestId: string;
      ok: false;
      errorCode: string;
    };

export interface SecureVaultCipher {
  status(): Promise<{ available: true }>;
  encrypt(bytes: Uint8Array, requestId?: string): Promise<Buffer>;
  decrypt(
    ciphertext: Uint8Array,
    requestId?: string,
  ): Promise<SecureVaultDecryption>;
}

export interface SecureVaultDecryption {
  readonly material: HostOnlySecret;
  readonly reEncryptedCiphertext?: Buffer;
}

interface PendingRequest {
  readonly operation: SecureVaultOperation;
  readonly resolve: (response: SecureVaultResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

/**
 * Host-only request client for Electron main's safeStorage owner.
 *
 * The backend is a forked Electron child in desktop mode. Standalone/web
 * backends intentionally report the secure vault unavailable instead of
 * falling back to a weak local key.
 */
export class ElectronSafeStorageClient implements SecureVaultCipher {
  private readonly pending = new Map<string, PendingRequest>();
  private listening = false;

  constructor(
    private readonly transport: Pick<NodeJS.Process, "send" | "on" | "off"> = process,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async status(): Promise<{ available: true }> {
    const response = await this.request("status");
    if (!response.ok) throw mapVaultError(response.errorCode);
    if (!("available" in response.result) || response.result.available !== true) {
      throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
    }
    return { available: true };
  }

  async encrypt(bytes: Uint8Array, requestId = randomUUID()): Promise<Buffer> {
    const response = await this.request("encrypt", Buffer.from(bytes).toString("base64"), requestId);
    if (!response.ok) throw mapVaultError(response.errorCode);
    return decodePayload(response.result, MAX_CIPHERTEXT_BYTES);
  }

  async decrypt(
    ciphertext: Uint8Array,
    requestId = randomUUID(),
  ): Promise<SecureVaultDecryption> {
    const response = await this.request(
      "decrypt",
      Buffer.from(ciphertext).toString("base64"),
      requestId,
    );
    if (!response.ok) throw mapVaultError(response.errorCode);
    const bytes = decodePayload(response.result, MAX_PLAINTEXT_BYTES);
    let reEncryptedCiphertext: Buffer | undefined;
    try {
      reEncryptedCiphertext = "reEncryptedPayload" in response.result
        && response.result.reEncryptedPayload !== undefined
        ? decodeCanonicalPayload(
            response.result.reEncryptedPayload,
            MAX_CIPHERTEXT_BYTES,
          )
        : undefined;
      return {
        material: new HostOnlySecret(bytes),
        ...(reEncryptedCiphertext ? { reEncryptedCiphertext } : {}),
      };
    } catch (error) {
      reEncryptedCiphertext?.fill(0);
      throw error;
    } finally {
      bytes.fill(0);
    }
  }

  dispose(): void {
    if (this.listening) {
      this.transport.off("message", this.handleMessage);
      this.listening = false;
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new SecureSourceError("SECURE_SOURCE_UNAVAILABLE"));
    }
    this.pending.clear();
  }

  private async request(
    operation: SecureVaultOperation,
    payload?: string,
    requestId = randomUUID(),
  ): Promise<SecureVaultResponse> {
    if (typeof this.transport.send !== "function") {
      throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId) || this.pending.has(requestId)) {
      throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
    }

    this.ensureListening();

    return new Promise<SecureVaultResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SecureSourceError("SECURE_SOURCE_TIMEOUT"));
      }, this.timeoutMs);
      timeout.unref?.();

      this.pending.set(requestId, { operation, resolve, reject, timeout });

      const request = {
        type: REQUEST_TYPE,
        requestId,
        operation,
        ...(payload === undefined ? {} : { payload }),
      };

      try {
        this.transport.send?.(request, (error: Error | null) => {
          if (!error) return;
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          clearTimeout(pending.timeout);
          pending.reject(new SecureSourceError("SECURE_SOURCE_UNAVAILABLE", { cause: error }));
        });
      } catch (error) {
        const pending = this.pending.get(requestId);
        if (pending) {
          this.pending.delete(requestId);
          clearTimeout(pending.timeout);
        }
        reject(new SecureSourceError("SECURE_SOURCE_UNAVAILABLE", { cause: error }));
      }
    });
  }

  private ensureListening(): void {
    if (this.listening) return;
    this.transport.on("message", this.handleMessage);
    this.listening = true;
  }

  private readonly handleMessage = (value: unknown): void => {
    const response = parseResponse(value);
    if (!response) return;
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(response);
  };
}

function parseResponse(value: unknown): SecureVaultResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (
    response.type !== RESPONSE_TYPE ||
    typeof response.requestId !== "string" ||
    typeof response.ok !== "boolean"
  ) {
    return null;
  }

  if (response.ok) {
    const result = response.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    const record = result as Record<string, unknown>;
    if (record.available === true && Object.keys(record).length === 1) {
      return {
        type: RESPONSE_TYPE,
        requestId: response.requestId,
        ok: true,
        result: { available: true },
      };
    }
    if (
      typeof record.payload === "string"
      && (
        Object.keys(record).length === 1
        || (
          Object.keys(record).length === 2
          && typeof record.reEncryptedPayload === "string"
        )
      )
    ) {
      return {
        type: RESPONSE_TYPE,
        requestId: response.requestId,
        ok: true,
        result: {
          payload: record.payload,
          ...(typeof record.reEncryptedPayload === "string"
            ? { reEncryptedPayload: record.reEncryptedPayload }
            : {}),
        },
      };
    }
    return null;
  }

  if (typeof response.errorCode !== "string") return null;
  return {
    type: RESPONSE_TYPE,
    requestId: response.requestId,
    ok: false,
    errorCode: response.errorCode,
  };
}

function decodePayload(
  result: { available: true } | { payload: string },
  maxBytes: number,
): Buffer {
  if (!("payload" in result)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return decodeCanonicalPayload(result.payload, maxBytes);
}

function decodeCanonicalPayload(value: string, maxBytes: number): Buffer {
  if (
    value.length > Math.ceil(maxBytes / 3) * 4
    || !isCanonicalBase64(value)
  ) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxBytes) {
    decoded.fill(0);
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return decoded;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value;
}

function mapVaultError(code: string): SecureSourceError {
  switch (code) {
    case "SECURE_VAULT_STORAGE_UNAVAILABLE":
    case "SECURE_VAULT_INSECURE_STORAGE":
      return new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
    case "SECURE_VAULT_DECRYPT_FAILED":
      return new SecureSourceError("SECURE_SOURCE_LOCKED");
    default:
      return new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
}
