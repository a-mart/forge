import {
  isOpenAICodexChatGptAuthAvailable,
  isServiceTierSupportedForModel,
  isSessionFastModeEnabled,
  type ForgeProviderCredentialSummary,
  type ForgeServiceTier,
  type OpenAICodexRequestServiceTier,
  type OpenAICodexReturnedServiceTier,
  type SessionFastModePolicy,
} from "@forge/protocol";
import type { AgentModelDescriptor } from "../types.js";

export const FAST_MODE_OAUTH_REQUIRED_MESSAGE =
  "Fast mode requires OpenAI Codex ChatGPT login. API-key OpenAI Codex credentials can use the default tier only.";

export interface SessionFastModePolicyValidationResult {
  ok: boolean;
  policy?: SessionFastModePolicy;
  reason?: "missing_oauth";
  message?: string;
}

export function validateSessionFastModePolicySelection(options: {
  enabled: boolean;
  credentialSummary?: ForgeProviderCredentialSummary;
  validationMode: "user_command" | "startup" | "auth_change";
  now?: () => string;
}): SessionFastModePolicyValidationResult {
  if (!options.enabled) {
    return { ok: true, policy: { enabled: false, updatedAt: options.now?.() } };
  }

  if (isOpenAICodexChatGptAuthAvailable(options.credentialSummary)) {
    return { ok: true, policy: { enabled: true, updatedAt: options.now?.() } };
  }

  if (options.validationMode === "user_command") {
    return { ok: false, reason: "missing_oauth", message: FAST_MODE_OAUTH_REQUIRED_MESSAGE };
  }

  return { ok: true, policy: { enabled: false, updatedAt: options.now?.() }, reason: "missing_oauth" };
}

export function resolveAgentServiceTierFromSessionPolicy(options: {
  model: AgentModelDescriptor;
  sessionPolicy?: SessionFastModePolicy;
  spawnOverride?: boolean | null;
  credentialSummary?: ForgeProviderCredentialSummary;
  source: "manager_runtime" | "worker_spawn" | "specialist_spawn" | "capacity_fallback" | "fallback_recovery" | "startup";
}): {
  model: AgentModelDescriptor;
  appliedTier?: ForgeServiceTier;
  ignoredReason?: "policy_disabled" | "explicit_standard" | "unsupported_model" | "auth_ineligible";
} {
  const explicitFast = options.spawnOverride === true;
  const explicitStandard = options.spawnOverride === false || options.spawnOverride === null;
  const wantsFast = explicitFast || (!explicitStandard && isSessionFastModeEnabled(options.sessionPolicy));

  if (explicitStandard) {
    return { model: stripServiceTier(options.model), ignoredReason: "explicit_standard" };
  }

  if (!wantsFast) {
    return { model: stripServiceTier(options.model), ignoredReason: "policy_disabled" };
  }

  if (!isServiceTierSupportedForModel(options.model, "priority")) {
    if (explicitFast) {
      throw new Error(`Fast mode is not supported for ${options.model.provider}/${options.model.modelId}.`);
    }
    return { model: stripServiceTier(options.model), ignoredReason: "unsupported_model" };
  }

  if (!isOpenAICodexChatGptAuthAvailable(options.credentialSummary)) {
    if (explicitFast) {
      throw new Error(FAST_MODE_OAUTH_REQUIRED_MESSAGE);
    }
    return { model: stripServiceTier(options.model), ignoredReason: "auth_ineligible" };
  }

  return { model: { ...options.model, serviceTier: "priority" }, appliedTier: "priority" };
}

export function applySessionFastModeToResolvedAgentModel(
  model: AgentModelDescriptor,
  options: Omit<Parameters<typeof resolveAgentServiceTierFromSessionPolicy>[0], "model">,
): AgentModelDescriptor {
  return resolveAgentServiceTierFromSessionPolicy({ model, ...options }).model;
}

export function stripServiceTier<T extends { serviceTier?: unknown }>(model: T): Omit<T, "serviceTier"> {
  const { serviceTier: _serviceTier, ...rest } = model;
  return rest;
}

export function toOpenAICodexPayloadServiceTier(
  tier: ForgeServiceTier | undefined,
  vocabulary: "priority" | "fast" = "priority",
): OpenAICodexRequestServiceTier | undefined {
  return tier === "priority" ? vocabulary : undefined;
}

export function normalizeReturnedOpenAICodexServiceTier(value: unknown): OpenAICodexReturnedServiceTier {
  if (typeof value !== "string") {
    return "unverified";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "default") {
    return "default";
  }
  if (normalized === "priority" || normalized === "fast") {
    return "priority";
  }
  return "unverified";
}

