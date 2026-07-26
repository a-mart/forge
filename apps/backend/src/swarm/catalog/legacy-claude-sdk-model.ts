import type { AgentModelDescriptor } from "../types.js";

export const CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE =
  "Claude SDK has been retired. Choose a native Anthropic model in Forge (for example pi-opus or pi-sonnet); Claude Code login credentials are not transferred.";

const CURRENT_NATIVE_MODEL_IDS = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
]);

const RETIRED_NATIVE_REPLACEMENTS = new Map<string, string>([
  ["claude-sonnet-4-5-20250929", "claude-sonnet-5"],
  ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
  ["claude-sonnet-4.5", "claude-sonnet-5"],
  ["claude-haiku-4.5", "claude-sonnet-5"],
  ["claude-sonnet-4-5", "claude-sonnet-5"],
  ["claude-haiku-4-5", "claude-sonnet-5"],
]);

export type LegacyClaudeSdkModelMapping =
  | { kind: "not_legacy" }
  | { kind: "mapped"; provider: "anthropic"; modelId: string }
  | { kind: "unavailable"; provider: "claude-sdk"; modelId: string; message: string };

/** Pure compatibility mapping for persisted Claude SDK descriptors only. */
export function mapLegacyClaudeSdkModel(
  descriptor: Pick<AgentModelDescriptor, "provider" | "modelId">,
): LegacyClaudeSdkModelMapping {
  const provider = descriptor.provider.trim().toLowerCase();
  if (provider !== "claude-sdk") {
    return { kind: "not_legacy" };
  }

  const modelId = stripProviderPrefix(descriptor.modelId.trim().toLowerCase());
  if (CURRENT_NATIVE_MODEL_IDS.has(modelId)) {
    return { kind: "mapped", provider: "anthropic", modelId };
  }

  const replacement = RETIRED_NATIVE_REPLACEMENTS.get(modelId);
  if (replacement) {
    return { kind: "mapped", provider: "anthropic", modelId: replacement };
  }

  return {
    kind: "unavailable",
    provider: "claude-sdk",
    modelId,
    message: `${CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE} The saved model claude-sdk/${modelId || "unknown"} is unavailable.`,
  };
}

export function assertClaudeSdkProviderNotSelected(provider: string, fieldName: string): void {
  if (provider.trim().toLowerCase() === "claude-sdk") {
    throw new Error(`${fieldName}: ${CLAUDE_SDK_RETIRED_PROVIDER_MESSAGE}`);
  }
}

export function isLegacyClaudeSdkPreset(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "sdk-opus" || normalized === "sdk-sonnet";
}

function stripProviderPrefix(modelId: string): string {
  return modelId.startsWith("claude-sdk/") ? modelId.slice("claude-sdk/".length) : modelId;
}
