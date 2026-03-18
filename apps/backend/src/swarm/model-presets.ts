import { AuthStorage } from "@mariozechner/pi-coding-agent";
import { ensureCanonicalAuthFilePath } from "./auth-storage-paths.js";
import type { AgentModelDescriptor, SwarmConfig, SwarmModelPreset, SwarmReasoningLevel } from "./types.js";
import { SWARM_MODEL_PRESETS, SWARM_REASONING_LEVELS } from "./types.js";

export const DEFAULT_SWARM_MODEL_PRESET: SwarmModelPreset = "pi-codex";
export const ONBOARDING_MANAGER_MODEL_PRESET_PRIORITY = ["pi-opus", "pi-5.4"] as const satisfies readonly SwarmModelPreset[];

const MODEL_PRESET_DESCRIPTORS: Record<SwarmModelPreset, AgentModelDescriptor> = {
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

export function resolveModelDescriptorFromPreset(preset: SwarmModelPreset): AgentModelDescriptor {
  const descriptor = MODEL_PRESET_DESCRIPTORS[preset];
  return {
    provider: descriptor.provider,
    modelId: descriptor.modelId,
    thinkingLevel: descriptor.thinkingLevel
  };
}

export async function resolveOnboardingManagerModelDescriptor(
  config: Pick<SwarmConfig, "paths">
): Promise<AgentModelDescriptor> {
  const authFilePath = await ensureCanonicalAuthFilePath(config);
  const authStorage = AuthStorage.create(authFilePath);

  if (hasConfiguredAuthCredential(authStorage.get("anthropic"))) {
    return resolveModelDescriptorFromPreset("pi-opus");
  }

  return resolveModelDescriptorFromPreset("pi-5.4");
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

function hasConfiguredAuthCredential(credential: unknown): boolean {
  if (!credential || typeof credential !== "object") {
    return false;
  }

  const candidate = credential as {
    key?: string;
    access?: string;
    accessToken?: string;
    token?: string;
  };

  return [candidate.key, candidate.access, candidate.accessToken, candidate.token].some(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}
