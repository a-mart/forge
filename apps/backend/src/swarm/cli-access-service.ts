import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import type {
  CliAccessKeyCreatedResponse,
  CliAccessKeyDescriptor,
  CliAccessKeyLastUsedSource,
} from "@forge/protocol";
import { getCliAccessFilePath, getLegacyCliAccessFilePath } from "./data-paths.js";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/atomic-files.js";

const CLI_ACCESS_FILE_VERSION = 1;
const GENERATED_KEY_PREFIX = "forge_cli_";
const GENERATED_KEY_BYTES = 32;
const MAX_KEY_NAME_LENGTH = 120;

interface StoredCliAccessFile {
  version: number;
  keys: StoredCliAccessKey[];
}

interface StoredCliAccessKey {
  id: string;
  name?: string;
  keyHash: string;
  createdAt: string;
  lastUsedAt?: string;
  lastUsedSource?: CliAccessKeyLastUsedSource;
  revokedAt?: string;
}

export type CliAccessAuthSource = "env" | "stored";

export type CliAccessAuthResult =
  | { ok: true; keyId: string; source: CliAccessAuthSource }
  | {
      ok: false;
      statusCode: 401 | 403;
      code: "missing_authorization" | "malformed_authorization" | "invalid_token" | "revoked_token";
      message: string;
    };

export interface CliAccessServiceOptions {
  dataDir: string;
  envApiKey?: string;
  now?: () => string;
  generateKeyBytes?: () => Buffer;
  generateId?: () => string;
}

export class CliAccessService {
  private readonly filePath: string;
  private readonly legacyFilePath: string;
  private readonly envApiKey: string | undefined;
  private readonly now: () => string;
  private readonly generateKeyBytes: () => Buffer;
  private readonly generateId: () => string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: CliAccessServiceOptions) {
    this.filePath = getCliAccessFilePath(options.dataDir);
    this.legacyFilePath = getLegacyCliAccessFilePath(options.dataDir);
    this.envApiKey = normalizeSecret(options.envApiKey);
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateKeyBytes = options.generateKeyBytes ?? (() => randomBytes(GENERATED_KEY_BYTES));
    this.generateId = options.generateId ?? (() => `cli_key_${randomUUID()}`);
  }

  async listKeys(): Promise<CliAccessKeyDescriptor[]> {
    const file = await this.readFile();
    return file.keys.map(toDescriptor);
  }

  async generateKey(input: { name?: string } = {}): Promise<CliAccessKeyCreatedResponse> {
    const plaintextKey = `${GENERATED_KEY_PREFIX}${this.generateKeyBytes().toString("base64url")}`;
    const storedKey: StoredCliAccessKey = {
      id: this.generateId(),
      ...normalizeNameProperty(input.name),
      keyHash: hashSecret(plaintextKey),
      createdAt: this.now(),
    };

    await this.updateFile((file) => ({
      ...file,
      keys: [storedKey, ...file.keys.filter((key) => key.id !== storedKey.id)],
    }));

    return {
      key: toDescriptor(storedKey),
      plaintextKey,
    };
  }

  async revokeKey(keyId: string): Promise<CliAccessKeyDescriptor | null> {
    let revoked: StoredCliAccessKey | null = null;
    await this.updateFile((file) => {
      const keys = file.keys.map((key) => {
        if (key.id !== keyId) {
          return key;
        }

        const next = {
          ...key,
          revokedAt: key.revokedAt ?? this.now(),
        };
        revoked = next;
        return next;
      });

      return { ...file, keys };
    });

    return revoked ? toDescriptor(revoked) : null;
  }

  async rotateKey(input: { keyId: string; name?: string }): Promise<CliAccessKeyCreatedResponse | null> {
    const existing = (await this.readFile()).keys.find((key) => key.id === input.keyId);
    if (!existing) {
      return null;
    }

    await this.revokeKey(input.keyId);
    return this.generateKey({ name: input.name ?? existing.name });
  }

  async authenticateAuthorizationHeader(
    authorizationHeader: string | string[] | undefined,
    lastUsedSource: CliAccessKeyLastUsedSource,
  ): Promise<CliAccessAuthResult> {
    const parsed = parseBearerAuthorizationHeader(authorizationHeader);
    if (!parsed.ok) {
      return parsed;
    }

    return this.authenticateApiKey(parsed.token, lastUsedSource);
  }

  async authenticateApiKey(apiKey: string, lastUsedSource: CliAccessKeyLastUsedSource): Promise<CliAccessAuthResult> {
    const normalizedApiKey = normalizeSecret(apiKey);
    if (!normalizedApiKey) {
      return unauthorized("invalid_token", "Invalid CLI API key");
    }

    if (this.envApiKey && constantTimeHashEquals(normalizedApiKey, this.envApiKey)) {
      return { ok: true, keyId: "env", source: "env" };
    }

    const inputHash = hashSecret(normalizedApiKey);
    const file = await this.readFile();
    const matchingActive = file.keys.find((key) => key.revokedAt === undefined && constantTimeHashHexEquals(inputHash, key.keyHash));
    if (matchingActive) {
      await this.markLastUsed(matchingActive.id, lastUsedSource);
      return { ok: true, keyId: matchingActive.id, source: "stored" };
    }

    const matchingRevoked = file.keys.find((key) => key.revokedAt !== undefined && constantTimeHashHexEquals(inputHash, key.keyHash));
    if (matchingRevoked) {
      return {
        ok: false,
        statusCode: 403,
        code: "revoked_token",
        message: "CLI API key has been revoked",
      };
    }

    return unauthorized("invalid_token", "Invalid CLI API key");
  }

  private async markLastUsed(keyId: string, lastUsedSource: CliAccessKeyLastUsedSource): Promise<void> {
    const lastUsedAt = this.now();
    await this.updateFile((file) => ({
      ...file,
      keys: file.keys.map((key) =>
        key.id === keyId
          ? {
              ...key,
              lastUsedAt,
              lastUsedSource,
            }
          : key
      ),
    }));
  }

  private async readFile(): Promise<StoredCliAccessFile> {
    const current = await this.readStoredFile(this.filePath);
    if (current) {
      return current;
    }

    const legacy = await this.readStoredFile(this.legacyFilePath);
    if (!legacy) {
      return { version: CLI_ACCESS_FILE_VERSION, keys: [] };
    }

    await writeJsonFileAtomic(this.filePath, legacy);
    await unlink(this.legacyFilePath).catch(() => undefined);
    return legacy;
  }

  private async readStoredFile(filePath: string): Promise<StoredCliAccessFile | undefined> {
    const parsed = await readJsonFileIfExists<Partial<StoredCliAccessFile>>(filePath);
    if (!parsed || !Array.isArray(parsed.keys)) {
      return undefined;
    }

    return normalizeFile({
      version: CLI_ACCESS_FILE_VERSION,
      keys: parsed.keys.filter(isStoredCliAccessKey),
    });
  }

  private async updateFile(mutator: (file: StoredCliAccessFile) => StoredCliAccessFile): Promise<StoredCliAccessFile> {
    const run = async (): Promise<StoredCliAccessFile> => {
      const current = await this.readFile();
      const next = normalizeFile(mutator(current));
      await writeJsonFileAtomic(this.filePath, next);
      return next;
    };

    const nextWrite = this.writeQueue.then(run, run);
    this.writeQueue = nextWrite.catch(() => undefined);
    return nextWrite;
  }
}

