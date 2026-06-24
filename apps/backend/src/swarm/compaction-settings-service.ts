import type {
  CompactionSettings,
  CompactionSettingsAvailability,
  ManagerExactModelSelection,
  ManagerReasoningLevel,
  UpdateCompactionSettingsRequest,
} from "@forge/protocol";
import { MANAGER_REASONING_LEVELS } from "@forge/protocol";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isCompactionModelCatalogValid,
  isCompactionReasoningSupported,
  validateCompactionModelSelection,
} from "./compaction-model-selection.js";
import {
  CompactionSettingsValidationError,
} from "./compaction-settings-validation.js";
import { getCompactionSettingsPath } from "./data-paths.js";
import { renameWithRetry } from "./retry-rename.js";

export { CompactionSettingsValidationError } from "./compaction-settings-validation.js";

const SETTINGS_FILE_VERSION = 1;
const DEFAULT_COMPACTION_PROVIDER = "openai-codex";
const DEFAULT_COMPACTION_MODEL_ID = "gpt-5.5";
const DEFAULT_COMPACTION_REASONING_LEVEL: ManagerReasoningLevel = "low";
const DEFAULT_COMPACTION_TIMEOUT_MS = 300_000;
export const MIN_COMPACTION_TIMEOUT_MS = 60_000;
export const MAX_COMPACTION_TIMEOUT_MS = 900_000;

interface CompactionSettingsFile {
  version: 1;
  model: ManagerExactModelSelection;
  reasoningLevel: ManagerReasoningLevel;
  timeoutMs: number;
  updatedAt: string | null;
}

export class CompactionSettingsService {
  private readonly settingsPath: string;
  private readonly now: () => Date;
  private readonly getProviderAvailability: () => Promise<Map<string, boolean>>;
  private settings: CompactionSettings = createDefaultCompactionSettings();
  private updateMutex: Promise<void> = Promise.resolve();

