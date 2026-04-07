import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelOverrideEntry, ModelOverridesFile } from "@forge/protocol";
import { getSharedModelOverridesPath } from "./data-paths.js";

const MODEL_OVERRIDES_VERSION = 1 as const;

function emptyModelOverridesFile(): ModelOverridesFile {
  return {
    version: MODEL_OVERRIDES_VERSION,
    overrides: {},
  };
}

function sanitizeOverrideEntry(value: unknown): ModelOverrideEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const next: ModelOverrideEntry = {};

  if (candidate.enabled !== undefined) {
    if (typeof candidate.enabled !== "boolean") {
      return null;
    }
    next.enabled = candidate.enabled;
  }

  if (candidate.contextWindowCap !== undefined) {
    if (
      typeof candidate.contextWindowCap !== "number" ||
      !Number.isFinite(candidate.contextWindowCap) ||
      !Number.isInteger(candidate.contextWindowCap) ||
      candidate.contextWindowCap <= 0
    ) {
      return null;
    }
    next.contextWindowCap = candidate.contextWindowCap;
  }

  if (candidate.modelSpecificInstructions !== undefined) {
    if (typeof candidate.modelSpecificInstructions !== "string") {
      return null;
    }
    next.modelSpecificInstructions = normalizeModelSpecificInstructions(candidate.modelSpecificInstructions);
  }

  return next;
}

function sanitizeModelOverridesFile(value: unknown): ModelOverridesFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyModelOverridesFile();
  }

  const candidate = value as Record<string, unknown>;
  const rawOverrides = candidate.overrides;
  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
    return emptyModelOverridesFile();
  }

  const overrides: Record<string, ModelOverrideEntry> = {};

  for (const [modelId, entry] of Object.entries(rawOverrides)) {
    const sanitizedEntry = sanitizeOverrideEntry(entry);
    if (!sanitizedEntry || Object.keys(sanitizedEntry).length === 0) {
      continue;
    }
    overrides[modelId] = sanitizedEntry;
  }

  return {
    version: MODEL_OVERRIDES_VERSION,
    overrides,
  };
}

export async function readModelOverrides(dataDir: string): Promise<ModelOverridesFile> {
  const filePath = getSharedModelOverridesPath(dataDir);

  try {
    const raw = await readFile(filePath, "utf8");
    return sanitizeModelOverridesFile(JSON.parse(raw));
  } catch (error) {
    if (isEnoentError(error) || error instanceof SyntaxError) {
      return emptyModelOverridesFile();
    }
    throw error;
  }
}

export async function writeModelOverrides(dataDir: string, overrides: ModelOverridesFile): Promise<void> {
  const filePath = getSharedModelOverridesPath(dataDir);
  const directory = dirname(filePath);
  const tempPath = join(directory, "model-overrides.json.tmp");
  const normalized = sanitizeModelOverridesFile(overrides);

  await mkdir(directory, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function setModelOverride(
  dataDir: string,
  modelId: string,
  override: ModelOverrideEntry,
): Promise<void> {
  const file = await readModelOverrides(dataDir);
  const nextOverride = sanitizeOverrideEntry(override);

  if (!nextOverride || Object.keys(nextOverride).length === 0) {
    delete file.overrides[modelId];
  } else {
    file.overrides[modelId] = nextOverride;
  }

  await writeModelOverrides(dataDir, file);
}

export async function resetModelOverride(dataDir: string, modelId: string): Promise<void> {
  const file = await readModelOverrides(dataDir);
  if (!(modelId in file.overrides)) {
    return;
  }

  delete file.overrides[modelId];
  await writeModelOverrides(dataDir, file);
}

export async function resetAllModelOverrides(dataDir: string): Promise<void> {
  await writeModelOverrides(dataDir, emptyModelOverridesFile());
}

function normalizeModelSpecificInstructions(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length > 0 ? normalized : "";
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
