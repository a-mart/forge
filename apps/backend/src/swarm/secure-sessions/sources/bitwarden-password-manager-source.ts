import { randomUUID } from "node:crypto";
import type { BitwardenPasswordManagerCliSummary } from "@forge/protocol";
import {
  HostOnlySecret,
  SecureSourceError,
  type SecureSecretResolution,
} from "./host-only-secret.js";
import type { SecureVaultCipher } from "./electron-safe-storage-client.js";
import {
  BitwardenCliManager,
  spawnBitwardenCli,
  type BitwardenCliInvocation,
} from "./bitwarden-cli-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_COLLECTIONS = 64;
const PROVIDER_ID_PATTERN = /^[0-9a-fA-F-]{16,128}$/;

export type BitwardenPasswordManagerVaultState =
  | "unavailable"
  | "unauthenticated"
  | "locked"
  | "available";

export interface BitwardenPasswordManagerVaultStatus {
  state: BitwardenPasswordManagerVaultState;
  accountEmail: string | null;
  serverUrl: string | null;
}

export interface BitwardenPasswordManagerStatus
extends BitwardenPasswordManagerVaultStatus {
  cli: BitwardenPasswordManagerCliSummary;
}

export interface BitwardenPasswordManagerCollection {
  id: string;
  organizationId: string;
  name: string;
}

export interface BitwardenPasswordManagerItemMetadata {
  id: string;
  name: string;
  username: string | null;
  collectionIds: string[];
  revisionDate: string | null;
}

export interface CreateBitwardenPasswordManagerItemInput {
  name: string;
  username?: string | null;
  collectionId: string;
  organizationId: string;
  material: HostOnlySecret;
}

export interface BitwardenPasswordManagerClient {
  status(): Promise<BitwardenPasswordManagerVaultStatus>;
  unlock(masterPassword: Buffer): Promise<BitwardenPasswordManagerVaultStatus>;
  lock(): Promise<void>;
  sync(): Promise<void>;
  listCollections(): Promise<BitwardenPasswordManagerCollection[]>;
  listItems(collectionIds: readonly string[]): Promise<BitwardenPasswordManagerItemMetadata[]>;
  createItem(
    input: CreateBitwardenPasswordManagerItemInput,
  ): Promise<BitwardenPasswordManagerItemMetadata>;
  getSecret(input: {
    itemId: string;
    allowedCollectionIds: readonly string[];
  }): Promise<{ material: HostOnlySecret; revisionDate: string | null }>;
  dispose(): void;
}

export interface BitwardenPasswordManagerSource {
  readonly kind: "bitwarden_password_manager";
  status(configuredExecutablePath: string | null): Promise<BitwardenPasswordManagerStatus>;
  installCli(): Promise<BitwardenPasswordManagerStatus>;
  unlock(
    encryptedMasterPassword: Uint8Array,
    configuredExecutablePath: string | null,
  ): Promise<BitwardenPasswordManagerStatus>;
  lock(): Promise<void>;
  sync(): Promise<void>;
  listCollections(): Promise<BitwardenPasswordManagerCollection[]>;
  listItems(
    collectionIds: readonly string[],
  ): Promise<BitwardenPasswordManagerItemMetadata[]>;
  createItem(
    input: CreateBitwardenPasswordManagerItemInput,
  ): Promise<BitwardenPasswordManagerItemMetadata>;
  resolve(input: {
    sourceLocator: string;
    allowedCollectionIds: readonly string[];
  }): Promise<SecureSecretResolution>;
  dispose(): void;
}

/**
 * Trusted host adapter for the user's locally authenticated Bitwarden CLI.
 *
 * The master password is supplied through a randomized one-shot environment
 * variable accepted by `bw unlock --passwordenv`. The resulting vault session
 * key is held only in this process and is supplied to later CLI children
 * through `BW_SESSION`. Neither value is placed in arguments or logs.
 */
