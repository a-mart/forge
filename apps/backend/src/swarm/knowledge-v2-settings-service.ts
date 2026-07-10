import type {
  KnowledgeV2Settings,
  KnowledgeV2SettingsConstraints,
  UpdateKnowledgeV2SettingsRequest,
} from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { writeJsonFileAtomic } from "../utils/atomic-files.js";
import { isEnoentError } from "../utils/fs-errors.js";
import { getKnowledgeMigrationManifestPath, getKnowledgeV2SettingsPath } from "./data-paths.js";
import { parseKnowledgeV2MigrationManifest } from "./knowledge-v2-migration-manifest.js";
import {
  acquireKnowledgeMigrationLock,
  readKnowledgeMigrationLock,
} from "./knowledge-v2-migration-lock.js";

const SETTINGS_FILE_VERSION = 1;
export const DEFAULT_GLOBAL_INDEX_TOKEN_CAP = 1_500;
export const DEFAULT_PROFILE_INDEX_TOKEN_CAP = 800;
const MIN_INDEX_TOKEN_CAP = 100;
const MAX_INDEX_TOKEN_CAP = 10_000;

interface KnowledgeV2SettingsFile extends KnowledgeV2Settings {
  version: 1;
}

export class KnowledgeV2SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeV2SettingsValidationError";
  }
}

export class KnowledgeV2MigrationRequiredError extends Error {
  readonly code = "KNOWLEDGE_V2_MIGRATION_REQUIRED";

  constructor() {
    super("Knowledge v2 cannot be enabled until the guarded migration has completed successfully.");
    this.name = "KnowledgeV2MigrationRequiredError";
  }
}

