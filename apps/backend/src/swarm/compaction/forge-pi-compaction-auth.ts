import type { ManagerExactModelSelection } from "@forge/protocol";
import type { Api, Model } from "../pi/pi-ai-compat.js";
import { AuthStorage, type AuthCredential, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { CompactionRuntimeSettingsSnapshot } from "../compaction-runtime-settings-provider.js";
import type { CredentialPoolService } from "../credential-pool.js";
import { ensureCanonicalAuthFilePath } from "../auth-storage-paths.js";
import type {
  OpenAIAuthBrokerLeaseHandle,
  OpenAIAuthBrokerRuntimeService,
} from "../openai-auth/openai-auth-broker-runtime-service.js";
import { createPiModelRegistry } from "../pi-model-registry.js";
import { normalizeRuntimeError } from "../runtime-utils.js";
import { resolveExactModel } from "../swarm-manager-utils.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import { ForgePiCompactionError } from "./forge-pi-compaction.js";

export type ForgePiCompactionAuthSource = "broker" | "pool" | "local" | "active_runtime_registry";

export interface ResolvedForgePiCompactionAuth {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
  authSource: ForgePiCompactionAuthSource;
  markExecutionAttempted?: () => void;
  executionAttempted?: () => boolean;
  complete?: (result: ForgePiCompactionAuthCompletion) => Promise<void>;
}

export type ForgePiCompactionAuthCompletion =
  | { outcome: "success" }
  | { outcome: "failure"; error?: unknown; executionAttempted?: boolean };

export interface ConfiguredForgePiCompactionAuthResolverOptions {
  config: SwarmConfig;
  descriptor: AgentDescriptor;
  getPiModelsJsonPath: () => string;
  getCredentialPoolService?: () => CredentialPoolService;
  getOpenAIAuthBrokerRuntimeService?: () => OpenAIAuthBrokerRuntimeService;
}

export interface ResolveConfiguredForgePiCompactionAuthOptions {
  compactionSettings: CompactionRuntimeSettingsSnapshot;
  sessionModel?: Model<Api>;
}

const POOLED_PROVIDERS = new Set(["openai-codex", "anthropic"]);
const CONFIGURED_AUTH_POLICY = "configured_compaction_provider_auth";
const NO_DEFAULT_FALLBACK_POLICY = "reject_without_default_compaction_fallback";

export function createConfiguredForgePiCompactionAuthResolver(
  options: ConfiguredForgePiCompactionAuthResolverOptions,
): (request: ResolveConfiguredForgePiCompactionAuthOptions) => Promise<ResolvedForgePiCompactionAuth> {
  return (request) => resolveConfiguredForgePiCompactionAuth({ ...options, ...request });
}

export async function resolveConfiguredForgePiCompactionAuth(
  options: ConfiguredForgePiCompactionAuthResolverOptions & ResolveConfiguredForgePiCompactionAuthOptions,
): Promise<ResolvedForgePiCompactionAuth> {
  const provider = normalizeProviderId(options.compactionSettings.model.provider);
  const brokerRuntimeService = options.getOpenAIAuthBrokerRuntimeService?.();
  const useBrokerAuth = provider === "openai-codex" && brokerRuntimeService
    ? await brokerRuntimeService.isBrokerModeActive()
    : false;

  let brokerHandle: OpenAIAuthBrokerLeaseHandle | undefined;
  let brokerCompletion: BrokerCompactionCompletion | undefined;

  try {
    let authStorage: AuthStorage;
    let authSource: ForgePiCompactionAuthSource;

    if (useBrokerAuth && brokerRuntimeService) {
      const prepared = await brokerRuntimeService.acquireForRuntime(options.descriptor);
      authStorage = prepared.authStorage;
      brokerHandle = prepared.handle;
      brokerCompletion = createBrokerCompletion(brokerRuntimeService, brokerHandle);
      authSource = "broker";
    } else {
      const pooled = await selectPooledCompactionCredential(provider, options.getCredentialPoolService?.());
      if (pooled) {
        authStorage = pooled.authStorage;
        authSource = "pool";
      } else {
        const authFilePath = await ensureCanonicalAuthFilePath(options.config);
        authStorage = AuthStorage.create(authFilePath);
        authSource = "local";
      }
    }

    const modelRegistry = createPiModelRegistry(authStorage, options.getPiModelsJsonPath());
    const compactionModel = resolveConfiguredCompactionModel(modelRegistry, options.compactionSettings.model);
    if (!compactionModel) {
      throw createModelUnavailableError({
        descriptor: options.descriptor,
        modelSelection: options.compactionSettings.model,
        sessionModel: options.sessionModel,
        authSource,
      });
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(compactionModel);
    if (!auth.ok) {
      throw createAuthUnavailableError({
        descriptor: options.descriptor,
        modelSelection: options.compactionSettings.model,
        sessionModel: options.sessionModel,
        authSource,
        reason: auth.error,
      });
    }

    if (!auth.apiKey) {
      throw createAuthModeUnsupportedError({
        descriptor: options.descriptor,
        modelSelection: options.compactionSettings.model,
        sessionModel: options.sessionModel,
        authSource,
      });
    }

    return {
      model: compactionModel,
      apiKey: auth.apiKey,
      headers: auth.headers,
      authSource,
      ...(brokerCompletion
        ? {
            complete: brokerCompletion.complete,
            markExecutionAttempted: brokerCompletion.markExecutionAttempted,
            executionAttempted: brokerCompletion.executionAttempted,
          }
        : {}),
    };
  } catch (error) {
    if (brokerCompletion) {
      await brokerCompletion.releaseWithoutReport("compaction_auth_resolution_failed");
    } else if (brokerHandle && brokerRuntimeService) {
      await brokerRuntimeService.release(brokerHandle, "compaction_auth_resolution_failed");
    }
    throw error;
  }
}

async function selectPooledCompactionCredential(
  provider: string,
  pool: CredentialPoolService | undefined,
): Promise<{ authStorage: AuthStorage; credentialId: string } | null> {
  if (!pool || !POOLED_PROVIDERS.has(provider)) {
    return null;
  }

  const poolSize = await pool.getPoolSize(provider);
  if (poolSize <= 1) {
    return null;
  }

  const selection = await pool.select(provider);
  if (!selection) {
    const earliestCooldownExpiry = await pool.getEarliestCooldownExpiry(provider);
    const resetMessage = earliestCooldownExpiry
      ? ` Earliest cooldown reset: ${new Date(earliestCooldownExpiry).toISOString()}.`
      : " No cooldown reset time is currently available.";
    throw new Error(`All pooled ${provider} credentials are unavailable.${resetMessage}`);
  }

  try {
    const authData = await pool.buildRuntimeAuthData(provider, selection.credentialId);
    const authStorage = AuthStorage.inMemory(authData as Record<string, AuthCredential>);
    await pool.markUsed(provider, selection.credentialId);
    return { authStorage, credentialId: selection.credentialId };
  } catch {
    // Mirror PiRuntimeCreator.selectPooledCredential(): if a selected credential cannot be
    // materialized, continue with local auth instead of widening pool behavior in this fix.
    return null;
  }
}

function resolveConfiguredCompactionModel(
  modelRegistry: ModelRegistry,
  modelSelection: ManagerExactModelSelection,
): Model<Api> | undefined {
  return resolveExactModel(modelRegistry, {
    provider: modelSelection.provider,
    modelId: modelSelection.modelId,
    thinkingLevel: "none",
  });
}

function createModelUnavailableError(options: {
  descriptor: AgentDescriptor;
  modelSelection: ManagerExactModelSelection;
  sessionModel?: Model<Api>;
  authSource: ForgePiCompactionAuthSource;
}): ForgePiCompactionError {
  return new ForgePiCompactionError(
    `Configured compaction model is unavailable for ${options.descriptor.agentId}`,
    buildFailureDetails(options, "forge_compaction_model_unavailable"),
  );
}

function createAuthUnavailableError(options: {
  descriptor: AgentDescriptor;
  modelSelection: ManagerExactModelSelection;
  sessionModel?: Model<Api>;
  authSource: ForgePiCompactionAuthSource;
  reason: string;
}): ForgePiCompactionError {
  return new ForgePiCompactionError(
    `Compaction auth unavailable for configured model on ${options.descriptor.agentId}: ${options.reason}`,
    {
      ...buildFailureDetails(options, "forge_compaction_auth_unavailable"),
      authError: options.reason,
    },
  );
}

function createAuthModeUnsupportedError(options: {
  descriptor: AgentDescriptor;
  modelSelection: ManagerExactModelSelection;
  sessionModel?: Model<Api>;
  authSource: ForgePiCompactionAuthSource;
}): ForgePiCompactionError {
  return new ForgePiCompactionError(
    `Compaction auth for ${options.descriptor.agentId} does not expose a raw API key for the configured compaction model`,
    buildFailureDetails(options, "forge_compaction_auth_mode_unsupported"),
  );
}

function buildFailureDetails(options: {
  modelSelection: ManagerExactModelSelection;
  sessionModel?: Model<Api>;
  authSource: ForgePiCompactionAuthSource;
}, recoveryStage: string): Record<string, unknown> {
  return {
    recoveryStage,
    authPolicy: CONFIGURED_AUTH_POLICY,
    fallbackPolicy: NO_DEFAULT_FALLBACK_POLICY,
    authSource: options.authSource,
    configuredProvider: options.modelSelection.provider,
    configuredModelId: options.modelSelection.modelId,
    runtimeSessionProvider: options.sessionModel?.provider,
    runtimeSessionModelId: options.sessionModel?.id,
  };
}

interface BrokerCompactionCompletion {
  complete: (result: ForgePiCompactionAuthCompletion) => Promise<void>;
  markExecutionAttempted: () => void;
  executionAttempted: () => boolean;
  releaseWithoutReport: (reason: string) => Promise<void>;
}

function createBrokerCompletion(
  service: OpenAIAuthBrokerRuntimeService,
  handle: OpenAIAuthBrokerLeaseHandle,
): BrokerCompactionCompletion {
  let completed = false;
  let attemptedExecution = false;

  const finishOnce = async (
    result: ForgePiCompactionAuthCompletion,
    options: { reportFailure: boolean; releaseReason: string },
  ): Promise<void> => {
    if (completed) {
      return;
    }
    completed = true;

    let releaseHandle = handle;
    try {
      if (result.outcome === "success") {
        releaseHandle = await service.report(handle, "success");
      } else if (options.reportFailure) {
        const normalized = normalizeRuntimeError(result.error);
        releaseHandle = await service.report(handle, "runtime_error", {
          message: sanitizeBrokerReportMessage(normalized.message),
        });
      }
    } catch {
      // Broker reporting must not mask the compaction result.
    } finally {
      await service.release(releaseHandle, options.releaseReason);
    }
  };

  return {
    markExecutionAttempted: () => {
      attemptedExecution = true;
    },
    executionAttempted: () => attemptedExecution,
    complete: async (result) => {
      const executionAttempted = result.outcome === "success"
        || result.executionAttempted === true
        || attemptedExecution;
      await finishOnce(result, {
        reportFailure: result.outcome === "failure" && executionAttempted,
        releaseReason: result.outcome === "success"
          ? "compaction_success"
          : executionAttempted
            ? "compaction_failure"
            : "compaction_cleanup",
      });
    },
    releaseWithoutReport: async (reason) => {
      await finishOnce({ outcome: "failure" }, { reportFailure: false, releaseReason: reason });
    },
  };
}

function sanitizeBrokerReportMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const redacted = normalized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted-long-token]");
  return redacted.length <= 240 ? redacted : `${redacted.slice(0, 237)}...`;
}

function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}