export class BitwardenPasswordManagerCommandClient
implements BitwardenPasswordManagerClient {
  private sessionKey: Buffer | null = null;
  private readonly invocation: BitwardenCliInvocation;
  // Names and IDs only. Never cache item payloads or use this for authorization.
  private collections: { expiresAt: number; value: BitwardenPasswordManagerCollection[] } | null = null;

  constructor(
    executable: string | BitwardenCliInvocation = "bw",
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.invocation = typeof executable === "string"
      ? {
          executablePath: executable,
          source: "system",
          platform: process.platform,
          commandShell: null,
        }
      : executable;
  }

  async status(): Promise<BitwardenPasswordManagerVaultStatus> {
    if (this.sessionKey) {
      try {
        const withSession = await this.readStatus(this.sessionKey);
        if (withSession.state === "available") return withSession;
      } catch {
        // A stale CLI session must not hide the account's real login state.
      }
      this.clearSession();
    }
    try {
      const status = await this.readStatus(null);
      return status.state === "available"
        ? { ...status, state: "locked" }
        : status;
    } catch {
      this.clearSession();
      return { state: "unavailable", accountEmail: null, serverUrl: null };
    }
  }

  async unlock(masterPassword: Buffer): Promise<BitwardenPasswordManagerVaultStatus> {
    if (!Buffer.isBuffer(masterPassword) || masterPassword.byteLength < 1) {
      throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    }
    const passwordVariable = `FORGE_BW_PASSWORD_${randomUUID()
      .replaceAll("-", "")
      .toUpperCase()}`;
    const output = await this.run(
      ["unlock", "--raw", "--passwordenv", passwordVariable],
      {
        captureStdout: true,
        errorCode: "SECURE_SOURCE_LOCKED",
        extraEnvironment: {
          [passwordVariable]: masterPassword.toString("utf8"),
        },
      },
    );
    const sessionKey = trimAsciiBuffer(output);
    output.fill(0);
    if (sessionKey.byteLength < 16 || sessionKey.byteLength > 4096) {
      sessionKey.fill(0);
      throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
    }
    this.clearSession();
    this.sessionKey = sessionKey;
    const status = await this.status();
    if (status.state !== "available") {
      this.clearSession();
      throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    }
    return status;
  }

  async lock(): Promise<void> {
    const sessionKey = this.sessionKey ? Buffer.from(this.sessionKey) : null;
    this.clearSession();
    if (!sessionKey) return;
    try {
      await this.run(["lock"], {
        captureStdout: false,
        errorCode: "SECURE_SOURCE_UNAVAILABLE",
        sessionKey,
      });
    } finally {
      sessionKey.fill(0);
    }
  }

  async sync(): Promise<void> {
    this.collections = null;
    if (!this.sessionKey) throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    await this.run(["sync"], {
      captureStdout: false,
      errorCode: "SECURE_SOURCE_UNAVAILABLE",
      sessionKey: this.sessionKey,
    });
  }

  async listCollections(): Promise<BitwardenPasswordManagerCollection[]> {
    if (!this.sessionKey) throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    if (this.collections && this.collections.expiresAt > Date.now()) {
      return this.collections.value.map((collection) => ({ ...collection }));
    }
    const session = this.sessionKey;
    const output = await this.runWithSession(["list", "collections"]);
    const value = parseCollections(output);
    // A concurrent lock/re-unlock must not repopulate the previous session's cache.
    if (this.sessionKey === session) {
      this.collections = { expiresAt: Date.now() + 60_000, value };
    }
    return value.map((collection) => ({ ...collection }));
  }

  async listItems(
    collectionIds: readonly string[],
  ): Promise<BitwardenPasswordManagerItemMetadata[]> {
    const normalized = normalizeCollectionIds(collectionIds);
    const items = new Map<string, BitwardenPasswordManagerItemMetadata>();
    for (const collectionId of normalized) {
      const output = await this.runWithSession([
        "list",
        "items",
        "--collectionid",
        collectionId,
      ]);
      for (const item of parseItemMetadata(output)) {
        if (item.collectionIds.some((id) => normalized.includes(id))) {
          items.set(item.id, item);
        }
      }
    }
    return [...items.values()].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
  }

  async getSecret(input: {
    itemId: string;
    allowedCollectionIds: readonly string[];
  }): Promise<{ material: HostOnlySecret; revisionDate: string | null }> {
    if (!PROVIDER_ID_PATTERN.test(input.itemId)) {
      throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
    }
    const allowedCollectionIds = normalizeCollectionIds(input.allowedCollectionIds);
    const output = await this.runWithSession(["get", "item", input.itemId]);
    return parseItemSecret(output, allowedCollectionIds);
  }

  async createItem(
    input: CreateBitwardenPasswordManagerItemInput,
  ): Promise<BitwardenPasswordManagerItemMetadata> {
    const collectionId = providerId(input.collectionId);
    const organizationId = providerId(input.organizationId);
    const name = requiredBoundedString(input.name, 256);
    const username = optionalBoundedString(input.username, 512);
    let encoded: Buffer | null = null;
    try {
      encoded = await input.material.withBytes((material) => {
        const item = {
          type: 1,
          name,
          organizationId,
          collectionIds: [collectionId],
          login: {
            username,
            password: material.toString("utf8"),
          },
        };
        const serialized = Buffer.from(JSON.stringify(item), "utf8");
        try {
          return Buffer.from(serialized.toString("base64"), "utf8");
        } finally {
          serialized.fill(0);
        }
      });
      const output = await this.runWithSession(["create", "item"], encoded);
      try {
        return parseCreatedItemMetadata(output, collectionId);
      } finally {
        output.fill(0);
      }
    } finally {
      encoded?.fill(0);
    }
  }

  dispose(): void {
    this.clearSession();
  }

  private async readStatus(
    sessionKey: Buffer | null,
  ): Promise<BitwardenPasswordManagerVaultStatus> {
    const output = await this.run(["status"], {
      captureStdout: true,
      errorCode: "SECURE_SOURCE_UNAVAILABLE",
      ...(sessionKey ? { sessionKey } : {}),
    });
    return parseStatus(output, sessionKey !== null);
  }

  private async runWithSession(args: string[], stdin?: Buffer): Promise<Buffer> {
    if (!this.sessionKey) throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    return await this.run(args, {
      captureStdout: true,
      errorCode: "SECURE_SOURCE_LOCKED",
      sessionKey: this.sessionKey,
      ...(stdin ? { stdin } : {}),
    });
  }

  private clearSession(): void {
    this.collections = null;
    this.sessionKey?.fill(0);
    this.sessionKey = null;
  }

  private async run(
    args: string[],
    options: {
      captureStdout: boolean;
      errorCode:
        | "SECURE_SOURCE_LOCKED"
        | "SECURE_SOURCE_UNAVAILABLE";
      sessionKey?: Buffer;
      extraEnvironment?: NodeJS.ProcessEnv;
      stdin?: Buffer;
    },
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env };
      delete environment.BW_SESSION;
      if (options.sessionKey) {
        environment.BW_SESSION = options.sessionKey.toString("utf8");
      }
      Object.assign(environment, options.extraEnvironment);
      const child = options.stdin
        ? spawnBitwardenCli(this.invocation, args, {
            env: environment,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawnBitwardenCli(this.invocation, args, {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
      const stdout: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const wipeOutput = () => {
        for (const chunk of stdout) chunk.fill(0);
        stdout.length = 0;
      };
      const cleanup = () => {
        clearTimeout(timeout);
        for (const key of Object.keys(options.extraEnvironment ?? {})) {
          delete environment[key];
        }
        delete environment.BW_SESSION;
      };
      const rejectSafe = (code: SecureSourceError["code"]) => {
        if (settled) return;
        settled = true;
        cleanup();
        child.kill("SIGKILL");
        wipeOutput();
        reject(new SecureSourceError(code));
      };
      const timeout = setTimeout(
        () => rejectSafe("SECURE_SOURCE_TIMEOUT"),
        this.timeoutMs,
      );
      timeout.unref?.();
      if (options.stdin && child.stdin) {
        child.stdin.once("error", () => rejectSafe(options.errorCode));
        child.stdin.end(options.stdin);
      }
      const consume = (chunk: Buffer, capture: boolean) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_RESPONSE_BYTES) {
          rejectSafe("SECURE_SOURCE_RESPONSE_INVALID");
          return;
        }
        if (capture) stdout.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk: Buffer) => consume(chunk, options.captureStdout));
      // Provider errors can echo sensitive record content. Drain without retaining.
      child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
      child.once("error", () => rejectSafe("SECURE_SOURCE_UNAVAILABLE"));
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) {
          wipeOutput();
          reject(new SecureSourceError(options.errorCode));
          return;
        }
        const output = Buffer.concat(stdout);
        wipeOutput();
        resolve(output);
      });
    });
  }
}

