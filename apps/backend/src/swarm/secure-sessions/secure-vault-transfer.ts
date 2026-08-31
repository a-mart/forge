import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  SECURE_VAULT_TRANSFER_ALGORITHM,
  SECURE_VAULT_TRANSFER_FORMAT,
  SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES,
  SECURE_VAULT_TRANSFER_VERSION,
  type ExportSecureVaultTransferResult,
  type SecureVaultTransferBundle,
} from "@forge/protocol";
import type { HostOnlySecret } from "./sources/host-only-secret.js";

const TRANSFER_KEY_BYTES = 32;
const TRANSFER_NONCE_BYTES = 12;
const TRANSFER_AUTH_TAG_BYTES = 16;
const TRANSFER_DIGEST_BYTES = 32;
const TRANSFER_PAYLOAD_MAGIC = Buffer.from("FSVT0001", "ascii");
const TRANSFER_PAYLOAD_HEADER_BYTES = TRANSFER_PAYLOAD_MAGIC.byteLength + 4;
const TRANSFER_RECORD_HEADER_BYTES = 1 + 2 + 4 + TRANSFER_DIGEST_BYTES;
const MAX_TRANSFER_ITEMS = 512;
const MAX_TRANSFER_RECORD_ID_BYTES = 256;
const MAX_TRANSFER_ITEM_BYTES = 256 * 1024;

export type SecureVaultTransferItemKind =
  | "local_secret"
  | "provider_credential";

export interface SecureVaultTransferSourceItem {
  kind: SecureVaultTransferItemKind;
  recordId: string;
  expectedCiphertext: Uint8Array;
  resolveMaterial(): Promise<HostOnlySecret>;
}

export interface OpenSecureVaultTransferItem {
  kind: SecureVaultTransferItemKind;
  recordId: string;
  /** View into the bounded decrypted payload; callers must not retain it. */
  expectedCiphertextDigest: Buffer;
  /** View into the bounded decrypted payload; callers must not retain it. */
  material: Buffer;
}

export type SecureVaultTransferErrorCode =
  | "empty"
  | "invalid"
  | "too_large";

export class SecureVaultTransferError extends Error {
  constructor(readonly code: SecureVaultTransferErrorCode) {
    super(`Secure Vault transfer ${code}`);
    this.name = "SecureVaultTransferError";
  }
}

