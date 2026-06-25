import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { compact as runPiCompaction, type CompactionResult } from "@mariozechner/pi-coding-agent";
import type { CompactionRuntimeSettingsSnapshot } from "../compaction-runtime-settings-provider.js";
import { normalizeThinkingLevelForProvider, resolveExactModel } from "../swarm-manager-utils.js";
import {
  boundCompactionPreparation,
  type CompactionBoundingStats,
} from "./forge-pi-compaction-bounds.js";
import type { AgentDescriptor } from "../types.js";

type PiCompactionThinkingLevel = NonNullable<Parameters<typeof runPiCompaction>[6]>;

export class ForgePiCompactionError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "ForgePiCompactionError";
    this.details = details;
  }
}

export interface ForgeCompactionProviderOptionsPresence {
  hasSessionId: boolean;
  hasCacheKey: boolean;
  hasServiceTier: boolean;
  hasTransportMetadata: boolean;
  headerKeyCount: number;
}

/**
 * Redacted presence flags for provider request metadata available to Pi compaction.
 * Does not log header values or secrets.
 */
export function detectCompactionProviderOptionsPresence(
  headers: Record<string, string> | undefined,
): ForgeCompactionProviderOptionsPresence {
  const keys = headers ? Object.keys(headers).map((key) => key.toLowerCase()) : [];

  return {
    hasSessionId: keys.some((key) => key.includes("session")),
    hasCacheKey: keys.some((key) => key.includes("cache")),
    hasServiceTier: keys.some((key) => key.includes("service") || key.includes("tier")),
    hasTransportMetadata: keys.some((key) => key.includes("transport") || key.includes("ws")),
    headerKeyCount: keys.length,
  };
}

export interface ForgeCompactionStartInstrumentation {
  sourcePath: "forge_session_before_compact";
  configuredProvider: string;
  configuredModelId: string;
  configuredReasoningLevel: ManagerReasoningLevel;
  timeoutMs: number;
  runtimeSessionProvider?: string;
  runtimeSessionModelId?: string;
  customInstructionsPresent: boolean;
  pinnedInstructionsMerged: boolean;
  providerOptions: ForgeCompactionProviderOptionsPresence;
  bounding: CompactionBoundingStats;
  /**
   * Deferred parity gaps (not passed through Pi compact helper today):
   * - Cross-provider canonical auth resolver outside the active Pi runtime registry
   * - Catalog before_provider_request behaviors (xAI search/reasoning strip)
   * - Forge OpenAI Codex transport env override
   * - Explicit service-tier fields outside auth headers
   */
  deferredProviderParity: readonly string[];
}

export function buildForgeCompactionStartInstrumentation(options: {
  compactionSettings: CompactionRuntimeSettingsSnapshot;
  sessionModel: Model<Api> | undefined;
  customInstructions: string | undefined;
  pinnedInstructionsMerged: boolean;
  providerOptions: ForgeCompactionProviderOptionsPresence;
  bounding: CompactionBoundingStats;
}): ForgeCompactionStartInstrumentation {
  return {
    sourcePath: "forge_session_before_compact",
    configuredProvider: options.compactionSettings.model.provider,
    configuredModelId: options.compactionSettings.model.modelId,
    configuredReasoningLevel: options.compactionSettings.reasoningLevel,
    timeoutMs: options.compactionSettings.timeoutMs,
    runtimeSessionProvider: options.sessionModel?.provider,
    runtimeSessionModelId: options.sessionModel?.id,
    customInstructionsPresent: Boolean(options.customInstructions?.trim()),
    pinnedInstructionsMerged: options.pinnedInstructionsMerged,
    providerOptions: options.providerOptions,
    bounding: options.bounding,
    deferredProviderParity: [
      "cross_provider_canonical_auth_resolver",
      "catalog_before_provider_request_behaviors",
      "openai_codex_transport_env_override",
      "explicit_service_tier_field_outside_headers",
    ],
  };
}

export function resolveForgeCompactionModel(
  modelRegistry: ModelRegistry,
  modelSelection: ManagerExactModelSelection,
): Model<Api> | undefined {
  return resolveExactModel(modelRegistry, {
    provider: modelSelection.provider,
    modelId: modelSelection.modelId,
    thinkingLevel: "none",
  });
}

export function mapCompactionReasoningToPiThinkingLevel(
  provider: string,
  reasoningLevel: ManagerReasoningLevel,
): PiCompactionThinkingLevel {
  return normalizeThinkingLevelForProvider(provider, reasoningLevel) as PiCompactionThinkingLevel;
}

interface ForgePiCompactionHookEvent {
  preparation: Parameters<typeof runPiCompaction>[0];
  customInstructions?: string;
  signal?: AbortSignal;
}

