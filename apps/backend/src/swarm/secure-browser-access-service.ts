import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  SecureBrowserDeviceDescriptor,
  SecureBrowserPairingClaimResponse,
  SecureBrowserPairingRequestCreated,
  SecureBrowserPairingRequestInput,
  SecureBrowserPendingPairingDescriptor,
  SecureBrowserSettingsSnapshot,
} from "@forge/protocol";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/atomic-files.js";
import { getSecureBrowserAccessFilePath } from "./storage/data-paths.js";

const FILE_VERSION = 1;
const TOKEN_PREFIX = "forge_secure_browser_";
const TOKEN_BYTES = 32;
const CLAIM_BYTES = 24;
const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PENDING_PAIRINGS = 16;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

interface StoredFile {
  version: number;
  devices: StoredDevice[];
}

interface StoredDevice extends SecureBrowserDeviceDescriptor {
  tokenHash: string;
}

interface PendingPairing extends SecureBrowserPendingPairingDescriptor {
  claimSecret: string;
  claimSecretHash: string;
  state: "pending" | "approved" | "denied";
  approvedToken?: string;
  approvedDevice?: StoredDevice;
  claimPromise?: Promise<ClaimPairingResult | null>;
}

export type SecureBrowserAuthentication =
  | { ok: true; device: SecureBrowserDeviceDescriptor }
  | { ok: false };

type ClaimPairingResult = {
  response: SecureBrowserPairingClaimResponse;
  accessToken?: string;
};

export interface SecureBrowserAccessServiceOptions {
  dataDir: string;
  now?: () => string;
  generateId?: () => string;
  generateSecret?: (bytes: number) => string;
  generateVerificationCode?: () => string;
}

