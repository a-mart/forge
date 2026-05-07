import { basename } from "node:path";
import type { RuntimeErrorEvent } from "../runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent } from "../types.js";
import { readPositiveIntegerDetail, readStringDetail } from "../swarm-manager-utils.js";

export interface RuntimeErrorProjectorDeps {
  descriptors: Map<string, AgentDescriptor>;
  getRuntimeToken(agentId: string): number | undefined;
  now(): string;
  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void;
  dispatchRuntimeError(runtimeToken: number, error: RuntimeErrorEvent): Promise<void>;
  /**
   * Compatibility hook for legacy specialist fallback. A true return means recovery code outside
   * this projector already handled the runtime error, so projection should suppress chat output.
   */
  maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean>;
  incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined>;
  emitConversationMessage(event: ConversationMessageEvent): void;
  logDebug(message: string, details?: unknown): void;
}

export interface ProjectRuntimeErrorOptions {
  runtimeToken?: number;
  agentId: string;
  error: RuntimeErrorEvent;
}

export class RuntimeErrorProjector {
  constructor(private readonly deps: RuntimeErrorProjectorDeps) {}

  async projectError({ runtimeToken, agentId, error }: ProjectRuntimeErrorOptions): Promise<void> {
    const descriptor = this.deps.descriptors.get(agentId);
    if (!descriptor) {
      return;
    }

    const message = error.message.trim().length > 0 ? error.message.trim() : "Unknown runtime error";
    const normalizedError = { ...error, message };
    this.deps.maybeRecordModelCapacityBlock(agentId, descriptor, normalizedError);

    const forgeBindingRuntimeToken = runtimeToken ?? this.deps.getRuntimeToken(agentId);
    if (forgeBindingRuntimeToken !== undefined) {
      await this.deps.dispatchRuntimeError(forgeBindingRuntimeToken, normalizedError);
    }

    if (error.phase === "prompt_dispatch" || error.phase === "prompt_start") {
      const recoveredWithFallback = await this.deps.maybeRecoverWorkerWithSpecialistFallback(
        agentId,
        message,
        error.phase,
        runtimeToken
      );
      if (recoveredWithFallback) {
        return;
      }
    }

    const attempt = readPositiveIntegerDetail(error.details, "attempt");
    const maxAttempts = readPositiveIntegerDetail(error.details, "maxAttempts");
    const droppedPendingCount = readPositiveIntegerDetail(error.details, "droppedPendingCount");
    const recoveryStage = readStringDetail(error.details, "recoveryStage");

    this.deps.logDebug("runtime:error", {
      agentId,
      runtime:
        descriptor.model.provider.includes("cursor-acp")
          ? "cursor-acp"
          : descriptor.model.provider.includes("claude-sdk")
            ? "claude-sdk"
            : "pi",
      phase: error.phase,
      message,
      stack: error.stack,
      details: error.details
    });

    const retryLabel =
      attempt && maxAttempts && maxAttempts > 1 ? ` (attempt ${attempt}/${maxAttempts})` : "";

    const extensionPath = readStringDetail(error.details, "extensionPath");
    const extensionEvent = readStringDetail(error.details, "event");
    const extensionBaseName = extensionPath ? basename(extensionPath) : undefined;
    const userFacingMessage = readStringDetail(error.details, "userFacingMessage");

    const isSuccessfulCompactionStage = isCompactionSuccessRecoveryStage(recoveryStage);

    if (error.phase === "compaction" && isSuccessfulCompactionStage && descriptor.profileId) {
      const count = await this.deps.incrementSessionCompactionCount(
        descriptor.profileId,
        agentId,
        "runtime:compact:count-increment-failed"
      );
      if (count !== undefined) {
        await this.deps.patchDescriptorFromRuntimeStatus(agentId, { compactionCount: count });
      }
    }

    const text =
      userFacingMessage
      ?? (
        error.phase === "compaction"
          ? isSuccessfulCompactionStage
            ? `📋 ${message}.`
            : recoveryStage === "recovery_failed"
              ? `🚨 Context recovery failed: ${message}. Start a new session or manually trim history/compact before continuing.`
              : `⚠️ Compaction error${retryLabel}: ${message}. Attempting fallback recovery.`
          : error.phase === "context_guard"
            ? recoveryStage === "guard_started"
              ? `📋 ${message}.`
              : `⚠️ Context guard error${retryLabel}: ${message}.`
            : error.phase === "extension"
              ? extensionBaseName && extensionEvent
                ? `⚠️ Extension error (${extensionBaseName} · ${extensionEvent}): ${message}`
                : extensionBaseName
                  ? `⚠️ Extension error (${extensionBaseName}): ${message}`
                  : `⚠️ Extension error: ${message}`
              : droppedPendingCount && droppedPendingCount > 0
                ? `⚠️ Agent error${retryLabel}: ${message}. ${droppedPendingCount} queued message${droppedPendingCount === 1 ? "" : "s"} could not be delivered and were dropped. Please resend.`
                : `⚠️ Agent error${retryLabel}: ${message}. Message may need to be resent.`
      );

    this.deps.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.deps.now(),
      source: "system"
    });
  }
}

function isCompactionSuccessRecoveryStage(stage: string | undefined): boolean {
  return stage === "auto_compaction_succeeded" || stage === "context_guard_compaction_succeeded";
}
