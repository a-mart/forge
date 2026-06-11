import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type {
  PhoenixObservabilityCaptureSettings,
  PhoenixObservabilityExportSettings,
  PhoenixObservabilityPathMode,
  PhoenixObservabilityPrivacySettings,
  PhoenixObservabilitySettings,
  PhoenixObservabilitySettingsPatch,
} from "@forge/protocol";
import { getPhoenixObservabilitySettingsPath } from "../swarm/data-paths.js";

export const DEFAULT_PHOENIX_ENDPOINT = "http://127.0.0.1:6006/v1/traces";
export const DEFAULT_PHOENIX_PROJECT_NAME = "default";

const MAX_EXTRA_PATTERNS = 32;
const MAX_PATTERN_LENGTH = 512;

export class PhoenixObservabilitySettingsService {
  private settings: PhoenixObservabilitySettings | null = null;
  private readonly settingsPath: string;

  constructor(dataDir: string) {
    this.settingsPath = getPhoenixObservabilitySettingsPath(dataDir);
  }

  async load(): Promise<PhoenixObservabilitySettings> {
    let raw: string;
    try {
      raw = await readFile(this.settingsPath, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        this.settings = createDefaultPhoenixObservabilitySettings();
        return cloneSettings(this.settings);
      }

      throw error;
    }

    const parsed = JSON.parse(raw) as unknown;
    this.settings = normalizePhoenixObservabilitySettings(parsed, null);
    return cloneSettings(this.settings);
  }

  async getSettings(): Promise<PhoenixObservabilitySettings> {
    if (!this.settings) {
      return this.load();
    }

    return cloneSettings(this.settings);
  }

