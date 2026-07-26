import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  StreamDeckDeviceDescriptor,
  StreamDeckPairingClaimResponse,
  StreamDeckPairingRequestCreated,
  StreamDeckPairingRequestInput,
  StreamDeckPendingPairingDescriptor,
  StreamDeckSettingsSnapshot,
} from "@forge/protocol";
import { readJsonFileIfExists, writeJsonFileAtomic } from "../utils/atomic-files.js";
import { getStreamDeckAccessFilePath } from "./storage/data-paths.js";

const FILE_VERSION = 1;
const TOKEN_PREFIX = "forge_deck_";
const TOKEN_BYTES = 32;
const CLAIM_BYTES = 24;
const PAIRING_TTL_MS = 10 * 60_000;

interface StoredFile {
  version: number;
  devices: StoredDevice[];
}

interface StoredDevice extends StreamDeckDeviceDescriptor {
  tokenHash: string;
}

interface PendingPairing extends StreamDeckPendingPairingDescriptor {
  claimSecretHash: string;
  state: "pending" | "approved" | "denied";
  approvedToken?: string;
  approvedDevice?: StreamDeckDeviceDescriptor;
}

export type StreamDeckAuthResult =
  | { ok: true; deviceId: string }
  | { ok: false; statusCode: 401 | 403; code: "missing_authorization" | "malformed_authorization" | "invalid_token" | "revoked_token"; message: string };

export interface StreamDeckAccessServiceOptions {
  dataDir: string;
  now?: () => string;
  generateId?: () => string;
  generateSecret?: (bytes: number) => string;
  generateVerificationCode?: () => string;
}

export class StreamDeckAccessService {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly generateId: () => string;
  private readonly generateSecret: (bytes: number) => string;
  private readonly generateVerificationCode: () => string;
  private readonly pending = new Map<string, PendingPairing>();
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(options: StreamDeckAccessServiceOptions) {
    this.filePath = getStreamDeckAccessFilePath(options.dataDir);
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateId = options.generateId ?? (() => randomUUID());
    this.generateSecret = options.generateSecret ?? ((bytes) => randomBytes(bytes).toString("base64url"));
    this.generateVerificationCode = options.generateVerificationCode ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0"));
  }