export class KnowledgeV2SettingsService {
  private readonly dataDir: string;
  private readonly settingsPath: string;
  private readonly migrationManifestPath: string;
  private readonly now: () => Date;
  private settings: KnowledgeV2Settings = createDefaultKnowledgeV2Settings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: { dataDir: string; now?: () => Date }) {
    this.dataDir = options.dataDir;
    this.settingsPath = getKnowledgeV2SettingsPath(options.dataDir);
    this.migrationManifestPath = getKnowledgeMigrationManifestPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.settings = normalizeLoadedSettings(JSON.parse(raw) as unknown);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[knowledge-v2-settings] Failed to load settings from ${this.settingsPath}: ${message}`);
      }
      this.settings = createDefaultKnowledgeV2Settings();
    }
  }

  getSettings(): KnowledgeV2Settings {
    return cloneSettings(this.settings);
  }

  getDefaults(): KnowledgeV2Settings {
    return createDefaultKnowledgeV2Settings();
  }

  getSettingsView(): {
    settings: KnowledgeV2Settings;
    defaults: KnowledgeV2Settings;
    constraints: KnowledgeV2SettingsConstraints;
  } {
    return {
      settings: this.getSettings(),
      defaults: this.getDefaults(),
      constraints: getKnowledgeV2SettingsConstraints(),
    };
  }

  async getActivationCapability(): Promise<{ canEnable: boolean; reason: "migration_required" | null }> {
    const canEnable = await hasCompletedKnowledgeV2Migration(this.dataDir, this.migrationManifestPath);
    return { canEnable, reason: canEnable ? null : "migration_required" };
  }

  async update(patch: UpdateKnowledgeV2SettingsRequest): Promise<KnowledgeV2Settings> {
    return this.withUpdateLock(async () => {
      const next: KnowledgeV2Settings = {
        ...this.settings,
        enabled: patch.enabled === undefined ? this.settings.enabled : normalizeBoolean(patch.enabled, "enabled"),
        legacyCleanupConfirmed:
          patch.legacyCleanupConfirmed === undefined
            ? this.settings.legacyCleanupConfirmed
            : normalizeBoolean(patch.legacyCleanupConfirmed, "legacyCleanupConfirmed"),
        indexCaps: {
          global:
            patch.indexCaps?.global === undefined
              ? this.settings.indexCaps.global
              : normalizeIndexCap(patch.indexCaps.global, "indexCaps.global"),
          profile:
            patch.indexCaps?.profile === undefined
              ? this.settings.indexCaps.profile
              : normalizeIndexCap(patch.indexCaps.profile, "indexCaps.profile"),
        },
        updatedAt: this.now().toISOString(),
      };

      const enabling = this.settings.enabled === false && next.enabled === true;
      let releaseActivationLock: (() => Promise<void>) | undefined;
      if (enabling) {
        try {
          // Share the migration transaction's exclusive lock so another
          // process cannot begin migration between authorization and commit.
          releaseActivationLock = await acquireKnowledgeMigrationLock(
            this.dataDir,
            `knowledge-v2-activation-${process.pid}-${Date.now()}`,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new KnowledgeV2MigrationRequiredError();
          }
          throw error;
        }
      }

      try {
        if (enabling && !(await readValidCompletedManifest(this.migrationManifestPath))) {
          throw new KnowledgeV2MigrationRequiredError();
        }
        await writeSettingsFile(this.settingsPath, next);
        this.settings = next;
        return this.getSettings();
      } finally {
        await releaseActivationLock?.();
      }
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

export function createDefaultKnowledgeV2Settings(): KnowledgeV2Settings {
  return {
    enabled: false,
    legacyCleanupConfirmed: false,
    indexCaps: {
      global: DEFAULT_GLOBAL_INDEX_TOKEN_CAP,
      profile: DEFAULT_PROFILE_INDEX_TOKEN_CAP,
    },
    updatedAt: null,
  };
}

export function getKnowledgeV2SettingsConstraints(): KnowledgeV2SettingsConstraints {
  return {
    indexCaps: {
      min: MIN_INDEX_TOKEN_CAP,
      max: MAX_INDEX_TOKEN_CAP,
      defaults: {
        global: DEFAULT_GLOBAL_INDEX_TOKEN_CAP,
        profile: DEFAULT_PROFILE_INDEX_TOKEN_CAP,
      },
    },
  };
}

function normalizeLoadedSettings(value: unknown): KnowledgeV2Settings {
  const defaults = createDefaultKnowledgeV2Settings();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }
  const maybe = value as Partial<KnowledgeV2SettingsFile>;
  return {
    enabled: typeof maybe.enabled === "boolean" ? maybe.enabled : defaults.enabled,
    legacyCleanupConfirmed:
      typeof maybe.legacyCleanupConfirmed === "boolean"
        ? maybe.legacyCleanupConfirmed
        : defaults.legacyCleanupConfirmed,
    indexCaps: {
      global: normalizeLoadedIndexCap(maybe.indexCaps?.global, defaults.indexCaps.global),
      profile: normalizeLoadedIndexCap(maybe.indexCaps?.profile, defaults.indexCaps.profile),
    },
    updatedAt: typeof maybe.updatedAt === "string" ? maybe.updatedAt : null,
  };
}

function normalizeLoadedIndexCap(value: unknown, fallback: number): number {
  try {
    return normalizeIndexCap(value, "indexCaps");
  } catch {
    return fallback;
  }
}

function normalizeBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new KnowledgeV2SettingsValidationError(`${fieldName} must be a boolean`);
  }
  return value;
}

function normalizeIndexCap(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new KnowledgeV2SettingsValidationError(`${fieldName} must be a finite number`);
  }
  const rounded = Math.round(value);
  if (rounded < MIN_INDEX_TOKEN_CAP || rounded > MAX_INDEX_TOKEN_CAP) {
    throw new KnowledgeV2SettingsValidationError(
      `${fieldName} must be between ${MIN_INDEX_TOKEN_CAP} and ${MAX_INDEX_TOKEN_CAP}`,
    );
  }
  return rounded;
}

function cloneSettings(settings: KnowledgeV2Settings): KnowledgeV2Settings {
  return {
    enabled: settings.enabled,
    legacyCleanupConfirmed: settings.legacyCleanupConfirmed,
    indexCaps: { ...settings.indexCaps },
    updatedAt: settings.updatedAt,
  };
}

async function writeSettingsFile(targetPath: string, settings: KnowledgeV2Settings): Promise<void> {
  const payload: KnowledgeV2SettingsFile = {
    version: SETTINGS_FILE_VERSION,
    ...settings,
  };
  await writeJsonFileAtomic(targetPath, payload);
}

async function hasCompletedKnowledgeV2Migration(dataDir: string, manifestPath: string): Promise<boolean> {
  try {
    // A completed manifest is not visible as activation authorization until the
    // owning migration transaction has released its cross-process lock.
    if (await readKnowledgeMigrationLock(dataDir)) return false;
    return await readValidCompletedManifest(manifestPath);
  } catch (error) {
    if (isEnoentError(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function readValidCompletedManifest(manifestPath: string): Promise<boolean> {
  try {
    return parseKnowledgeV2MigrationManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown) !== null;
  } catch (error) {
    if (isEnoentError(error) || error instanceof SyntaxError) return false;
    throw error;
  }
}
