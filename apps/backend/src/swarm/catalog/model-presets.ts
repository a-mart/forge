import { getSpawnPresetFamilies, type ModelPresetInfo } from "@forge/protocol";
import type { AgentModelDescriptor, SwarmModelPreset, SwarmReasoningLevel } from "../types.js";
import { SWARM_MODEL_PRESETS, SWARM_REASONING_LEVELS } from "../types.js";
import { modelCatalogService } from "./model-catalog-service.js";
import {
  assertClaudeSdkProviderNotSelected,
  CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE,
  isLegacyClaudeSdkPreset,
  mapLegacyClaudeSdkModel,
} from "./legacy-claude-sdk-model.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-5.5";

const REMOVED_PRESET_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "codex-app": "pi-5.5",
  "cursor-acp": "cursor-composer",
};

const PERSISTED_ONLY_PRESET_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "pi-codex-spark": "pi-5.5",
  "sdk-opus": "pi-opus",
  "sdk-sonnet": "pi-sonnet",
};

const REMOVED_PROVIDER_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "openai-codex-app-server": "pi-5.5",
  "cursor-acp": "cursor-composer",
};

const REMOVED_MODEL_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "openai-codex/gpt-5.3-codex": "pi-5.5",
  "openai-codex/gpt-5.3-codex-spark": "pi-5.5",
  "anthropic/claude-sonnet-4-5-20250929": "pi-sonnet",
  "anthropic/claude-haiku-4-5-20251001": "pi-sonnet",
  "anthropic/claude-sonnet-4.5": "pi-sonnet",
  "anthropic/claude-haiku-4.5": "pi-sonnet",
  "anthropic/claude-sonnet-4-5": "pi-sonnet",
  "anthropic/claude-haiku-4-5": "pi-sonnet",
};

const RETIRED_MODEL_REJECTION_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "openrouter/~anthropic/claude-haiku-latest": "pi-sonnet",
  "openrouter/anthropic/claude-sonnet-4.5": "pi-sonnet",
  "openrouter/anthropic/claude-haiku-4.5": "pi-sonnet",
  "openrouter/anthropic/claude-sonnet-4-5": "pi-sonnet",
  "openrouter/anthropic/claude-haiku-4-5": "pi-sonnet",
  "openrouter/anthropic/claude-sonnet-4-5-20250929": "pi-sonnet",
  "openrouter/anthropic/claude-haiku-4-5-20251001": "pi-sonnet",
  "openrouter/openai/gpt-5.3-codex-spark": "pi-5.5",
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_SWARM_REASONING_LEVEL_VALUES = new Set<string>(SWARM_REASONING_LEVELS);

export function describeSwarmModelPresets(): string {
  return getSpawnPresetFamilies().map((family) => family.familyId).join("|");
}

export function describeSwarmReasoningLevels(): string {
  return SWARM_REASONING_LEVELS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return normalizeSwarmModelPresetValue(value) !== undefined;
}

export function isSwarmReasoningLevel(value: unknown): value is SwarmReasoningLevel {
  return typeof value === "string" && VALID_SWARM_REASONING_LEVEL_VALUES.has(value);
}

export function parseSwarmModelPreset(value: unknown, fieldName: string): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (isLegacyClaudeSdkPreset(value)) {
    throw new Error(`${fieldName}: ${CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE}`);
  }

  const normalizedPreset = normalizeSwarmModelPresetValue(value);
  if (!normalizedPreset) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return normalizedPreset;
}