export class BitwardenPasswordManagerSecretSource {
  readonly kind = "bitwarden_password_manager" as const;
  private client: BitwardenPasswordManagerCommandClient | null = null;
  private executablePath: string | null = null;

  constructor(
    private readonly cipher: SecureVaultCipher,
    private readonly cliManager: BitwardenCliManager,
  ) {}

  async status(
    configuredExecutablePath: string | null,
  ): Promise<BitwardenPasswordManagerStatus> {
    const resolution = await this.prepare(configuredExecutablePath);
    if (!resolution.invocation || !this.client) {
      return {
        state: "unavailable",
        accountEmail: null,
        serverUrl: null,
        cli: resolution.summary,
      };
    }
    const status = await this.client.status();
    return { ...status, cli: resolution.summary };
  }

  async installCli(): Promise<BitwardenPasswordManagerStatus> {
    this.client?.dispose();
    this.client = null;
    this.executablePath = null;
    const resolution = await this.cliManager.install();
    if (!resolution.invocation) {
      return {
        state: "unavailable",
        accountEmail: null,
        serverUrl: null,
        cli: resolution.summary,
      };
    }
    this.setClient(resolution.invocation);
    const status = await this.client!.status();
    return { ...status, cli: resolution.summary };
  }

  listCollections(): Promise<BitwardenPasswordManagerCollection[]> {
    return this.requireClient().listCollections();
  }

