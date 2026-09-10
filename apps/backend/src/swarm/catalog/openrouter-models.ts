import {
  isRetiredForgeModel,
  parseOpenRouterRoutingConfig,
  resolveOpenRouterRouting,
  type ForgeInputMode,
  type ForgeReasoningLevel,
  type OpenRouterModelEntry,
  type OpenRouterModelsFile,
} from "@forge/protocol";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { getOpenRouterModelsPath } from "../data-paths.js";

const OPENROUTER_MODELS_VERSION = 1 as const;
const VALID_REASONING_LEVELS = new Set<ForgeReasoningLevel>(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
const VALID_INPUT_MODES = new Set<ForgeInputMode>(["text", "image"]);
let openRouterModelsWriteMutex: Promise<void> = Promise.resolve();

function emptyOpenRouterModelsFile(): OpenRouterModelsFile {
  return {
    version: OPENROUTER_MODELS_VERSION,
    models: {},
  };
}

function sanitizeStringArray<T extends string>(value: unknown, allowedValues: Set<T>): T[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: T[] = [];
  const seen = new Set<T>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }

    const trimmed = entry.trim();
    if (!trimmed || !allowedValues.has(trimmed as T)) {
      return null;
    }

    const typedEntry = trimmed as T;
    if (!seen.has(typedEntry)) {
      seen.add(typedEntry);
      normalized.push(typedEntry);
    }
  }

  return normalized;
}

function isOpenRouterModelId(value: string): boolean {
  const slashIndex = value.indexOf("/");
  return slashIndex > 0 && slashIndex < value.length - 1;
}

function sanitizeOpenRouterModelEntry(value: unknown): OpenRouterModelEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const routing = candidate.routing === undefined ? undefined : parseOpenRouterRoutingConfig(candidate.routing);
  const modelId = typeof candidate.modelId === "string" ? candidate.modelId.trim() : "";
  const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
  const supportedReasoningLevels = sanitizeStringArray(
    candidate.supportedReasoningLevels,
    VALID_REASONING_LEVELS,
  );
  const inputModes = sanitizeStringArray(candidate.inputModes, VALID_INPUT_MODES);
  const addedAt = typeof candidate.addedAt === "string" ? candidate.addedAt.trim() : "";

  if (
    !modelId ||
    !isOpenRouterModelId(modelId) ||
    !displayName ||
    typeof candidate.contextWindow !== "number" ||
    !Number.isInteger(candidate.contextWindow) ||
    candidate.contextWindow <= 0 ||
    typeof candidate.maxOutputTokens !== "number" ||
    !Number.isInteger(candidate.maxOutputTokens) ||
    candidate.maxOutputTokens <= 0 ||
    typeof candidate.supportsReasoning !== "boolean" ||
    !supportedReasoningLevels ||
    supportedReasoningLevels.length === 0 ||
    !inputModes ||
    inputModes.length === 0 ||
    !addedAt ||
    Number.isNaN(Date.parse(addedAt))
  ) {
    return null;
  }

  if (
    !candidate.supportsReasoning &&
    (supportedReasoningLevels.length !== 1 || supportedReasoningLevels[0] !== "none")
  ) {
    return null;
  }

  if (candidate.supportsTools !== undefined && typeof candidate.supportsTools !== "boolean") {
    return null;
  }

  return {
    ...(routing === undefined ? {} : { routing }),
    modelId,
    displayName,
    contextWindow: candidate.contextWindow,
    maxOutputTokens: candidate.maxOutputTokens,
    supportsReasoning: candidate.supportsReasoning,
    supportedReasoningLevels,
    inputModes,
    addedAt,
    ...(typeof candidate.supportsTools === "boolean" ? { supportsTools: candidate.supportsTools } : {}),
  };
}