  constructor(options: {
    dataDir: string;
    now?: () => Date;
    getProviderAvailability?: () => Promise<Map<string, boolean>>;
  }) {
    this.settingsPath = getCompactionSettingsPath(options.dataDir);
    this.now = options.now ?? (() => new Date());
    this.getProviderAvailability =
      options.getProviderAvailability ?? (async () => new Map<string, boolean>());
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.settings = normalizeLoadedSettings(parsed);
    } catch (error) {
      if (!isEnoentError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[compaction-settings] Failed to load settings from ${this.settingsPath}: ${message}`);
      }
      this.settings = createDefaultCompactionSettings();
    }
  }

  getDefaults(): CompactionSettings {
    return createDefaultCompactionSettings();
  }

  getSettings(): CompactionSettings {
    return {
      model: { ...this.settings.model },
      reasoningLevel: this.settings.reasoningLevel,
      timeoutMs: this.settings.timeoutMs,
      updatedAt: this.settings.updatedAt,
    };
  }

  async getSettingsView(): Promise<{
    settings: CompactionSettings;
    availability: CompactionSettingsAvailability;
    defaults: CompactionSettings;
    constraints: ReturnType<typeof getCompactionSettingsConstraints>;
  }> {
    const settings = this.getSettings();
    const availability = await this.resolveAvailability(settings);
    return {
      settings,
      availability,
      defaults: this.getDefaults(),
      constraints: getCompactionSettingsConstraints(),
    };
  }

  async update(patch: UpdateCompactionSettingsRequest): Promise<{
    settings: CompactionSettings;
    availability: CompactionSettingsAvailability;
  }> {
    return this.withUpdateLock(async () => {
      const providerAvailability = await this.getProviderAvailability();
      const nextModel =
        patch.model === undefined
          ? this.settings.model
          : normalizeModelSelection(patch.model, providerAvailability);
      const nextReasoningLevel =
        patch.reasoningLevel === undefined
          ? this.settings.reasoningLevel
          : normalizeReasoningLevel(patch.reasoningLevel);
      const nextTimeoutMs =
        patch.timeoutMs === undefined ? this.settings.timeoutMs : normalizeTimeoutMs(patch.timeoutMs);

      if (patch.model !== undefined || patch.reasoningLevel !== undefined) {
        validateCompactionModelSelection(nextModel, {
          providerAvailability,
          reasoningLevel: nextReasoningLevel,
        });
      }

      const next: CompactionSettings = {
        model: nextModel,
        reasoningLevel: nextReasoningLevel,
        timeoutMs: nextTimeoutMs,
        updatedAt: this.now().toISOString(),
      };

      await writeSettingsFile(this.settingsPath, next);
      this.settings = next;

      return {
        settings: this.getSettings(),
        availability: await this.resolveAvailability(next),
      };
    });
  }

  private async resolveAvailability(
    settings: CompactionSettings,
  ): Promise<CompactionSettingsAvailability> {
    const providerAvailability = await this.getProviderAvailability();
    const providerConfigured = providerAvailability.get(settings.model.provider.trim().toLowerCase()) !== false;
    const modelValid = isCompactionModelCatalogValid(settings.model);
    const reasoningSupported = isCompactionReasoningSupported(settings.model, settings.reasoningLevel);

    return {
      providerConfigured,
      modelValid,
      reasoningSupported,
    };
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

export function createDefaultCompactionSettings(): CompactionSettings {
  return {
    model: {
      provider: DEFAULT_COMPACTION_PROVIDER,
      modelId: DEFAULT_COMPACTION_MODEL_ID,
    },
    reasoningLevel: DEFAULT_COMPACTION_REASONING_LEVEL,
    timeoutMs: DEFAULT_COMPACTION_TIMEOUT_MS,
    updatedAt: null,
  };
}

export function getCompactionSettingsConstraints(): {
  timeoutMs: { min: number; max: number; default: number };
} {
  return {
    timeoutMs: {
      min: MIN_COMPACTION_TIMEOUT_MS,
      max: MAX_COMPACTION_TIMEOUT_MS,
      default: DEFAULT_COMPACTION_TIMEOUT_MS,
    },
  };
}

export function clampTimeoutMs(value: number): number {
  const rounded = Math.round(value);
  return Math.min(MAX_COMPACTION_TIMEOUT_MS, Math.max(MIN_COMPACTION_TIMEOUT_MS, rounded));
}

export function normalizeTimeoutMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CompactionSettingsValidationError("timeoutMs must be a finite number");
  }

  return clampTimeoutMs(value);
}

function normalizeLoadedSettings(value: unknown): CompactionSettings {
  const defaults = createDefaultCompactionSettings();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const maybe = value as Partial<CompactionSettingsFile>;
  const model = normalizeLoadedModel(maybe.model, defaults.model);
  const reasoningLevel = normalizeLoadedReasoningLevel(maybe.reasoningLevel, defaults.reasoningLevel);
  const timeoutMs = normalizeLoadedTimeoutMs(maybe.timeoutMs, defaults.timeoutMs);

  return {
    model,
    reasoningLevel,
    timeoutMs,
    updatedAt: normalizeIsoTimestamp(maybe.updatedAt),
  };
}

function normalizeLoadedModel(
  value: unknown,
  fallback: ManagerExactModelSelection,
): ManagerExactModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }

  const maybe = value as Partial<ManagerExactModelSelection>;
  const provider = normalizeNonEmptyString(maybe.provider);
  const modelId = normalizeNonEmptyString(maybe.modelId);
  if (!provider || !modelId) {
    return fallback;
  }

  return { provider, modelId };
}

function normalizeLoadedReasoningLevel(
  value: unknown,
  fallback: ManagerReasoningLevel,
): ManagerReasoningLevel {
  if (typeof value !== "string" || !MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)) {
    return fallback;
  }

  return value as ManagerReasoningLevel;
}

function normalizeLoadedTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return clampTimeoutMs(value);
}

function normalizeModelSelection(
  value: unknown,
  providerAvailability: Map<string, boolean>,
): ManagerExactModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompactionSettingsValidationError("model must be an object with provider and modelId");
  }

  const maybe = value as Partial<ManagerExactModelSelection>;
  const provider = normalizeNonEmptyString(maybe.provider);
  const modelId = normalizeNonEmptyString(maybe.modelId);

  if (!provider || !modelId) {
    throw new CompactionSettingsValidationError("model.provider and model.modelId must be non-empty strings");
  }

  const selection = { provider, modelId };
  validateCompactionModelSelection(selection, { providerAvailability });
  return selection;
}

function normalizeReasoningLevel(value: unknown): ManagerReasoningLevel {
  if (typeof value !== "string" || !MANAGER_REASONING_LEVELS.includes(value as ManagerReasoningLevel)) {
    throw new CompactionSettingsValidationError(
      `reasoningLevel must be one of: ${MANAGER_REASONING_LEVELS.join(", ")}`,
    );
  }

  return value as ManagerReasoningLevel;
}

async function writeSettingsFile(targetPath: string, settings: CompactionSettings): Promise<void> {
  const payload: CompactionSettingsFile = {
    version: SETTINGS_FILE_VERSION,
    model: settings.model,
    reasoningLevel: settings.reasoningLevel,
    timeoutMs: settings.timeoutMs,
    updatedAt: settings.updatedAt,
  };
  const tempPath = `${targetPath}.tmp`;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await renameWithRetry(tempPath, targetPath, { retries: 8, baseDelayMs: 15 });
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

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT",
  );
}