  listItems(
    collectionIds: readonly string[],
  ): Promise<BitwardenPasswordManagerItemMetadata[]> {
    return this.requireClient().listItems(collectionIds);
  }

  createItem(
    input: CreateBitwardenPasswordManagerItemInput,
  ): Promise<BitwardenPasswordManagerItemMetadata> {
    return this.requireClient().createItem(input);
  }

  async unlock(
    encryptedMasterPassword: Uint8Array,
    configuredExecutablePath: string | null,
  ): Promise<BitwardenPasswordManagerStatus> {
    if (!encryptedMasterPassword.byteLength) {
      throw new SecureSourceError("SECURE_SOURCE_LOCKED");
    }
    const resolution = await this.prepare(configuredExecutablePath);
    if (!resolution.invocation) {
      throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
    }
    const decrypted = await this.cipher.decrypt(encryptedMasterPassword);
    try {
      const status = await decrypted.material.withBytes(async (password) =>
        await this.requireClient().unlock(password)
      );
      return { ...status, cli: resolution.summary };
    } finally {
      decrypted.reEncryptedCiphertext?.fill(0);
      decrypted.material.release();
    }
  }

  lock(): Promise<void> {
    return this.client?.lock() ?? Promise.resolve();
  }

  sync(): Promise<void> {
    return this.requireClient().sync();
  }