function sanitizeOpenRouterModelsFile(value: unknown): OpenRouterModelsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid saved OpenRouter configuration");
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) throw new Error("Unsupported OpenRouter configuration version");
  const routingDefaults = candidate.routingDefaults === undefined ? undefined : parseOpenRouterRoutingConfig(candidate.routingDefaults);
  const rawModels = candidate.models;
  if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) {
    throw new Error("Invalid saved OpenRouter configuration");
  }

  const models: Record<string, OpenRouterModelEntry> = {};

  for (const [key, entry] of Object.entries(rawModels)) {
    const sanitizedEntry = sanitizeOpenRouterModelEntry(entry);
    if (!sanitizedEntry) {
      if (entry && typeof entry === "object" && "routing" in entry) throw new Error(`Invalid model ${JSON.stringify(key)} with saved OpenRouter routing`);
      continue;
    }

    if (key !== sanitizedEntry.modelId || Object.hasOwn(models, sanitizedEntry.modelId)) throw new Error(`Mismatched or duplicate OpenRouter model identity at ${JSON.stringify(key)}`);
    resolveOpenRouterRouting(routingDefaults, sanitizedEntry.routing);
    models[sanitizedEntry.modelId] = sanitizedEntry;
  }

  return {
    version: OPENROUTER_MODELS_VERSION,
    models,
    ...(routingDefaults === undefined ? {} : { routingDefaults }),
  };
}

export async function readOpenRouterModels(dataDir: string): Promise<OpenRouterModelsFile> {
  const filePath = getOpenRouterModelsPath(dataDir);
  let text: string;
  try { text = await readFile(filePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyOpenRouterModelsFile();
    throw error;
  }
  try { return sanitizeOpenRouterModelsFile(JSON.parse(text)); } catch (error) {
    throw new Error(`Cannot load OpenRouter settings at ${filePath}. Repair the saved configuration and reload: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function writeOpenRouterModels(dataDir: string, file: OpenRouterModelsFile): Promise<void> {
  const filePath = getOpenRouterModelsPath(dataDir);
  const normalized = sanitizeOpenRouterModelsFile(file);
  await writeJsonFileAtomic(filePath, normalized);
}

export async function mutateOpenRouterModelsFile(
  dataDir: string,
  mutate: (currentFile: OpenRouterModelsFile) => OpenRouterModelsFile | null,
  apply?: () => Promise<void>,
): Promise<{
  previousFile: OpenRouterModelsFile;
  nextFile: OpenRouterModelsFile;
  mutated: boolean;
}> {
  return withOpenRouterModelsWriteLock(async () => {
    const previousFile = await readOpenRouterModels(dataDir);
    const candidateFile = mutate(previousFile);
    if (!candidateFile) {
      return { previousFile, nextFile: previousFile, mutated: false };
    }

    const nextFile = sanitizeOpenRouterModelsFile(candidateFile);
    await writeOpenRouterModels(dataDir, nextFile);
    try { await apply?.(); } catch (error) {
      await writeOpenRouterModels(dataDir, previousFile);
      try { await apply?.(); } catch { /* Preserve original apply failure. */ }
      throw error;
    }
    return { previousFile, nextFile, mutated: true };
  });
}

export async function addOpenRouterModel(dataDir: string, entry: OpenRouterModelEntry): Promise<void> {
  const normalizedEntry = sanitizeOpenRouterModelEntry(entry);
  if (!normalizedEntry) {
    throw new Error(`Invalid OpenRouter model entry: ${entry.modelId}`);
  }
  if (isRetiredForgeModel("openrouter", normalizedEntry.modelId)) {
    throw new Error(`Retired OpenRouter model cannot be added: ${normalizedEntry.modelId}`);
  }

  await withOpenRouterModelsWriteLock(async () => {
    const file = await readOpenRouterModels(dataDir);
    file.models[normalizedEntry.modelId] = normalizedEntry;
    await writeOpenRouterModels(dataDir, file);
  });
}

export async function removeOpenRouterModel(dataDir: string, modelId: string): Promise<void> {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return;
  }

  await withOpenRouterModelsWriteLock(async () => {
    const file = await readOpenRouterModels(dataDir);
    if (!(normalizedModelId in file.models)) {
      return;
    }

    delete file.models[normalizedModelId];
    await writeOpenRouterModels(dataDir, file);
  });
}

export async function getOpenRouterModels(dataDir: string): Promise<OpenRouterModelEntry[]> {
  const file = await readOpenRouterModels(dataDir);
  return Object.values(file.models)
    .filter((model) => !isRetiredForgeModel("openrouter", model.modelId))
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}

async function withOpenRouterModelsWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = openRouterModelsWriteMutex;
  let release: (() => void) | undefined;
  openRouterModelsWriteMutex = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release?.();
  }
}


export function getOpenRouterRoutingRevision(file: OpenRouterModelsFile): string {
  return createHash("sha256").update(JSON.stringify(file)).digest("hex");
}
