import { FORGE_MODEL_CATALOG } from "@forge/protocol";
import type { ModelPresetInfo } from "@forge/protocol";
import type { AgentModelDescriptor, SwarmModelPreset, SwarmReasoningLevel } from "../types.js";
import { SWARM_MODEL_PRESETS, SWARM_REASONING_LEVELS } from "../types.js";
import { modelCatalogService } from "./model-catalog-service.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

export const MODEL_PRESET_DESCRIPTORS: Record<string, AgentModelDescriptor> = Object.fromEntries(
  Object.values(FORGE_MODEL_CATALOG.families).map((family) => [
    family.familyId,
    {
      provider: family.provider,
      modelId: family.defaultModelId,
      thinkingLevel: family.defaultReasoningLevel,
    },
  ]),
);

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

  if (normalizedModelId === "default") {
    return "openai-codex-app-server";
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

export function isKnownModelId(modelId: string): boolean {
  return modelCatalogService.isKnownModelId(modelId);
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