  async resolve(input: {
    sourceLocator: string;
    allowedCollectionIds: readonly string[];
  }): Promise<SecureSecretResolution> {
    const record = await this.requireClient().getSecret({
      itemId: input.sourceLocator,
      allowedCollectionIds: input.allowedCollectionIds,
    });
    return {
      material: record.material,
      sourceVersion: record.revisionDate,
      resolvedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    this.client?.dispose();
    this.client = null;
    this.executablePath = null;
  }

  private async prepare(configuredExecutablePath: string | null) {
    const resolution = await this.cliManager.resolve(configuredExecutablePath);
    if (!resolution.invocation) {
      this.client?.dispose();
      this.client = null;
      this.executablePath = null;
      return resolution;
    }
    this.setClient(resolution.invocation);
    return resolution;
  }

  private setClient(invocation: BitwardenCliInvocation): void {
    if (this.client && this.executablePath === invocation.executablePath) return;
    this.client?.dispose();
    this.client = new BitwardenPasswordManagerCommandClient(invocation);
    this.executablePath = invocation.executablePath;
  }

  private requireClient(): BitwardenPasswordManagerCommandClient {
    if (!this.client) throw new SecureSourceError("SECURE_SOURCE_UNAVAILABLE");
    return this.client;
  }
}

function parseStatus(
  output: Buffer,
  hasSession: boolean,
): BitwardenPasswordManagerVaultStatus {
  const parsed = parseJsonObject(output);
  const rawStatus = parsed.status;
  const accountEmail = optionalBoundedString(parsed.userEmail, 512);
  const serverUrl = optionalBoundedString(parsed.serverUrl, 4096);
  if (rawStatus === "unauthenticated") {
    return { state: "unauthenticated", accountEmail, serverUrl };
  }
  if (rawStatus === "locked") {
    return { state: "locked", accountEmail, serverUrl };
  }
  if (rawStatus === "unlocked") {
    return {
      state: hasSession ? "available" : "locked",
      accountEmail,
      serverUrl,
    };
  }
  throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
}

function parseCollections(output: Buffer): BitwardenPasswordManagerCollection[] {
  const parsed = parseJsonArray(output);
  const collections = parsed.map((value) => {
    const record = requireRecord(value);
    const id = providerId(record.id);
    const organizationId = providerId(record.organizationId);
    const name = requiredBoundedString(record.name, 256);
    return { id, organizationId, name };
  });
  if (collections.length > 10_000) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return collections.sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
}

function parseItemMetadata(output: Buffer): BitwardenPasswordManagerItemMetadata[] {
  const parsed = parseJsonArray(output);
  const items: BitwardenPasswordManagerItemMetadata[] = [];
  for (const value of parsed) {
    const record = requireRecord(value);
    if (record.type !== 1 && record.type !== 2) continue;
    items.push({
      id: providerId(record.id),
      name: requiredBoundedString(record.name, 256),
      username: record.type === 1
        ? optionalBoundedString(requireRecord(record.login).username, 512)
        : null,
      collectionIds: providerIdArray(record.collectionIds),
      revisionDate: optionalBoundedString(record.revisionDate, 128),
    });
  }
  return items;
}

function parseCreatedItemMetadata(
  output: Buffer,
  expectedCollectionId: string,
): BitwardenPasswordManagerItemMetadata {
  const record = parseJsonObject(output);
  if (record.type !== 1) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const collectionIds = providerIdArray(record.collectionIds);
  if (!collectionIds.includes(expectedCollectionId)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return {
    id: providerId(record.id),
    name: requiredBoundedString(record.name, 256),
    username: optionalBoundedString(requireRecord(record.login).username, 512),
    collectionIds,
    revisionDate: optionalBoundedString(record.revisionDate, 128),
  };
}

function parseItemSecret(
  output: Buffer,
  allowedCollectionIds: readonly string[],
): { material: HostOnlySecret; revisionDate: string | null } {
  const parsed = parseJsonObject(output);
  const collectionIds = providerIdArray(parsed.collectionIds);
  if (!collectionIds.some((id) => allowedCollectionIds.includes(id))) {
    throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
  }
  let material: string | null = null;
  if (parsed.type === 1) {
    material = optionalBoundedString(requireRecord(parsed.login).password, MAX_RESPONSE_BYTES);
  } else if (parsed.type === 2) {
    material = optionalBoundedString(parsed.notes, MAX_RESPONSE_BYTES);
  }
  if (!material) throw new SecureSourceError("SECURE_SOURCE_NOT_FOUND");
  const bytes = Buffer.from(material, "utf8");
  try {
    return {
      material: new HostOnlySecret(bytes),
      revisionDate: optionalBoundedString(parsed.revisionDate, 128),
    };
  } finally {
    bytes.fill(0);
  }
}

function parseJsonObject(output: Buffer): Record<string, unknown> {
  const parsed = parseJson(output);
  return requireRecord(parsed);
}

function parseJsonArray(output: Buffer): unknown[] {
  const parsed = parseJson(output);
  if (!Array.isArray(parsed)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return parsed;
}

function parseJson(output: Buffer): unknown {
  try {
    return JSON.parse(output.toString("utf8"));
  } catch {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  } finally {
    output.fill(0);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function providerId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID_PATTERN.test(value)) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return value;
}

function providerIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_COLLECTIONS) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const ids = value.map(providerId);
  return [...new Set(ids)].sort();
}

function normalizeCollectionIds(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_COLLECTIONS) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  const ids = values.map(providerId);
  if (new Set(ids).size !== ids.length) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return [...ids].sort();
}

function requiredBoundedString(value: unknown, maximum: number): string {
  const normalized = optionalBoundedString(value, maximum);
  if (!normalized) throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  return normalized;
}

function optionalBoundedString(value: unknown, maximum: number): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string"
    || value.trim().length < 1
    || value.length > maximum
    || value.includes("\0")
  ) {
    throw new SecureSourceError("SECURE_SOURCE_RESPONSE_INVALID");
  }
  return value;
}

function trimAsciiBuffer(value: Buffer): Buffer {
  let start = 0;
  let end = value.byteLength;
  while (start < end && isAsciiWhitespace(value[start]!)) start += 1;
  while (end > start && isAsciiWhitespace(value[end - 1]!)) end -= 1;
  return Buffer.from(value.subarray(start, end));
}

function isAsciiWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}