interface ForgePiCompactionHookContext {
  model?: Model<Api>;
  modelRegistry: ModelRegistry;
}

export async function runForgePiCompaction(options: {
  event: ForgePiCompactionHookEvent;
  ctx: ForgePiCompactionHookContext;
  descriptor: AgentDescriptor;
  compactionSettings: CompactionRuntimeSettingsSnapshot;
  combinedInstructions: string | undefined;
  pinnedInstructionsMerged: boolean;
  logDebug: (message: string, details?: Record<string, unknown>) => void;
}): Promise<CompactionResult> {
  const sessionModel = options.ctx.model;
  const compactionModel = resolveForgeCompactionModel(
    options.ctx.modelRegistry,
    options.compactionSettings.model,
  );

  if (!compactionModel) {
    throw new ForgePiCompactionError(
      `Configured compaction model is unavailable in the active runtime registry for ${options.descriptor.agentId}`,
      {
        recoveryStage: "forge_compaction_model_unavailable",
        authPolicy: "active_runtime_registry_only",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        configuredProvider: options.compactionSettings.model.provider,
        configuredModelId: options.compactionSettings.model.modelId,
        runtimeSessionProvider: sessionModel?.provider,
        runtimeSessionModelId: sessionModel?.id,
      },
    );
  }

  const auth = await options.ctx.modelRegistry.getApiKeyAndHeaders(compactionModel);
  if (!auth.ok) {
    throw new ForgePiCompactionError(
      `Compaction auth unavailable in the active runtime registry for configured model on ${options.descriptor.agentId}: ${auth.error}`,
      {
        recoveryStage: "forge_compaction_auth_unavailable",
        authPolicy: "active_runtime_registry_only",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        configuredProvider: options.compactionSettings.model.provider,
        configuredModelId: options.compactionSettings.model.modelId,
        runtimeSessionProvider: sessionModel?.provider,
        runtimeSessionModelId: sessionModel?.id,
      },
    );
  }

  if (!auth.apiKey) {
    throw new ForgePiCompactionError(
      `Compaction auth for ${options.descriptor.agentId} does not expose a raw API key for the configured compaction model`,
      {
        recoveryStage: "forge_compaction_auth_mode_unsupported",
        authPolicy: "active_runtime_registry_only",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        configuredProvider: options.compactionSettings.model.provider,
        configuredModelId: options.compactionSettings.model.modelId,
        runtimeSessionProvider: sessionModel?.provider,
        runtimeSessionModelId: sessionModel?.id,
      },
    );
  }

  const providerOptions = detectCompactionProviderOptionsPresence(auth.headers);
  const thinkingLevel = mapCompactionReasoningToPiThinkingLevel(
    options.compactionSettings.model.provider,
    options.compactionSettings.reasoningLevel,
  );

  const bounded = boundCompactionPreparation(options.event.preparation, {
    customInstructions: options.combinedInstructions,
  });

  if (bounded.stats.promptChars.maxBounded > bounded.stats.maxPromptChars) {
    throw new ForgePiCompactionError(
      `Configured compaction prompt could not be reduced to the safe size budget for ${options.descriptor.agentId}`,
      {
        recoveryStage: "forge_compaction_prompt_over_budget",
        fallbackPolicy: "reject_without_default_compaction_fallback",
        configuredProvider: options.compactionSettings.model.provider,
        configuredModelId: options.compactionSettings.model.modelId,
        runtimeSessionProvider: sessionModel?.provider,
        runtimeSessionModelId: sessionModel?.id,
        maxPromptChars: bounded.stats.maxPromptChars,
        boundedPromptChars: bounded.stats.promptChars.maxBounded,
        previousSummaryPresent: bounded.stats.previousSummaryPresent,
        customInstructionsPresent: bounded.stats.customInstructionsPresent,
        truncationCounts: bounded.stats.truncationCounts,
      },
    );
  }

  options.logDebug(
    "compaction:forge:start",
    buildForgeCompactionStartInstrumentation({
      compactionSettings: options.compactionSettings,
      sessionModel,
      customInstructions: options.combinedInstructions,
      pinnedInstructionsMerged: options.pinnedInstructionsMerged,
      providerOptions,
      bounding: bounded.stats,
    }) as unknown as Record<string, unknown>,
  );

  const result = await runPiCompaction(
    bounded.preparation,
    compactionModel,
    auth.apiKey,
    auth.headers,
    options.combinedInstructions,
    options.event.signal,
    thinkingLevel,
  );

  return {
    ...result,
    details: {
      ...(isRecord(result.details) ? result.details : { piCompactionDetails: result.details }),
      forgeCompaction: {
        sourcePath: "forge_session_before_compact",
        bounding: bounded.stats,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