export class SecureBrowserAccessService {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly generateSecret: (bytes: number) => string;
  private readonly generateVerificationCode: () => string;
  private readonly pending = new Map<string, PendingPairing>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SecureBrowserAccessServiceOptions) {
    this.filePath = getSecureBrowserAccessFilePath(options.dataDir);
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? (() => randomUUID());
    this.generateSecret = options.generateSecret ??
      ((bytes) => randomBytes(bytes).toString("base64url"));
    this.generateVerificationCode = options.generateVerificationCode ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0"));
  }

  async createPairingRequest(
    input: SecureBrowserPairingRequestInput,
  ): Promise<SecureBrowserPairingRequestCreated> {
    this.pruneExpired();
    const deviceId = clean(input.deviceId, 160);
    const existing = [...this.pending.values()].find(
      (entry) => entry.deviceId === deviceId && entry.state !== "denied",
    );
    if (existing) {
      return {
        requestId: existing.requestId,
        verificationCode: existing.verificationCode,
        claimSecret: existing.claimSecret,
        expiresAt: existing.expiresAt,
      };
    }
    if (this.pending.size >= MAX_PENDING_PAIRINGS) {
      const oldest = [...this.pending.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (oldest) this.pending.delete(oldest.requestId);
    }
    const requestId = `secure_browser_pair_${this.generateId()}`;
    const claimSecret = this.generateSecret(CLAIM_BYTES);
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + PAIRING_TTL_MS).toISOString();
    const pending: PendingPairing = {
      requestId,
      deviceId,
      deviceName: clean(input.deviceName, 120),
      verificationCode: this.generateVerificationCode(),
      createdAt,
      expiresAt,
      claimSecret,
      claimSecretHash: hash(claimSecret),
      state: "pending",
    };
    this.pending.set(requestId, pending);
    return {
      requestId,
      verificationCode: pending.verificationCode,
      claimSecret,
      expiresAt,
    };
  }

  async getSettingsSnapshot(): Promise<SecureBrowserSettingsSnapshot> {
    this.pruneExpired();
    const file = await this.readFile();
    return {
      pendingRequests: [...this.pending.values()]
        .filter((entry) => entry.state === "pending")
        .map(toPendingDescriptor)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      devices: file.devices.map(toDeviceDescriptor),
    };
  }

  async approvePairing(
    requestId: string,
  ): Promise<SecureBrowserPendingPairingDescriptor | null> {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || pending.state !== "pending") return null;
    const accessToken = `${TOKEN_PREFIX}${this.generateSecret(TOKEN_BYTES)}`;
    const createdAt = this.now();
    const stored: StoredDevice = {
      id: `secure_browser_device_${this.generateId()}`,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      tokenHash: hash(accessToken),
      createdAt,
    };
    pending.state = "approved";
    pending.approvedToken = accessToken;
    pending.approvedDevice = stored;
    return toPendingDescriptor(pending);
  }

  denyPairing(requestId: string): boolean {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || pending.state !== "pending") return false;
    pending.state = "denied";
    return true;
  }

  async claimPairing(
    requestId: string,
    claimSecret: string,
  ): Promise<ClaimPairingResult | null> {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || !safeHashEquals(hash(claimSecret), pending.claimSecretHash)) {
      return null;
    }
    if (pending.state === "pending") {
      return { response: { status: "pending" } };
    }
    if (pending.state === "denied") {
      this.pending.delete(requestId);
      return { response: { status: "denied" } };
    }
    if (!pending.approvedToken || !pending.approvedDevice) return null;
    if (pending.claimPromise) return await pending.claimPromise;
    const claimPromise = this.persistClaimedPairing(pending).catch((error) => {
      pending.claimPromise = undefined;
      throw error;
    });
    pending.claimPromise = claimPromise;
    return await claimPromise;
  }

  private async persistClaimedPairing(
    pending: PendingPairing,
  ): Promise<ClaimPairingResult | null> {
    const stored = pending.approvedDevice;
    const accessToken = pending.approvedToken;
    if (!stored || !accessToken) return null;
    await this.updateFile((file) => ({
      version: FILE_VERSION,
      devices: [
        stored,
        ...file.devices.map((device) =>
          device.deviceId === stored.deviceId && !device.revokedAt
            ? { ...device, revokedAt: stored.createdAt }
            : device),
      ],
    }));
    const result: ClaimPairingResult = {
      response: {
        status: "approved",
        device: toDeviceDescriptor(stored),
        scopes: [
          "secure-sessions:control",
          "secure-secrets:write",
          "private-entry:write",
        ],
      } satisfies SecureBrowserPairingClaimResponse,
      accessToken,
    };
    this.pending.delete(pending.requestId);
    return result;
  }

  async authenticateToken(token: string | undefined): Promise<SecureBrowserAuthentication> {
    if (!token || !token.startsWith(TOKEN_PREFIX)) return { ok: false };
    const tokenHash = hash(token);
    const file = await this.readFile();
    const active = file.devices.find(
      (device) =>
        !device.revokedAt && safeHashEquals(tokenHash, device.tokenHash),
    );
    if (!active) return { ok: false };
    const lastUsedAt = this.now();
    const previousUsedAtMs = active.lastUsedAt
      ? Date.parse(active.lastUsedAt)
      : Number.NaN;
    const currentUsedAtMs = Date.parse(lastUsedAt);
    const shouldPersistLastUse =
      !Number.isFinite(previousUsedAtMs)
      || !Number.isFinite(currentUsedAtMs)
      || currentUsedAtMs - previousUsedAtMs >= LAST_USED_WRITE_INTERVAL_MS;
    if (shouldPersistLastUse) {
      await this.updateFile((current) => ({
        ...current,
        devices: current.devices.map((device) =>
          device.id === active.id ? { ...device, lastUsedAt } : device),
      }));
    }
    return {
      ok: true,
      device: toDeviceDescriptor(
        shouldPersistLastUse ? { ...active, lastUsedAt } : active,
      ),
    };
  }

  async revokeDevice(id: string): Promise<SecureBrowserDeviceDescriptor | null> {
    let revoked: StoredDevice | null = null;
    await this.updateFile((file) => ({
      ...file,
      devices: file.devices.map((device) => {
        if (device.id !== id) return device;
        revoked = { ...device, revokedAt: device.revokedAt ?? this.now() };
        return revoked;
      }),
    }));
    return revoked ? toDeviceDescriptor(revoked) : null;
  }

  private pruneExpired(): void {
    const nowMs = Date.parse(this.now());
    for (const [id, pending] of this.pending) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pending.delete(id);
    }
  }

  private async readFile(): Promise<StoredFile> {
    const parsed = await readJsonFileIfExists<Partial<StoredFile>>(this.filePath);
    if (!parsed || !Array.isArray(parsed.devices)) {
      return { version: FILE_VERSION, devices: [] };
    }
    return {
      version: FILE_VERSION,
      devices: parsed.devices.filter(isStoredDevice),
    };
  }

  private async updateFile(
    mutator: (file: StoredFile) => StoredFile,
  ): Promise<StoredFile> {
    const run = async (): Promise<StoredFile> => {
      const next = mutator(await this.readFile());
      await writeJsonFileAtomic(this.filePath, next);
      return next;
    };
    const queued = this.writeQueue.then(run, run);
    this.writeQueue = queued.catch(() => undefined);
    return queued;
  }
}

function toPendingDescriptor(
  value: PendingPairing,
): SecureBrowserPendingPairingDescriptor {
  const {
    requestId,
    deviceId,
    deviceName,
    verificationCode,
    createdAt,
    expiresAt,
  } = value;
  return {
    requestId,
    deviceId,
    deviceName,
    verificationCode,
    createdAt,
    expiresAt,
  };
}

function toDeviceDescriptor(value: StoredDevice): SecureBrowserDeviceDescriptor {
  const { id, deviceId, deviceName, createdAt, lastUsedAt, revokedAt } = value;
  return {
    id,
    deviceId,
    deviceName,
    createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const first = Buffer.from(left, "hex");
  const second = Buffer.from(right, "hex");
  return first.length === second.length && timingSafeEqual(first, second);
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredDevice>;
  return typeof entry.id === "string"
    && typeof entry.deviceId === "string"
    && typeof entry.deviceName === "string"
    && typeof entry.createdAt === "string"
    && typeof entry.tokenHash === "string"
    && /^[a-f0-9]{64}$/iu.test(entry.tokenHash);
}