  async updateSettings(patch: PhoenixObservabilitySettingsPatch): Promise<PhoenixObservabilitySettings> {
    const current = await this.getSettings();
    const merged = normalizePhoenixObservabilitySettings(patch, current);
    validatePhoenixEndpoint(merged.endpoint);

    const next: PhoenixObservabilitySettings = {
      ...merged,
      projectName: sanitizePhoenixProjectName(merged.projectName),
      updatedAt: new Date().toISOString(),
    };

    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tmpPath = `${this.settingsPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.settingsPath);
    this.settings = next;
    return cloneSettings(next);
  }
}

export function createDefaultPhoenixObservabilitySettings(): PhoenixObservabilitySettings {
  return {
    enabled: false,
    endpoint: DEFAULT_PHOENIX_ENDPOINT,
    projectName: DEFAULT_PHOENIX_PROJECT_NAME,
    contentMode: "rich",
    capture: {
      prompts: true,
      modelInputs: true,
      modelOutputs: true,
      toolInputs: true,
      toolResults: true,
      feedbackComments: true,
      imageData: false,
    },
    privacy: {
      redactionEnabled: true,
      includeDisplayNames: false,
      identifierMode: "stable_hash",
      pathMode: "basename_and_hash",
      maxContentChars: 32 * 1024,
      maxAttributeChars: 32 * 1024,
      maxSpanContentChars: 128 * 1024,
      extraRedactionPatterns: [],
    },
    export: {
      batchMaxQueueSize: 512,
      batchMaxExportBatchSize: 64,
      scheduledDelayMs: 2000,
      exportTimeoutMs: 3000,
      concurrencyLimit: 1,
    },
    updatedAt: null,
  };
}

export function normalizePhoenixObservabilitySettings(
  value: unknown,
  base: PhoenixObservabilitySettings | null,
): PhoenixObservabilitySettings {
  const fallback = base ?? createDefaultPhoenixObservabilitySettings();
  if (!isRecord(value)) {
    return cloneSettings(fallback);
  }

  const contentMode = value.contentMode === "metadata_only" ? "metadata_only" : value.contentMode === "rich" ? "rich" : fallback.contentMode;

  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    endpoint: normalizeString(value.endpoint, fallback.endpoint),
    projectName: sanitizePhoenixProjectName(normalizeOptionalString(value.projectName) ?? fallback.projectName),
    contentMode,
    capture: normalizeCaptureSettings(value.capture, fallback.capture),
    privacy: normalizePrivacySettings(value.privacy, fallback.privacy),
    export: normalizeExportSettings(value.export, fallback.export),
    updatedAt: normalizeOptionalString(value.updatedAt) ?? fallback.updatedAt,
  };
}

export function sanitizePhoenixProjectName(value: unknown): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return DEFAULT_PHOENIX_PROJECT_NAME;
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/.test(normalized)) {
    return DEFAULT_PHOENIX_PROJECT_NAME;
  }

  return normalized;
}

export function validatePhoenixEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("Phoenix endpoint must be a valid URL.");
  }

  if (parsed.protocol !== "http:") {
    throw new Error("Phoenix endpoint must use http:// loopback in V1.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Phoenix endpoint must not include embedded credentials.");
  }

  if (parsed.search || parsed.hash) {
    throw new Error("Phoenix endpoint must not include query strings or fragments.");
  }

  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("Phoenix endpoint must use a loopback host: localhost, 127.0.0.0/8, or ::1.");
  }

  if (!parsed.pathname.endsWith("/v1/traces")) {
    throw new Error("Phoenix endpoint must point to the OTLP traces path ending in /v1/traces.");
  }

  return parsed;
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    validatePhoenixEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
}

function normalizeCaptureSettings(value: unknown, fallback: PhoenixObservabilityCaptureSettings): PhoenixObservabilityCaptureSettings {
  const record = isRecord(value) ? value : {};
  return {
    prompts: normalizeBoolean(record.prompts, fallback.prompts),
    modelInputs: normalizeBoolean(record.modelInputs, fallback.modelInputs),
    modelOutputs: normalizeBoolean(record.modelOutputs, fallback.modelOutputs),
    toolInputs: normalizeBoolean(record.toolInputs, fallback.toolInputs),
    toolResults: normalizeBoolean(record.toolResults, fallback.toolResults),
    feedbackComments: normalizeBoolean(record.feedbackComments, fallback.feedbackComments),
    imageData: normalizeBoolean(record.imageData, fallback.imageData),
  };
}

function normalizePrivacySettings(value: unknown, fallback: PhoenixObservabilityPrivacySettings): PhoenixObservabilityPrivacySettings {
  const record = isRecord(value) ? value : {};
  return {
    redactionEnabled: normalizeBoolean(record.redactionEnabled, fallback.redactionEnabled),
    includeDisplayNames: normalizeBoolean(record.includeDisplayNames, fallback.includeDisplayNames),
    identifierMode: record.identifierMode === "raw" ? "raw" : record.identifierMode === "stable_hash" ? "stable_hash" : fallback.identifierMode,
    pathMode: normalizePathMode(record.pathMode, fallback.pathMode),
    maxContentChars: normalizeInteger(record.maxContentChars, fallback.maxContentChars, 1024, 256 * 1024),
    maxAttributeChars: normalizeInteger(record.maxAttributeChars, fallback.maxAttributeChars, 1024, 256 * 1024),
    maxSpanContentChars: normalizeInteger(record.maxSpanContentChars, fallback.maxSpanContentChars, 1024, 1024 * 1024),
    extraRedactionPatterns: normalizeExtraRedactionPatterns(record.extraRedactionPatterns, fallback.extraRedactionPatterns),
  };
}

function normalizeExportSettings(value: unknown, fallback: PhoenixObservabilityExportSettings): PhoenixObservabilityExportSettings {
  const record = isRecord(value) ? value : {};
  const batchMaxQueueSize = normalizeInteger(record.batchMaxQueueSize, fallback.batchMaxQueueSize, 1, 100_000);
  const batchMaxExportBatchSize = normalizeInteger(record.batchMaxExportBatchSize, fallback.batchMaxExportBatchSize, 1, batchMaxQueueSize);
  return {
    batchMaxQueueSize,
    batchMaxExportBatchSize,
    scheduledDelayMs: normalizeInteger(record.scheduledDelayMs, fallback.scheduledDelayMs, 100, 60_000),
    exportTimeoutMs: normalizeInteger(record.exportTimeoutMs, fallback.exportTimeoutMs, 100, 60_000),
    concurrencyLimit: normalizeInteger(record.concurrencyLimit, 1, 1, 1),
  };
}

function normalizePathMode(value: unknown, fallback: PhoenixObservabilityPathMode): PhoenixObservabilityPathMode {
  if (value === "basename_and_hash" || value === "redacted" || value === "raw") {
    return value;
  }

  return fallback;
}

function normalizeExtraRedactionPatterns(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const normalized: string[] = [];
  for (const entry of value) {
    const pattern = normalizeOptionalString(entry);
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH) {
      continue;
    }

    try {
      // Validate only. The redactor owns compilation.
      new RegExp(pattern, "gi");
    } catch {
      continue;
    }

    if (!normalized.includes(pattern)) {
      normalized.push(pattern);
    }

    if (normalized.length >= MAX_EXTRA_PATTERNS) {
      break;
    }
  }

  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "[::1]" || normalized === "::1") {
    return true;
  }

  if (isIP(normalized) === 4) {
    const firstOctet = Number(normalized.split(".")[0]);
    return firstOctet === 127;
  }

  return false;
}

function cloneSettings(settings: PhoenixObservabilitySettings): PhoenixObservabilitySettings {
  return JSON.parse(JSON.stringify(settings)) as PhoenixObservabilitySettings;
}

function normalizeString(value: unknown, fallback: string): string {
  return normalizeOptionalString(value) ?? fallback;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEnoentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
