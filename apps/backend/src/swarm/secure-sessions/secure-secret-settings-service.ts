import type {
  GetSecureSecretSettingsResponse,
  SecureSecretSettings,
  UpdateSecureSecretSettingsRequest,
} from "@forge/protocol";
import {
  SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MAX_PROJECT_DEFAULTS,
  SECURE_SECRET_MIN_PROJECT_DEFAULTS,
  getSecureSecretSettingsConstraints,
} from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { getSecureSecretSettingsPath } from "../data-paths.js";
import { isEnoentError } from "../../utils/fs-errors.js";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";

const SETTINGS_FILE_VERSION = 1;

interface SecureSecretSettingsFile {
  version: 1;
  maxProjectDefaults?: unknown;
  updatedAt?: unknown;
}

export class SecureSecretSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureSecretSettingsValidationError";
  }
}

export class SecureSecretSettingsService {
  private readonly settingsPath: string;
  private readonly now: () => Date;
  private settings: SecureSecretSettings = createDefaultSecureSecretSettings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.settingsPath = getSecureSecretSettingsPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.settings = normalizeLoadedSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[secure-secret-settings] Failed to load settings from ${this.settingsPath}: ${message}`,
        );
      }
      this.settings = createDefaultSecureSecretSettings();
    }
  }

  getDefaults(): SecureSecretSettings {
    return createDefaultSecureSecretSettings();
  }

  getSettings(): SecureSecretSettings {
    return {
      maxProjectDefaults: this.settings.maxProjectDefaults,
      updatedAt: this.settings.updatedAt,
    };
  }

  getMaxProjectDefaults(): number {
    return this.settings.maxProjectDefaults;
  }

  getSettingsView(): GetSecureSecretSettingsResponse {
    return {
      settings: this.getSettings(),
      defaults: this.getDefaults(),
      constraints: getSecureSecretSettingsConstraints(),
    };
  }

  async update(payload: UpdateSecureSecretSettingsRequest | unknown): Promise<SecureSecretSettings> {
    const patch = normalizeUpdatePayload(payload);

    return this.withUpdateLock(async () => {
      const next: SecureSecretSettings = {
        maxProjectDefaults:
          patch.maxProjectDefaults === undefined
            ? this.settings.maxProjectDefaults
            : normalizeMaxProjectDefaults(patch.maxProjectDefaults),
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

export function createDefaultSecureSecretSettings(): SecureSecretSettings {
  return {
    maxProjectDefaults: SECURE_SECRET_MAX_PROJECT_DEFAULTS,
    updatedAt: null,
  };
}

export function clampMaxProjectDefaults(value: number): number {
  const rounded = Math.round(value);
  return Math.min(
    SECURE_SECRET_ABSOLUTE_MAX_PROJECT_DEFAULTS,
    Math.max(SECURE_SECRET_MIN_PROJECT_DEFAULTS, rounded),
  );
}

export function normalizeMaxProjectDefaults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SecureSecretSettingsValidationError(
      "maxProjectDefaults must be a finite number",
    );
  }

  return clampMaxProjectDefaults(value);
}

function normalizeLoadedSettings(value: unknown): SecureSecretSettings {
  const defaults = createDefaultSecureSecretSettings();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const maybe = value as SecureSecretSettingsFile;
  return {
    maxProjectDefaults: normalizeLoadedMaxProjectDefaults(
      maybe.maxProjectDefaults,
      defaults.maxProjectDefaults,
    ),
    updatedAt: normalizeIsoTimestamp(maybe.updatedAt),
  };
}

function normalizeLoadedMaxProjectDefaults(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return clampMaxProjectDefaults(value);
}

function normalizeUpdatePayload(payload: unknown): UpdateSecureSecretSettingsRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SecureSecretSettingsValidationError("Request body must be a JSON object");
  }

  const maybe = payload as { maxProjectDefaults?: unknown };
  return {
    maxProjectDefaults:
      maybe.maxProjectDefaults === undefined
        ? undefined
        : normalizeMaxProjectDefaults(maybe.maxProjectDefaults),
  };
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}

async function writeSettingsFile(
  settingsPath: string,
  settings: SecureSecretSettings,
): Promise<void> {
  const payload = {
    version: SETTINGS_FILE_VERSION,
    maxProjectDefaults: settings.maxProjectDefaults,
    updatedAt: settings.updatedAt,
  } satisfies SecureSecretSettingsFile;

  await writeJsonFileAtomic(settingsPath, payload);
}
