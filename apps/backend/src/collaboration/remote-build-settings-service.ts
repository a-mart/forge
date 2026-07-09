import type { RemoteBuildSettings, UpdateRemoteBuildSettingsRequest } from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { getRemoteBuildSettingsPath } from "../swarm/data-paths.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";

const SETTINGS_FILE_VERSION = 1;
const INSTANCE_NAME_MAX_LENGTH = 120;

interface RemoteBuildSettingsFile {
  version: 1;
  enabled?: unknown;
  terminalsEnabled?: unknown;
  instanceName?: unknown;
  updatedAt?: unknown;
}

export class RemoteBuildSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteBuildSettingsValidationError";
  }
}

/**
 * Instance settings for remote projects (Wave R). `enabled` defaults to
 * false — it is the product kill switch; member-facing builder access (WS
 * commands and member-class HTTP routes) only activates when it is on.
 */
export class RemoteBuildSettingsService {
  private readonly settingsPath: string;
  private readonly now: () => Date;
  private settings: RemoteBuildSettings = createDefaultRemoteBuildSettings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.settingsPath = getRemoteBuildSettingsPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.settings = normalizeLoadedSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[remote-build-settings] Failed to load settings from ${this.settingsPath}: ${message}`);
      }
      this.settings = createDefaultRemoteBuildSettings();
    }
  }

  getSettings(): RemoteBuildSettings {
    return { ...this.settings };
  }

  isRemoteBuildEnabled(): boolean {
    return this.settings.enabled;
  }

  areTerminalsEnabled(): boolean {
    return this.settings.terminalsEnabled;
  }

  /** Display name for the handshake: admin-set name or the host name. */
  getInstanceDisplayName(): string {
    if (this.settings.instanceName) {
      return this.settings.instanceName;
    }

    try {
      const host = hostname().trim();
      if (host.length > 0) {
        return host;
      }
    } catch {
      // fall through to the default
    }

    return "Forge";
  }

  async update(payload: UpdateRemoteBuildSettingsRequest | unknown): Promise<RemoteBuildSettings> {
    const patch = normalizeUpdatePayload(payload);

    return this.withUpdateLock(async () => {
      const next: RemoteBuildSettings = {
        enabled: patch.enabled === undefined ? this.settings.enabled : patch.enabled,
        terminalsEnabled:
          patch.terminalsEnabled === undefined ? this.settings.terminalsEnabled : patch.terminalsEnabled,
        instanceName: patch.instanceName === undefined ? this.settings.instanceName : patch.instanceName,
        updatedAt: this.now().toISOString(),
      };

      await writeSettingsFile(this.settingsPath, next);
      this.settings = next;
      return this.getSettings();
    });
  }

  private async withUpdateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.updateMutex;
    let release: (() => void) | undefined;
    this.updateMutex = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export function createDefaultRemoteBuildSettings(): RemoteBuildSettings {
  return {
    enabled: false,
    terminalsEnabled: true,
    instanceName: null,
    updatedAt: null,
  };
}

function normalizeLoadedSettings(value: unknown): RemoteBuildSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaultRemoteBuildSettings();
  }

  const maybe = value as RemoteBuildSettingsFile;
  return {
    enabled: maybe.enabled === true,
    terminalsEnabled: maybe.terminalsEnabled === undefined ? true : maybe.terminalsEnabled === true,
    instanceName: normalizeStoredInstanceName(maybe.instanceName),
    updatedAt: typeof maybe.updatedAt === "string" ? maybe.updatedAt : null,
  };
}

function normalizeStoredInstanceName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, INSTANCE_NAME_MAX_LENGTH) : null;
}

function normalizeUpdatePayload(payload: unknown): UpdateRemoteBuildSettingsRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RemoteBuildSettingsValidationError("Request body must be a JSON object");
  }

  const maybe = payload as { enabled?: unknown; terminalsEnabled?: unknown; instanceName?: unknown };
  return {
    enabled: maybe.enabled === undefined ? undefined : normalizeBoolean(maybe.enabled, "enabled"),
    terminalsEnabled:
      maybe.terminalsEnabled === undefined
        ? undefined
        : normalizeBoolean(maybe.terminalsEnabled, "terminalsEnabled"),
    instanceName: maybe.instanceName === undefined ? undefined : normalizeInstanceNamePatch(maybe.instanceName),
  };
}

function normalizeBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new RemoteBuildSettingsValidationError(`${field} must be a boolean`);
  }
  return value;
}

function normalizeInstanceNamePatch(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new RemoteBuildSettingsValidationError("instanceName must be a string or null");
  }

  const trimmed = value.trim();
  if (trimmed.length > INSTANCE_NAME_MAX_LENGTH) {
    throw new RemoteBuildSettingsValidationError(
      `instanceName must be at most ${INSTANCE_NAME_MAX_LENGTH} characters`,
    );
  }

  return trimmed.length > 0 ? trimmed : null;
}

async function writeSettingsFile(settingsPath: string, settings: RemoteBuildSettings): Promise<void> {
  const payload = {
    version: SETTINGS_FILE_VERSION,
    enabled: settings.enabled,
    terminalsEnabled: settings.terminalsEnabled,
    instanceName: settings.instanceName,
    updatedAt: settings.updatedAt,
  } satisfies RemoteBuildSettingsFile;

  await writeJsonFileAtomic(settingsPath, payload);
}