export function parseSwarmReasoningLevel(
  value: unknown,
  fieldName: string,
): SwarmReasoningLevel | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmReasoningLevel(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmReasoningLevels()}`);
  }

  return value;
}

export function inferProviderFromModelId(modelId: string): string | null {
  const catalogResult = modelCatalogService.inferProvider(modelId);
  if (catalogResult) {
    return catalogResult;
  }

  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    return null;
  }

  if (normalizedModelId.startsWith("claude-sdk/")) {
    return "claude-sdk";
  }

  if (isSlashScopedOpenRouterModelId(normalizedModelId)) {
    return "openrouter";
  }

  if (normalizedModelId.startsWith("gpt-")) {
    return "openai-codex";
  }

  if (normalizedModelId.startsWith("claude-")) {
    return "anthropic";
  }

  if (normalizedModelId.startsWith("grok-")) {
    return "xai";
  }

  return null;
}

function isSlashScopedOpenRouterModelId(modelId: string): boolean {
  const slashIndex = modelId.indexOf("/");
  return slashIndex > 0 && slashIndex < modelId.length - 1;
}

export function getModelPresetInfoList(): ModelPresetInfo[] {
  return modelCatalogService.getModelPresetInfoList();
}

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  return modelCatalogService.resolveModelDescriptor(preset);
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  return modelCatalogService.inferFamily(descriptor);
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  fallbackPreset: SwarmModelPreset = DEFAULT_SWARM_MODEL_PRESET,
): AgentModelDescriptor {
  if (descriptor) {
    const selectedModel = modelCatalogService.getModel(descriptor.modelId, descriptor.provider);
    if (selectedModel?.provider === "xai") {
      return {
        provider: selectedModel.provider,
        modelId: selectedModel.modelId,
        thinkingLevel: selectedModel.defaultReasoningLevel,
      };
    }
  }

  const preset = inferSwarmModelPresetFromDescriptor(descriptor) ?? fallbackPreset;
  return resolveModelDescriptorFromPreset(preset);
}

export function normalizeSwarmModelPresetValue(value: unknown): SwarmModelPreset | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedPreset = value.trim().toLowerCase();
  return VALID_SWARM_MODEL_PRESET_VALUES.has(normalizedPreset)
    ? normalizedPreset
    : REMOVED_PRESET_REPLACEMENTS[normalizedPreset];
}

export function resolveRemovedSwarmModelPresetAlias(preset: string): SwarmModelPreset | undefined {
  const normalizedPreset = preset.trim().toLowerCase();
  return REMOVED_PRESET_REPLACEMENTS[normalizedPreset];
}

export function normalizePersistedSwarmModelPresetValue(value: string): SwarmModelPreset | undefined {
  const normalizedPreset = value.trim().toLowerCase();
  return normalizeSwarmModelPresetValue(normalizedPreset) ?? PERSISTED_ONLY_PRESET_REPLACEMENTS[normalizedPreset];
}

export function resolveRemovedSwarmModelReplacementPreset(
  provider: string,
  modelId: string,
): SwarmModelPreset | undefined {
  return resolveModelReplacementFromMap(REMOVED_MODEL_REPLACEMENTS, provider, modelId)
    ?? resolveModelReplacementFromMap(RETIRED_MODEL_REJECTION_REPLACEMENTS, provider, modelId);
}

function resolveModelReplacementFromMap(
  replacements: Record<string, SwarmModelPreset>,
  provider: string,
  modelId: string,
): SwarmModelPreset | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  let normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedProvider || !normalizedModelId) {
    return undefined;
  }

  const providerPrefix = `${normalizedProvider}/`;
  if (normalizedModelId.startsWith(providerPrefix)) {
    normalizedModelId = normalizedModelId.slice(providerPrefix.length);
  }

  return replacements[`${normalizedProvider}/${normalizedModelId}`];
}

export function assertSwarmModelIdNotRetired(provider: string, modelId: string, fieldName: string): void {
  assertClaudeSdkProviderNotSelected(provider, fieldName);
  const replacementPreset = resolveRemovedSwarmModelReplacementPreset(provider, modelId);
  if (!replacementPreset) {
    return;
  }

  throw new Error(
    `${fieldName} refers to retired model ${provider.trim()}/${modelId.trim()}; use ${replacementPreset} instead`,
  );
}

export function normalizePersistedSwarmModelDescriptor(
  descriptor: (Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string }) | undefined,
): AgentModelDescriptor | undefined {
  if (!descriptor) {
    return undefined;
  }

  const legacyClaudeSdkMapping = mapLegacyClaudeSdkModel(descriptor);
  if (legacyClaudeSdkMapping.kind === "mapped") {
    const mappedDescriptor = {
      provider: legacyClaudeSdkMapping.provider,
      modelId: legacyClaudeSdkMapping.modelId,
      thinkingLevel: descriptor.thinkingLevel,
    };
    return {
      ...mappedDescriptor,
      thinkingLevel: normalizeThinkingLevelForModelDescriptor(mappedDescriptor),
    };
  }

  const provider = descriptor.provider.trim().toLowerCase();
  const modelId = descriptor.modelId.trim().toLowerCase();
  const replacementPreset =
    resolveModelReplacementFromMap(REMOVED_MODEL_REPLACEMENTS, provider, modelId)
    ?? REMOVED_PROVIDER_REPLACEMENTS[provider];
  if (!replacementPreset) {
    return {
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      thinkingLevel: normalizeThinkingLevelForModelDescriptor(descriptor),
    };
  }

  const replacement = resolveModelDescriptorFromPreset(replacementPreset);
  return {
    ...replacement,
    thinkingLevel: normalizeDescriptorThinkingLevelForPreset(descriptor.thinkingLevel, replacementPreset),
  };
}

function normalizeDescriptorThinkingLevelForPreset(level: string | undefined, preset: SwarmModelPreset): string {
  const presetDescriptor = resolveModelDescriptorFromPreset(preset);
  return normalizeThinkingLevelForModelDescriptor(presetDescriptor, level);
}

export function normalizeThinkingLevelForModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string },
  overrideLevel?: string,
): string {
  const provider = descriptor.provider.trim().toLowerCase();
  const modelId = descriptor.modelId.trim().toLowerCase();
  const requestedLevel = overrideLevel ?? descriptor.thinkingLevel;
  const catalogModel = modelCatalogService.getModel(modelId, provider);
  if (!catalogModel) {
    if (provider === "cursor-sdk") {
      return normalizeCursorSdkThinkingLevel(requestedLevel, modelId);
    }
    return provider === "anthropic"
      ? normalizeAnthropicThinkingLevel(requestedLevel)
      : normalizeDescriptorThinkingLevel(requestedLevel);
  }

  if (!catalogModel.supportsReasoning) {
    return catalogModel.defaultReasoningLevel;
  }

  const normalized = normalizeDescriptorThinkingLevel(requestedLevel);
  const supportedReasoningLevels: readonly string[] = catalogModel.supportedReasoningLevels;
  if (supportedReasoningLevels.includes(normalized)) {
    return normalized;
  }
  if (normalized === "none" && supportedReasoningLevels.includes("low")) {
    return "low";
  }
  if (normalized === "xhigh" && supportedReasoningLevels.includes("high")) {
    return "high";
  }
  if (normalized === "max") {
    if (supportedReasoningLevels.includes("xhigh")) {
      return "xhigh";
    }
    if (supportedReasoningLevels.includes("high")) {
      return "high";
    }
  }
  if (normalized === "ultra") {
    if (supportedReasoningLevels.includes("max")) {
      return "max";
    }
    if (supportedReasoningLevels.includes("xhigh")) {
      return "xhigh";
    }
    if (supportedReasoningLevels.includes("high")) {
      return "high";
    }
  }
  return catalogModel.defaultReasoningLevel;
}

export function normalizeCursorSdkThinkingLevel(level: string | undefined, modelId = "grok-4.5"): string {
  const model = modelCatalogService.getModel(modelId, "cursor-sdk");
  const defaultLevel = model?.defaultReasoningLevel ?? (modelId === "composer-2.5" ? "none" : "high");
  if (model && !model.supportsReasoning) {
    return defaultLevel;
  }

  const normalized = typeof level === "string" ? level.trim().toLowerCase() : "";
  switch (normalized) {
    case "none":
      return (model?.supportedReasoningLevels as readonly string[] | undefined)?.includes("none") ? "none" : "low";
    case "low":
    case "medium":
    case "high":
      return (model?.supportedReasoningLevels as readonly string[] | undefined)?.includes(normalized) ? normalized : defaultLevel;
    case "xhigh":
    case "x-high":
      return (model?.supportedReasoningLevels as readonly string[] | undefined)?.includes("xhigh") ? "xhigh" : "high";
    case "max":
    case "ultra":
      return defaultLevel;
    case "":
      return defaultLevel;
    default:
      return defaultLevel;
  }
}

function normalizeAnthropicThinkingLevel(level: string | undefined): string {
  const normalized = normalizeDescriptorThinkingLevel(level);
  if (normalized === "none") {
    return "low";
  }
  if (normalized === "xhigh" || normalized === "max" || normalized === "ultra") {
    return "high";
  }
  return normalized;
}

function normalizeDescriptorThinkingLevel(level: string | undefined): string {
  const normalized = typeof level === "string" ? level.trim().toLowerCase() : "";
  return normalized === "x-high" ? "xhigh" : (normalized || "xhigh");
}
