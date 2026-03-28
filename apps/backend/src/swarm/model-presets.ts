import type { ModelPresetInfo, ModelVariantInfo } from "@forge/protocol";
import type { AgentModelDescriptor, SwarmModelPreset, SwarmReasoningLevel } from "./types.js";
import { SWARM_MODEL_PRESETS, SWARM_REASONING_LEVELS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";

export const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
  "pi-codex": {
    provider: "openai-codex",
    modelId: "gpt-5.3-codex",
    thinkingLevel: "xhigh"
  },
  "pi-5.4": {
    provider: "openai-codex",
    modelId: "gpt-5.4",
    thinkingLevel: "xhigh"
  },
  "pi-grok": {
    provider: "xai",
    modelId: "grok-4",
    thinkingLevel: "high"
  },
  "pi-opus": {
    // Anthropic OAuth tokens trigger Claude Code auth headers in pi-ai,
    // matching the existing Claude Code integration path.
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    thinkingLevel: "xhigh"
  },
  "codex-app": {
    provider: "openai-codex-app-server",
    modelId: "default",
    thinkingLevel: "xhigh"
  }
};

const MODEL_PRESET_DISPLAY_INFO: Record<SwarmModelPreset, {
  displayName: string;
  variants?: ModelVariantInfo[];
}> = {
  "pi-codex": {
    displayName: "GPT-5.3 Codex",
    variants: [
      {
        modelId: "gpt-5.3-codex-spark",
        label: "GPT-5.3 Codex Spark"
      }
    ]
  },
  "pi-5.4": {
    displayName: "GPT-5.4",
    variants: [
      {
        modelId: "gpt-5.4-mini",
        label: "GPT-5.4 Mini"
      },
      {
        modelId: "gpt-5.4-nano",
        label: "GPT-5.4 Nano"
      }
    ]
  },
  "pi-opus": {
    displayName: "Claude Opus 4.6",
    variants: [
      {
        modelId: "claude-sonnet-4-5-20250929",
        label: "Claude Sonnet 4.5"
      },
      {
        modelId: "claude-haiku-4-5-20251001",
        label: "Claude Haiku 4.5"
      }
    ]
  },
  "pi-grok": {
    displayName: "Grok 4",
    variants: [
      {
        modelId: "grok-4-fast",
        label: "Grok 4 Fast"
      },
      {
        modelId: "grok-3",
        label: "Grok 3"
      }
    ]
  },
  "codex-app": {
    displayName: "Codex App Runtime"
  }
};

const FULL_REASONING_LEVELS = [...SWARM_REASONING_LEVELS];
const ANTHROPIC_REASONING_LEVELS: SwarmReasoningLevel[] = ["low", "medium", "high"];

const VALID_SWARM_MODEL_PRESET_VALUES = new Set<string>(SWARM_MODEL_PRESETS);
const VALID_SWARM_REASONING_LEVEL_VALUES = new Set<string>(SWARM_REASONING_LEVELS);
const KNOWN_MODEL_IDS = buildKnownModelIdSet();

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
  fieldName: string
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
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    return null;
  }

  if (normalizedModelId === "default") {
    return "openai-codex-app-server";
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

export function isKnownModelId(modelId: string): boolean {
  const normalizedModelId = modelId.trim().toLowerCase();
  return normalizedModelId.length > 0 && KNOWN_MODEL_IDS.has(normalizedModelId);
}

export function getModelPresetInfoList(): ModelPresetInfo[] {
  return SWARM_MODEL_PRESETS.map((presetId) => {
    const descriptor = MODEL_PRESET_DESCRIPTORS[presetId];
    const displayInfo = MODEL_PRESET_DISPLAY_INFO[presetId];
    const supportedReasoningLevels = getSupportedReasoningLevelsForPreset(presetId);
    const defaultReasoningLevel = normalizeDefaultReasoningLevelForPreset(
      presetId,
      descriptor.thinkingLevel
    );

    return {
      presetId,
      displayName: displayInfo.displayName,
      provider: descriptor.provider,
      modelId: descriptor.modelId,
      defaultReasoningLevel,
      supportedReasoningLevels,
      variants: displayInfo.variants?.map((variant) => ({ ...variant }))
    };
  });
}

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

export function inferSwarmModelPresetFromDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined
): SwarmModelPreset | undefined {
  if (!descriptor) {
    return undefined;
  }

  const provider = descriptor.provider?.trim().toLowerCase();
  const modelId = descriptor.modelId?.trim().toLowerCase();

  if (provider === "openai-codex" && modelId === "gpt-5.3-codex") {
    return "pi-codex";
  }

  if (provider === "openai-codex" && modelId === "gpt-5.4") {
    return "pi-5.4";
  }

  if (provider === "anthropic" && modelId === "claude-opus-4-6") {
    return "pi-opus";
  }

  if (provider === "xai" && (modelId === "grok-4" || modelId === "grok-4-fast" || modelId === "grok-3")) {
    return "pi-grok";
  }

  if (provider === "openai-codex-app-server" && modelId === "default") {
    return "codex-app";
  }

  return undefined;
}

export function normalizeSwarmModelDescriptor(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId"> | undefined,
  fallbackPreset: SwarmModelPreset = DEFAULT_SWARM_MODEL_PRESET
): AgentModelDescriptor {
  const preset = inferSwarmModelPresetFromDescriptor(descriptor) ?? fallbackPreset;
  return resolveModelDescriptorFromPreset(preset);
}

function buildKnownModelIdSet(): Set<string> {
  const knownModelIds = new Set<string>();

  for (const descriptor of Object.values(MODEL_PRESET_DESCRIPTORS)) {
    knownModelIds.add(descriptor.modelId.toLowerCase());
  }

  for (const presetInfo of getModelPresetInfoList()) {
    knownModelIds.add(presetInfo.modelId.toLowerCase());

    for (const variant of presetInfo.variants ?? []) {
      knownModelIds.add(variant.modelId.toLowerCase());
    }
  }

  return knownModelIds;
}

function getSupportedReasoningLevelsForPreset(presetId: SwarmModelPreset): SwarmReasoningLevel[] {
  if (presetId === "pi-opus") {
    return [...ANTHROPIC_REASONING_LEVELS];
  }

  return [...FULL_REASONING_LEVELS];
}

function normalizeDefaultReasoningLevelForPreset(
  presetId: SwarmModelPreset,
  rawLevel: string
): SwarmReasoningLevel {
  const normalizedLevel = isSwarmReasoningLevel(rawLevel) ? rawLevel : "high";

  if (presetId !== "pi-opus") {
    return normalizedLevel;
  }

  if (normalizedLevel === "none") {
    return "low";
  }

  if (normalizedLevel === "xhigh") {
    return "high";
  }

  return normalizedLevel;
}

