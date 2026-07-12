import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { getSessionDir } from "../data-paths.js";
import { combineCompactionCustomInstructions, loadPins } from "../message-pins.js";
import { appendSessionPlanCompactionInstructions } from "../planning/session-plan-context.js";
import { SessionPlanStore } from "../planning/session-plan-store.js";
import type { Api, Model } from "../pi/pi-ai-compat.js";
import type { CompactionRuntimeSettingsSnapshot } from "../compaction-runtime-settings-provider.js";
import type { ResolvedForgePiCompactionAuth } from "./forge-pi-compaction-auth.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import {
  ForgePiCompactionError,
  runForgePiCompaction,
} from "./forge-pi-compaction.js";

export type ForgePiCompactionFailureKind =
  | "user_cancel"
  | "configured_model_unavailable"
  | "configured_auth_unavailable"
  | "configured_auth_mode_unsupported"
  | "prompt_over_budget"
  | "provider_failure";

export interface ForgePiCompactionFailureRecord {
  kind: ForgePiCompactionFailureKind;
  message: string;
  userFacingMessage: string;
  cancelledByUser: boolean;
  details: Record<string, unknown>;
}

const pendingForgePiCompactionFailures = new Map<string, ForgePiCompactionFailureRecord>();

export function buildForgePiCompactionFailureScopeKey(agentId: string, runtimeScope: string | number): string {
  return `${agentId}::${String(runtimeScope)}`;
}

export function rememberForgePiCompactionFailure(scopeKey: string, failure: ForgePiCompactionFailureRecord): void {
  pendingForgePiCompactionFailures.set(scopeKey, failure);
}

export function consumeForgePiCompactionFailure(scopeKey: string): ForgePiCompactionFailureRecord | undefined {
  const failure = pendingForgePiCompactionFailures.get(scopeKey);
  pendingForgePiCompactionFailures.delete(scopeKey);
  return failure;
}

export function clearForgePiCompactionFailure(scopeKey: string): void {
  pendingForgePiCompactionFailures.delete(scopeKey);
}

export function createForgePiCompactionExtensionFactory(options: {
  descriptor: AgentDescriptor;
  config: SwarmConfig;
  logDebug: (message: string, details?: unknown) => void;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
  resolveCompactionAuth?: (request: {
    compactionSettings: CompactionRuntimeSettingsSnapshot;
    sessionModel?: Model<Api>;
  }) => Promise<ResolvedForgePiCompactionAuth>;
  failureScopeKey?: string;
}): ExtensionFactory {
  const { descriptor } = options;
  const failureScopeKey = options.failureScopeKey ?? descriptor.agentId;

  return (pi) => {
    pi.on("session_before_compact", async (event, ctx) => {
      try {
        const sessionDir = getSessionDir(
          options.config.paths.dataDir,
          descriptor.profileId ?? descriptor.agentId,
          descriptor.agentId,
        );
        const registry = await loadPins(sessionDir);
        const existingInstructions = event.customInstructions?.trim() || undefined;
        const instructionsWithPins = combineCompactionCustomInstructions(existingInstructions, registry);
        const plan = descriptor.role === "manager" && descriptor.profileId
          ? await new SessionPlanStore({
              dataDir: options.config.paths.dataDir,
              profileId: descriptor.profileId,
              sessionAgentId: descriptor.agentId,
            }).load()
          : undefined;
        const combinedInstructions = plan
          ? appendSessionPlanCompactionInstructions(instructionsWithPins, plan)
          : instructionsWithPins;
        const pinnedInstructionsMerged = Boolean(
          combinedInstructions
            && combinedInstructions !== existingInstructions
            && Object.keys(registry.pins).length > 0,
        );

        const compactionSettings = options.getCompactionRuntimeSettingsProvider().getCompactionRuntimeSettings();
        let compactionAuth: ResolvedForgePiCompactionAuth | undefined;
        let compactionAuthCompleted = false;
        try {
          compactionAuth = await options.resolveCompactionAuth?.({
            compactionSettings,
            sessionModel: ctx.model,
          });
          const compaction = await runForgePiCompaction({
            event,
            ctx,
            descriptor,
            compactionSettings,
            combinedInstructions,
            pinnedInstructionsMerged,
            compactionAuth,
            logDebug: options.logDebug,
          });

          await compactionAuth?.complete?.({ outcome: "success" });
          compactionAuthCompleted = true;
          clearForgePiCompactionFailure(failureScopeKey);
          return { compaction };
        } catch (error) {
          if (!compactionAuthCompleted) {
            await compactionAuth?.complete?.({
              outcome: "failure",
              error,
              executionAttempted: compactionAuth?.executionAttempted?.() === true,
            });
          }
          throw error;
        }
      } catch (error) {
        const failure = buildForgePiCompactionFailureRecord(descriptor, error, event.signal);

        if (failure.cancelledByUser) {
          clearForgePiCompactionFailure(failureScopeKey);
          return { cancel: true };
        }

        rememberForgePiCompactionFailure(failureScopeKey, failure);
        console.warn(`[swarm] Forge compaction cancelled for ${descriptor.agentId}: ${failure.message}`, failure.details);
        ctx.ui.notify(failure.userFacingMessage, "error");

        // Pi's ExtensionRunner intentionally swallows thrown handler errors. Returning the
        // supported cancel result is the only fail-closed boundary that prevents AgentSession
        // from falling through to default active-model compaction after a Forge-owned failure.
        return { cancel: true };
      }
    });
  };
}