  async createPairingRequest(input: StreamDeckPairingRequestInput): Promise<StreamDeckPairingRequestCreated> {
    this.pruneExpired();
    const requestId = `deck_pair_${this.generateId()}`;
    const claimSecret = this.generateSecret(CLAIM_BYTES);
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + PAIRING_TTL_MS).toISOString();
    const pending: PendingPairing = {
      requestId,
      deviceId: clean(input.deviceId, 160),
      deviceName: clean(input.deviceName, 120),
      pluginVersion: clean(input.pluginVersion, 40),
      verificationCode: this.generateVerificationCode(),
      createdAt,
      expiresAt,
      claimSecretHash: hash(claimSecret),
      state: "pending",
    };
    this.pending.set(requestId, pending);
    return { requestId, verificationCode: pending.verificationCode, claimSecret, expiresAt };
  }

  async getSettingsSnapshot(): Promise<StreamDeckSettingsSnapshot> {
    this.pruneExpired();
    const file = await this.readFile();
    return {
      pendingRequests: [...this.pending.values()]
        .filter((entry) => entry.state === "pending")
        .map(toPendingDescriptor)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      devices: file.devices.map(toDeviceDescriptor),
    };
  }

  async approvePairing(requestId: string): Promise<StreamDeckPendingPairingDescriptor | null> {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || pending.state !== "pending") return null;
    const accessToken = `${TOKEN_PREFIX}${this.generateSecret(TOKEN_BYTES)}`;
    const stored: StoredDevice = {
      id: `deck_device_${this.generateId()}`,
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      pluginVersion: pending.pluginVersion,
      tokenHash: hash(accessToken),
      createdAt: this.now(),
    };
    await this.updateFile((file) => ({
      version: FILE_VERSION,
      devices: [stored, ...file.devices.map((device) =>
        device.deviceId === stored.deviceId && !device.revokedAt
          ? { ...device, revokedAt: stored.createdAt }
          : device)],
    }));
    pending.state = "approved";
    pending.approvedToken = accessToken;
    pending.approvedDevice = toDeviceDescriptor(stored);
    return toPendingDescriptor(pending);
  }

  denyPairing(requestId: string): boolean {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || pending.state !== "pending") return false;
    pending.state = "denied";
    return true;
  }

  claimPairing(requestId: string, claimSecret: string): StreamDeckPairingClaimResponse | null {
    this.pruneExpired();
    const pending = this.pending.get(requestId);
    if (!pending || !safeHashEquals(hash(claimSecret), pending.claimSecretHash)) return null;
    if (pending.state === "pending") return { status: "pending" };
    if (pending.state === "denied") {
      this.pending.delete(requestId);
      return { status: "denied" };
    }
    if (!pending.approvedToken || !pending.approvedDevice) return null;
    const response: StreamDeckPairingClaimResponse = {
      status: "approved",
      accessToken: pending.approvedToken,
      device: pending.approvedDevice,
      scopes: ["snapshot:read", "actions:write"],
    };
    this.pending.delete(requestId);
    return response;
  }

  async revokeDevice(id: string): Promise<StreamDeckDeviceDescriptor | null> {
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

  async authenticateAuthorizationHeader(header: string | string[] | undefined): Promise<StreamDeckAuthResult> {
    if (header === undefined) return authFailure(401, "missing_authorization", "Missing Stream Deck bearer token");
    if (Array.isArray(header)) return authFailure(401, "malformed_authorization", "Authorization header must be a single Bearer token");
    const match = header.trim().match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) return authFailure(401, "malformed_authorization", "Authorization header must use Bearer authentication");
    const tokenHash = hash(match[1]);
    const file = await this.readFile();
    const active = file.devices.find((device) => !device.revokedAt && safeHashEquals(tokenHash, device.tokenHash));
    if (active) {
      const usedAt = this.now();
      await this.updateFile((current) => ({
        ...current,
        devices: current.devices.map((device) => device.id === active.id ? { ...device, lastUsedAt: usedAt } : device),
      }));
      return { ok: true, deviceId: active.id };
    }
    if (file.devices.some((device) => device.revokedAt && safeHashEquals(tokenHash, device.tokenHash))) {
      return authFailure(403, "revoked_token", "Stream Deck access has been revoked");
    }
    return authFailure(401, "invalid_token", "Invalid Stream Deck access token");
  }

  private pruneExpired(): void {
    const nowMs = Date.parse(this.now());
    for (const [id, pending] of this.pending) {
      if (Date.parse(pending.expiresAt) <= nowMs) this.pending.delete(id);
    }
  }

  private async readFile(): Promise<StoredFile> {
    const parsed = await readJsonFileIfExists<Partial<StoredFile>>(this.filePath);
    if (!parsed || !Array.isArray(parsed.devices)) return { version: FILE_VERSION, devices: [] };
    return { version: FILE_VERSION, devices: parsed.devices.filter(isStoredDevice) };
  }

  private async updateFile(mutator: (file: StoredFile) => StoredFile): Promise<StoredFile> {
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

function toPendingDescriptor(value: PendingPairing): StreamDeckPendingPairingDescriptor {
  const { requestId, deviceId, deviceName, pluginVersion, verificationCode, createdAt, expiresAt } = value;
  return { requestId, deviceId, deviceName, pluginVersion, verificationCode, createdAt, expiresAt };
}

function toDeviceDescriptor(value: StoredDevice): StreamDeckDeviceDescriptor {
  const { id, deviceId, deviceName, pluginVersion, createdAt, lastUsedAt, revokedAt } = value;
  return { id, deviceId, deviceName, pluginVersion, createdAt, ...(lastUsedAt ? { lastUsedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
}

function clean(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authFailure(statusCode: 401 | 403, code: "missing_authorization" | "malformed_authorization" | "invalid_token" | "revoked_token", message: string): StreamDeckAuthResult {
  return { ok: false, statusCode, code, message };
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StoredDevice>;
  return typeof entry.id === "string" && typeof entry.deviceId === "string" &&
    typeof entry.deviceName === "string" && typeof entry.pluginVersion === "string" &&
    typeof entry.createdAt === "string" && typeof entry.tokenHash === "string" &&
    /^[a-f0-9]{64}$/i.test(entry.tokenHash);
}