export async function createSecureVaultTransfer(
  items: readonly SecureVaultTransferSourceItem[],
  createdAt: string,
): Promise<ExportSecureVaultTransferResult> {
  if (items.length === 0) throw new SecureVaultTransferError("empty");
  if (items.length > MAX_TRANSFER_ITEMS) {
    throw new SecureVaultTransferError("too_large");
  }
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new SecureVaultTransferError("invalid");
  }

  const key = randomBytes(TRANSFER_KEY_BYTES);
  const nonce = randomBytes(TRANSFER_NONCE_BYTES);
  const aad = createTransferAad(createdAt, items.length);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TRANSFER_AUTH_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const ciphertextChunks: Buffer[] = [];
  let encryptedBytes = 0;
  let plaintextBytes = 0;
  let localSecretCount = 0;
  let providerCredentialCount = 0;

  const encryptChunk = (chunk: Uint8Array): void => {
    plaintextBytes += chunk.byteLength;
    if (plaintextBytes > SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES) {
      throw new SecureVaultTransferError("too_large");
    }
    const encrypted = cipher.update(chunk);
    if (encrypted.byteLength > 0) {
      encryptedBytes += encrypted.byteLength;
      ciphertextChunks.push(encrypted);
    }
  };

  try {
    const payloadHeader = Buffer.alloc(TRANSFER_PAYLOAD_HEADER_BYTES);
    TRANSFER_PAYLOAD_MAGIC.copy(payloadHeader, 0);
    payloadHeader.writeUInt32BE(items.length, TRANSFER_PAYLOAD_MAGIC.byteLength);
    try {
      encryptChunk(payloadHeader);
    } finally {
      payloadHeader.fill(0);
    }

    for (const item of items) {
      const idBytes = Buffer.from(item.recordId, "utf8");
      if (
        idBytes.byteLength === 0
        || idBytes.byteLength > MAX_TRANSFER_RECORD_ID_BYTES
        || item.recordId.includes("\0")
        || item.expectedCiphertext.byteLength === 0
      ) {
        idBytes.fill(0);
        throw new SecureVaultTransferError("invalid");
      }
      const material = await item.resolveMaterial();
      try {
        await material.withBytes((bytes) => {
          if (
            bytes.byteLength === 0
            || bytes.byteLength > MAX_TRANSFER_ITEM_BYTES
          ) {
            throw new SecureVaultTransferError("too_large");
          }
          const recordHeader = Buffer.alloc(TRANSFER_RECORD_HEADER_BYTES);
          const digest = createHash("sha256")
            .update(item.expectedCiphertext)
            .digest();
          try {
            recordHeader.writeUInt8(itemKindCode(item.kind), 0);
            recordHeader.writeUInt16BE(idBytes.byteLength, 1);
            recordHeader.writeUInt32BE(bytes.byteLength, 3);
            digest.copy(recordHeader, 7);
            encryptChunk(recordHeader);
            encryptChunk(idBytes);
            encryptChunk(bytes);
          } finally {
            digest.fill(0);
            recordHeader.fill(0);
          }
        });
      } finally {
        material.release();
        idBytes.fill(0);
      }
      if (item.kind === "local_secret") localSecretCount += 1;
      else providerCredentialCount += 1;
    }

    const finalChunk = cipher.final();
    if (finalChunk.byteLength > 0) {
      encryptedBytes += finalChunk.byteLength;
      ciphertextChunks.push(finalChunk);
    }
    if (encryptedBytes > SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES) {
      throw new SecureVaultTransferError("too_large");
    }
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat(ciphertextChunks, encryptedBytes);
    const transferCode = key.toString("base64url");
    try {
      return {
        bundle: {
          format: SECURE_VAULT_TRANSFER_FORMAT,
          version: SECURE_VAULT_TRANSFER_VERSION,
          algorithm: SECURE_VAULT_TRANSFER_ALGORITHM,
          createdAt,
          itemCount: items.length,
          nonce: nonce.toString("base64url"),
          authTag: authTag.toString("base64url"),
          ciphertext: ciphertext.toString("base64"),
        },
        transferCode,
        localSecretCount,
        providerCredentialCount,
      };
    } finally {
      authTag.fill(0);
      ciphertext.fill(0);
    }
  } finally {
    key.fill(0);
    nonce.fill(0);
    aad.fill(0);
    for (const chunk of ciphertextChunks) chunk.fill(0);
  }
}

/**
 * Opens a transfer bundle only for the duration of `operation`, then wipes the
 * complete decrypted payload. Item buffers are views and must not be retained.
 */
export async function withOpenSecureVaultTransfer<T>(
  bundle: SecureVaultTransferBundle,
  transferCode: string,
  operation: (items: readonly OpenSecureVaultTransferItem[]) => Promise<T>,
): Promise<T> {
  validateBundle(bundle);
  const key = decodeTransferCode(transferCode);
  const nonce = decodeCanonicalBase64Url(bundle.nonce, TRANSFER_NONCE_BYTES);
  const authTag = decodeCanonicalBase64Url(
    bundle.authTag,
    TRANSFER_AUTH_TAG_BYTES,
  );
  const ciphertext = decodeCanonicalBase64(
    bundle.ciphertext,
    SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES,
  );
  const aad = createTransferAad(bundle.createdAt, bundle.itemCount);
  let plaintext: Buffer | null = null;
  try {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
        authTagLength: TRANSFER_AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const updated = decipher.update(ciphertext);
      const final = decipher.final();
      plaintext = Buffer.concat([updated, final], updated.byteLength + final.byteLength);
      updated.fill(0);
      final.fill(0);
    } catch {
      throw new SecureVaultTransferError("invalid");
    }
    if (plaintext.byteLength > SECURE_VAULT_TRANSFER_MAX_CIPHERTEXT_BYTES) {
      throw new SecureVaultTransferError("too_large");
    }
    const items = parseTransferPayload(plaintext, bundle.itemCount);
    return await operation(items);
  } finally {
    plaintext?.fill(0);
    key.fill(0);
    nonce.fill(0);
    authTag.fill(0);
    ciphertext.fill(0);
    aad.fill(0);
  }
}