export function buildForgePiCompactionFailureRecord(
  descriptor: AgentDescriptor,
  error: unknown,
  signal?: AbortSignal,
): ForgePiCompactionFailureRecord {
  if (isUserCancelledCompaction(error, signal)) {
    return {
      kind: "user_cancel",
      message: "Compaction cancelled.",
      userFacingMessage: "Compaction cancelled.",
      cancelledByUser: true,
      details: {
        compactionCancelled: true,
        compactionCancelledByUser: true,
        compactionRetryPlanned: false,
        cancelKind: "user_cancel",
        recoveryStage: "forge_compaction_cancelled",
        userFacingMessage: "Compaction cancelled.",
      },
    };
  }

  if (error instanceof ForgePiCompactionError) {
    return buildForgeFailureRecord(error);
  }

  const rawMessage = sanitizeCompactionFailureMessage(error instanceof Error ? error.message : String(error));
  const message = `Configured compaction request failed for ${descriptor.agentId}: ${rawMessage}`;
  const userFacingMessage = "Configured compaction failed. Check the configured provider/model authentication and try again.";
  return {
    kind: "provider_failure",
    message,
    userFacingMessage,
    cancelledByUser: false,
    details: {
      recoveryStage: "forge_compaction_provider_failure",
      compactionCancelled: true,
      compactionRetryPlanned: false,
      cancelKind: "provider_failure",
      rawCauseMessage: rawMessage,
      userFacingMessage,
    },
  };
}

function buildForgeFailureRecord(error: ForgePiCompactionError): ForgePiCompactionFailureRecord {
  const recoveryStage = String(error.details.recoveryStage ?? "forge_compaction_failed");
  const rawMessage = sanitizeCompactionFailureMessage(error.message);

  switch (recoveryStage) {
    case "forge_compaction_model_unavailable": {
      const userFacingMessage = "Configured compaction model is unavailable. Choose a different compaction model or authenticate that provider.";
      return {
        kind: "configured_model_unavailable",
        message: rawMessage,
        userFacingMessage,
        cancelledByUser: false,
        details: {
          ...error.details,
          compactionCancelled: true,
          compactionRetryPlanned: false,
          cancelKind: "configured_model_unavailable",
          rawCauseMessage: rawMessage,
          userFacingMessage,
        },
      };
    }

    case "forge_compaction_auth_unavailable": {
      const userFacingMessage = "Configured compaction auth is unavailable. Check Authentication or choose a different compaction model.";
      return {
        kind: "configured_auth_unavailable",
        message: rawMessage,
        userFacingMessage,
        cancelledByUser: false,
        details: {
          ...error.details,
          compactionCancelled: true,
          compactionRetryPlanned: false,
          cancelKind: "configured_auth_unavailable",
          rawCauseMessage: rawMessage,
          userFacingMessage,
        },
      };
    }

    case "forge_compaction_auth_mode_unsupported": {
      const userFacingMessage = "Configured compaction auth could not be converted into a raw API key for Pi compaction. Use a supported auth mode or choose a different compaction model.";
      return {
        kind: "configured_auth_mode_unsupported",
        message: rawMessage,
        userFacingMessage,
        cancelledByUser: false,
        details: {
          ...error.details,
          compactionCancelled: true,
          compactionRetryPlanned: false,
          cancelKind: "configured_auth_mode_unsupported",
          rawCauseMessage: rawMessage,
          userFacingMessage,
        },
      };
    }

    case "forge_compaction_prompt_over_budget": {
      const userFacingMessage = "Configured compaction could not fit within the safe prompt-size budget after redaction and reduction. Trim older context or pinned instructions, then retry.";
      return {
        kind: "prompt_over_budget",
        message: rawMessage,
        userFacingMessage,
        cancelledByUser: false,
        details: {
          ...error.details,
          compactionCancelled: true,
          compactionRetryPlanned: false,
          cancelKind: "prompt_over_budget",
          rawCauseMessage: rawMessage,
          userFacingMessage,
        },
      };
    }

    default: {
      const userFacingMessage = "Configured compaction failed. Check the configured provider/model authentication and try again.";
      return {
        kind: "provider_failure",
        message: rawMessage,
        userFacingMessage,
        cancelledByUser: false,
        details: {
          ...error.details,
          compactionCancelled: true,
          compactionRetryPlanned: false,
          cancelKind: "provider_failure",
          rawCauseMessage: rawMessage,
          userFacingMessage,
        },
      };
    }
  }
}

function sanitizeCompactionFailureMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const redactedSecrets = normalized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted-long-token]");
  return redactedSecrets.length <= 240 ? redactedSecrets : `${redactedSecrets.slice(0, 237)}...`;
}

export function isUserCancelledCompaction(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.trim();
  return error.name === "AbortError"
    || message === "Compaction cancelled"
    || /request was aborted/i.test(message)
    || /cancelled by user/i.test(message);
}
