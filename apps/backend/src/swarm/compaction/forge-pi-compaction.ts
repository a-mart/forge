import type { ManagerExactModelSelection, ManagerReasoningLevel } from "@forge/protocol";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { compact as runPiCompaction, type CompactionResult } from "@mariozechner/pi-coding-agent";
import type { CompactionRuntimeSettingsSnapshot } from "../compaction-runtime-settings-provider.js";
import { normalizeThinkingLevelForProvider, resolveExactModel } from "../swarm-manager-utils.js";
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
  /**
   * Deferred parity gaps (not passed through Pi compact helper today):
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
    deferredProviderParity: [
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
      `Configured compaction model is unavailable for ${options.descriptor.agentId}`,
      {
        recoveryStage: "forge_compaction_model_unavailable",
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
      `Compaction auth unavailable for configured model on ${options.descriptor.agentId}: ${auth.error}`,
      {
        recoveryStage: "forge_compaction_auth_unavailable",
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

  options.logDebug(
    "compaction:forge:start",
    buildForgeCompactionStartInstrumentation({
      compactionSettings: options.compactionSettings,
      sessionModel,
      customInstructions: options.combinedInstructions,
      pinnedInstructionsMerged: options.pinnedInstructionsMerged,
      providerOptions,
    }) as unknown as Record<string, unknown>,
  );

  return runPiCompaction(
    options.event.preparation,
    compactionModel,
    auth.apiKey,
    auth.headers,
    options.combinedInstructions,
    options.event.signal,
    thinkingLevel,
  );
}
