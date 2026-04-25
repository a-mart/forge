import type { ModelPresetInfo } from "@forge/protocol";
import type { AgentModelDescriptor, SwarmModelPreset, SwarmReasoningLevel } from "../types.js";
import { SWARM_MODEL_PRESETS, SWARM_REASONING_LEVELS } from "../types.js";
import { modelCatalogService } from "./model-catalog-service.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

const REMOVED_PRESET_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "codex-app": "pi-codex",
};

const REMOVED_PROVIDER_REPLACEMENTS: Record<string, SwarmModelPreset> = {
  "openai-codex-app-server": "pi-codex",
};

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_SWARM_REASONING_LEVEL_VALUES = new Set<string>(SWARM_REASONING_LEVELS);

export function describeSwarmModelPresets(): string {
  return SWARM_MODEL_PRESETS.join("|");
}

export function describeSwarmReasoningLevels(): string {
  return SWARM_REASONING_LEVELS.join("|");
}

export function isSwarmModelPreset(value: unknown): value is SwarmModelPreset {
  return typeof value === "string" && VALID_SWARM_MODEL_PRESET_VALUES.has(value);
}

export function isSwarmReasoningLevel(value: unknown): value is SwarmReasoningLevel {
  return typeof value === "string" && VALID_SWARM_REASONING_LEVEL_VALUES.has(value);
}

export function parseSwarmModelPreset(value: unknown, fieldName: string): SwarmModelPreset | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSwarmModelPreset(value)) {
    throw new Error(`${fieldName} must be one of ${describeSwarmModelPresets()}`);
  }

  return value;
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
  const preset = inferSwarmModelPresetFromDescriptor(descriptor) ?? fallbackPreset;
  return resolveModelDescriptorFromPreset(preset);
}

export function resolveRemovedSwarmModelPresetAlias(preset: string): SwarmModelPreset | undefined {
  const normalizedPreset = preset.trim().toLowerCase();
  return REMOVED_PRESET_REPLACEMENTS[normalizedPreset];
}

export function normalizePersistedSwarmModelDescriptor(
  descriptor: (Pick<AgentModelDescriptor, "provider" | "modelId"> & { thinkingLevel?: string }) | undefined,
): AgentModelDescriptor | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider.trim().toLowerCase();
  const replacementPreset = REMOVED_PROVIDER_REPLACEMENTS[provider];
  if (!replacementPreset) {
    return {
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      thinkingLevel: normalizeDescriptorThinkingLevel(descriptor.thinkingLevel),
    };
  }

  const replacement = resolveModelDescriptorFromPreset(replacementPreset);
  return {
    ...replacement,
    thinkingLevel: normalizeDescriptorThinkingLevel(descriptor.thinkingLevel) ?? replacement.thinkingLevel,
  };
}

function normalizeDescriptorThinkingLevel(level: string | undefined): string {
  return typeof level === "string" && level === "x-high" ? "xhigh" : (level ?? "xhigh");
}
