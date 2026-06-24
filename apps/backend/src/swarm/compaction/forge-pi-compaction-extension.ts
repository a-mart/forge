import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { CompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { getSessionDir } from "../data-paths.js";
import { combineCompactionCustomInstructions, loadPins } from "../message-pins.js";
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
  | "provider_failure";

export interface ForgePiCompactionFailureRecord {
  kind: ForgePiCompactionFailureKind;
  message: string;
  userFacingMessage: string;
  cancelledByUser: boolean;
  details: Record<string, unknown>;
}

const pendingForgePiCompactionFailures = new Map<string, ForgePiCompactionFailureRecord>();

export function rememberForgePiCompactionFailure(agentId: string, failure: ForgePiCompactionFailureRecord): void {
  pendingForgePiCompactionFailures.set(agentId, failure);
}

export function consumeForgePiCompactionFailure(agentId: string): ForgePiCompactionFailureRecord | undefined {
  const failure = pendingForgePiCompactionFailures.get(agentId);
  pendingForgePiCompactionFailures.delete(agentId);
  return failure;
}

export function clearForgePiCompactionFailure(agentId: string): void {
  pendingForgePiCompactionFailures.delete(agentId);
}

export function createForgePiCompactionExtensionFactory(options: {
  descriptor: AgentDescriptor;
  config: SwarmConfig;
  logDebug: (message: string, details?: unknown) => void;
  getCompactionRuntimeSettingsProvider: () => CompactionRuntimeSettingsProvider;
}): ExtensionFactory {
  const { descriptor } = options;

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
        const combinedInstructions = combineCompactionCustomInstructions(existingInstructions, registry);
        const pinnedInstructionsMerged = Boolean(
          combinedInstructions
            && combinedInstructions !== existingInstructions
            && Object.keys(registry.pins).length > 0,
        );

        const compactionSettings = options.getCompactionRuntimeSettingsProvider().getCompactionRuntimeSettings();
        const compaction = await runForgePiCompaction({
          event,
          ctx,
          descriptor,
          compactionSettings,
          combinedInstructions,
          pinnedInstructionsMerged,
          logDebug: options.logDebug,
        });

        clearForgePiCompactionFailure(descriptor.agentId);
        return { compaction };
      } catch (error) {
        const failure = buildForgePiCompactionFailureRecord(descriptor, error, event.signal);

        if (failure.cancelledByUser) {
          clearForgePiCompactionFailure(descriptor.agentId);
          return { cancel: true };
        }

        rememberForgePiCompactionFailure(descriptor.agentId, failure);
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

  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = `Configured compaction request failed for ${descriptor.agentId}: ${rawMessage}`;
  const userFacingMessage = `Configured compaction failed: ${rawMessage}`;
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
  const rawMessage = error.message;

  switch (recoveryStage) {
    case "forge_compaction_model_unavailable": {
      const userFacingMessage = "Configured compaction model is unavailable in the active runtime. Choose a different compaction model or authenticate that provider.";
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
      const userFacingMessage = "Configured compaction auth is unavailable in the active runtime. Check Authentication or choose a different compaction model.";
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

    default: {
      const userFacingMessage = `Configured compaction failed: ${rawMessage}`;
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