export function readCliApiKeyEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeSecret(env.FORGE_CLI_API_KEY ?? env.MIDDLEMAN_CLI_API_KEY);
}

function parseBearerAuthorizationHeader(authorizationHeader: string | string[] | undefined):
  | { ok: true; token: string }
  | Extract<CliAccessAuthResult, { ok: false }> {
  if (authorizationHeader === undefined) {
    return unauthorized("missing_authorization", "Missing Authorization bearer token");
  }

  if (Array.isArray(authorizationHeader)) {
    return unauthorized("malformed_authorization", "Authorization header must be a single Bearer token");
  }

  const trimmed = authorizationHeader.trim();
  const match = trimmed.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return unauthorized("malformed_authorization", "Authorization header must use Bearer authentication");
  }

  const token = match[1]?.trim();
  if (!token || /\s/.test(token)) {
    return unauthorized("malformed_authorization", "Authorization bearer token is malformed");
  }

  return { ok: true, token };
}

function unauthorized(
  code: "missing_authorization" | "malformed_authorization" | "invalid_token",
  message: string,
): Extract<CliAccessAuthResult, { ok: false }> {
  return {
    ok: false,
    statusCode: 401,
    code,
    message,
  };
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNameProperty(name: string | undefined): { name?: string } {
  const normalized = normalizeName(name);
  return normalized ? { name: normalized } : {};
}

function normalizeName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.slice(0, MAX_KEY_NAME_LENGTH);
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function constantTimeHashEquals(leftSecret: string, rightSecret: string): boolean {
  return constantTimeHashHexEquals(hashSecret(leftSecret), hashSecret(rightSecret));
}

function constantTimeHashHexEquals(leftHash: string, rightHash: string): boolean {
  const left = Buffer.from(leftHash, "hex");
  const right = Buffer.from(rightHash, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isStoredCliAccessKey(value: unknown): value is StoredCliAccessKey {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredCliAccessKey>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    (candidate.name === undefined || typeof candidate.name === "string") &&
    typeof candidate.keyHash === "string" &&
    /^[a-f0-9]{64}$/i.test(candidate.keyHash) &&
    typeof candidate.createdAt === "string" &&
    (candidate.lastUsedAt === undefined || typeof candidate.lastUsedAt === "string") &&
    (candidate.lastUsedSource === undefined || isCliAccessKeyLastUsedSource(candidate.lastUsedSource)) &&
    (candidate.revokedAt === undefined || typeof candidate.revokedAt === "string")
  );
}

function isCliAccessKeyLastUsedSource(value: unknown): value is CliAccessKeyLastUsedSource {
  return value === "http" || value === "ws" || value === "settings" || value === "unknown";
}

function normalizeFile(file: StoredCliAccessFile): StoredCliAccessFile {
  const deduped: StoredCliAccessKey[] = [];
  const seenIds = new Set<string>();
  for (const key of file.keys) {
    if (seenIds.has(key.id)) {
      continue;
    }
    seenIds.add(key.id);
    deduped.push(key);
  }

  return {
    version: CLI_ACCESS_FILE_VERSION,
    keys: deduped,
  };
}

function toDescriptor(key: StoredCliAccessKey): CliAccessKeyDescriptor {
  return {
    id: key.id,
    ...(key.name !== undefined ? { name: key.name } : {}),
    createdAt: key.createdAt,
    ...(key.lastUsedAt !== undefined ? { lastUsedAt: key.lastUsedAt } : {}),
    ...(key.lastUsedSource !== undefined ? { lastUsedSource: key.lastUsedSource } : {}),
    ...(key.revokedAt !== undefined ? { revokedAt: key.revokedAt } : {}),
  };
}