function parseTransferPayload(
  payload: Buffer,
  expectedItemCount: number,
): OpenSecureVaultTransferItem[] {
  if (payload.byteLength < TRANSFER_PAYLOAD_HEADER_BYTES) {
    throw new SecureVaultTransferError("invalid");
  }
  if (!payload.subarray(0, TRANSFER_PAYLOAD_MAGIC.byteLength).equals(
    TRANSFER_PAYLOAD_MAGIC,
  )) {
    throw new SecureVaultTransferError("invalid");
  }
  const itemCount = payload.readUInt32BE(TRANSFER_PAYLOAD_MAGIC.byteLength);
  if (itemCount !== expectedItemCount || itemCount > MAX_TRANSFER_ITEMS) {
    throw new SecureVaultTransferError("invalid");
  }

  const items: OpenSecureVaultTransferItem[] = [];
  const seen = new Set<string>();
  let offset = TRANSFER_PAYLOAD_HEADER_BYTES;
  for (let index = 0; index < itemCount; index += 1) {
    if (offset + TRANSFER_RECORD_HEADER_BYTES > payload.byteLength) {
      throw new SecureVaultTransferError("invalid");
    }
    const kind = itemKindFromCode(payload.readUInt8(offset));
    const idLength = payload.readUInt16BE(offset + 1);
    const materialLength = payload.readUInt32BE(offset + 3);
    const digestStart = offset + 7;
    const digestEnd = digestStart + TRANSFER_DIGEST_BYTES;
    offset += TRANSFER_RECORD_HEADER_BYTES;
    if (
      idLength === 0
      || idLength > MAX_TRANSFER_RECORD_ID_BYTES
      || materialLength === 0
      || materialLength > MAX_TRANSFER_ITEM_BYTES
      || offset + idLength + materialLength > payload.byteLength
    ) {
      throw new SecureVaultTransferError("invalid");
    }
    const idBytes = payload.subarray(offset, offset + idLength);
    offset += idLength;
    const recordId = idBytes.toString("utf8");
    if (
      recordId.includes("\0")
      || !Buffer.from(recordId, "utf8").equals(idBytes)
      || seen.has(`${kind}:${recordId}`)
    ) {
      throw new SecureVaultTransferError("invalid");
    }
    seen.add(`${kind}:${recordId}`);
    const material = payload.subarray(offset, offset + materialLength);
    offset += materialLength;
    items.push({
      kind,
      recordId,
      expectedCiphertextDigest: payload.subarray(digestStart, digestEnd),
      material,
    });
  }
  if (offset !== payload.byteLength) {
    throw new SecureVaultTransferError("invalid");
  }
  return items;
}

function validateBundle(bundle: SecureVaultTransferBundle): void {
  if (
    bundle.format !== SECURE_VAULT_TRANSFER_FORMAT
    || bundle.version !== SECURE_VAULT_TRANSFER_VERSION
    || bundle.algorithm !== SECURE_VAULT_TRANSFER_ALGORITHM
    || typeof bundle.createdAt !== "string"
    || bundle.createdAt.length > 64
    || !Number.isFinite(Date.parse(bundle.createdAt))
    || !Number.isSafeInteger(bundle.itemCount)
    || bundle.itemCount <= 0
    || bundle.itemCount > MAX_TRANSFER_ITEMS
  ) {
    throw new SecureVaultTransferError("invalid");
  }
}

function createTransferAad(createdAt: string, itemCount: number): Buffer {
  return Buffer.from(JSON.stringify([
    SECURE_VAULT_TRANSFER_FORMAT,
    SECURE_VAULT_TRANSFER_VERSION,
    SECURE_VAULT_TRANSFER_ALGORITHM,
    createdAt,
    itemCount,
  ]), "utf8");
}

function decodeTransferCode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new SecureVaultTransferError("invalid");
  }
  return decodeCanonicalBase64Url(value, TRANSFER_KEY_BYTES);
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.byteLength !== expectedBytes
    || decoded.toString("base64url") !== value
  ) {
    decoded.fill(0);
    throw new SecureVaultTransferError("invalid");
  }
  return decoded;
}

function decodeCanonicalBase64(value: string, maxBytes: number): Buffer {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new SecureVaultTransferError("invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0
    || decoded.byteLength > maxBytes
    || decoded.toString("base64") !== value
  ) {
    decoded.fill(0);
    throw new SecureVaultTransferError("invalid");
  }
  return decoded;
}

function itemKindCode(kind: SecureVaultTransferItemKind): number {
  return kind === "local_secret" ? 1 : 2;
}

function itemKindFromCode(code: number): SecureVaultTransferItemKind {
  if (code === 1) return "local_secret";
  if (code === 2) return "provider_credential";
  throw new SecureVaultTransferError("invalid");
}
