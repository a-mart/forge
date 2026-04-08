import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { inferProviderFromModelId } from "./model-presets.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  SwarmReasoningLevel
} from "./types.js";
import type {
  RuntimeCreationOptions,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import {
  createDeferred,
  extractRuntimeMessageText,
  normalizeContextUsage,
  normalizeOptionalAgentId,
  normalizeThinkingLevelForProvider,
  previewForLog,
  shouldRetrySpecialistSpawnWithFallback
} from "./swarm-manager-utils.js";
import type { SwarmWorkerHealthService } from "./swarm-worker-health-service.js";

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
}

interface BufferedSpecialistFallbackStatus {
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
}

interface SpecialistFallbackHandoffState {
  suppressedRuntimeToken: number;
  startedAt: string;
  bufferedStatus?: BufferedSpecialistFallbackStatus;
  receivedAgentEnd?: boolean;
}

export interface SwarmSpecialistFallbackManagerOptions {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  runtimeTokensByAgentId: Map<string, number>;
  workerHealthService: SwarmWorkerHealthService;
  now: () => string;
  resolveSpecialistRosterForProfile(profileId: string): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpawnModelWithCapacityFallback(model: AgentModelDescriptor): AgentModelDescriptor;
  resolveSystemPromptForDescriptor(descriptor: AgentDescriptor): Promise<string>;
  injectWorkerIdentityContext(descriptor: AgentDescriptor, systemPrompt: string): string;
  createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken?: number,
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime>;
  attachRuntime(agentId: string, runtime: SwarmAgentRuntime): void;
  detachRuntime(agentId: string, runtimeToken?: number): boolean;
  updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void>;
  refreshSessionMetaStatsBySessionId(sessionAgentId: string): Promise<void>;
  saveStore(): Promise<void>;
  emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void;
  emitAgentsSnapshot(): void;
  clearTrackedToolPaths(agentId: string): void;
  logDebug(message: string, details?: unknown): void;
}

export class SwarmSpecialistFallbackManager {
  private readonly specialistFallbackHandoffsByAgentId = new Map<string, SpecialistFallbackHandoffState>();

  constructor(private readonly options: SwarmSpecialistFallbackManagerOptions) {}

  resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    return this.doResolveSpecialistFallbackModelForDescriptor(descriptor);
  }

  isSuppressedRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    return this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken) !== undefined;
  }

  bufferStatusDuringHandoff(
    agentId: string,
    runtimeToken: number,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.bufferedStatus = {
      status,
      pendingCount,
      contextUsage: normalizeContextUsage(contextUsage)
    };
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  bufferAgentEndDuringHandoff(agentId: string, runtimeToken: number): boolean {
    const handoff = this.getSuppressedSpecialistFallbackHandoff(agentId, runtimeToken);
    if (!handoff) {
      return false;
    }

    handoff.receivedAgentEnd = true;
    this.specialistFallbackHandoffsByAgentId.set(agentId, handoff);
    return true;
  }

  async reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    options: {
      handleRuntimeStatus(
        runtimeToken: number,
        targetAgentId: string,
        status: AgentStatus,
        pendingCount: number,
        contextUsage?: AgentContextUsage
      ): Promise<void>;
      handleRuntimeAgentEnd(runtimeToken: number, targetAgentId: string): Promise<void>;
    }
  ): Promise<void> {
    if (suppressedRuntimeToken === undefined) {
      return;
    }

    const handoffState = this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    this.endSpecialistFallbackHandoff(agentId, suppressedRuntimeToken);
    if (!handoffState) {
      return;
    }

    if (handoffState.bufferedStatus) {
      await options.handleRuntimeStatus(
        suppressedRuntimeToken,
        agentId,
        handoffState.bufferedStatus.status,
        handoffState.bufferedStatus.pendingCount,
        handoffState.bufferedStatus.contextUsage
      );
    }

    if (handoffState.receivedAgentEnd) {
      await options.handleRuntimeAgentEnd(suppressedRuntimeToken, agentId);
    }
  }

  async maybeRecoverWorkerWithSpecialistFallback(input: {
    agentId: string;
    errorMessage: string;
    sourcePhase: "prompt_dispatch" | "prompt_start";
    runtimeToken?: number;
    handleRuntimeStatus(
      runtimeToken: number,
      targetAgentId: string,
      status: AgentStatus,
      pendingCount: number,
      contextUsage?: AgentContextUsage
    ): Promise<void>;
    handleRuntimeAgentEnd(runtimeToken: number, targetAgentId: string): Promise<void>;
  }): Promise<boolean> {
    const descriptor = this.options.descriptors.get(input.agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    if (!shouldRetrySpecialistSpawnWithFallback(new Error(input.errorMessage), descriptor.model)) {
      return false;
    }

    const currentRuntime = this.options.runtimes.get(input.agentId);
    const suppressedRuntimeToken = input.runtimeToken ?? this.options.runtimeTokensByAgentId.get(input.agentId);
    if (!currentRuntime) {
      return false;
    }

    const previousModel = { ...descriptor.model };
    const previousStatus = descriptor.status;
    const previousUpdatedAt = descriptor.updatedAt;
    const previousStreamingStartedAt = descriptor.streamingStartedAt;
    const previousContextUsage = descriptor.contextUsage ? { ...descriptor.contextUsage } : undefined;
    const previousRuntimeSystemPrompt = currentRuntime.getSystemPrompt?.();

    let fallbackModel: AgentModelDescriptor | undefined;
    let replaySnapshot: SpecialistFallbackReplaySnapshot | undefined;
    let replacementRuntime: SwarmAgentRuntime | undefined;
    let replacementRuntimeToken: number | undefined;
    let runtimeSystemPrompt = "";
    let recovered = false;
    let handoffStarted = false;
    let deferredSettled = false;
    const fallbackRuntimeDeferred = createDeferred<SwarmAgentRuntime>();
    fallbackRuntimeDeferred.promise.catch(() => {});
    const resolveWaiters = (runtime: SwarmAgentRuntime): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.resolve(runtime);
    };
    const rejectWaiters = (reason: unknown): void => {
      if (deferredSettled) {
        return;
      }
      deferredSettled = true;
      fallbackRuntimeDeferred.reject(reason);
    };

    this.options.runtimeCreationPromisesByAgentId.set(input.agentId, fallbackRuntimeDeferred.promise);

    if (suppressedRuntimeToken !== undefined) {
      this.beginSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
      handoffStarted = true;
    }

    try {
      fallbackModel = await this.doResolveSpecialistFallbackModelForDescriptor(descriptor);
      if (!fallbackModel) {
        await this.reconcileBufferedCallbacksOnAbort(input.agentId, suppressedRuntimeToken, {
          handleRuntimeStatus: input.handleRuntimeStatus,
          handleRuntimeAgentEnd: input.handleRuntimeAgentEnd
        });
        resolveWaiters(currentRuntime);
        return false;
      }

      if (
        fallbackModel.provider === descriptor.model.provider &&
        fallbackModel.modelId === descriptor.model.modelId &&
        fallbackModel.thinkingLevel === descriptor.model.thinkingLevel
      ) {
        await this.reconcileBufferedCallbacksOnAbort(input.agentId, suppressedRuntimeToken, {
          handleRuntimeStatus: input.handleRuntimeStatus,
          handleRuntimeAgentEnd: input.handleRuntimeAgentEnd
        });
        resolveWaiters(currentRuntime);
        return false;
      }

      replaySnapshot = await currentRuntime.prepareForSpecialistFallbackReplay?.();
      if (!replaySnapshot) {
        await this.reconcileBufferedCallbacksOnAbort(input.agentId, suppressedRuntimeToken, {
          handleRuntimeStatus: input.handleRuntimeStatus,
          handleRuntimeAgentEnd: input.handleRuntimeAgentEnd
        });
        resolveWaiters(currentRuntime);
        return false;
      }

      const fallbackDescriptor: AgentDescriptor = {
        ...descriptor,
        model: { ...fallbackModel },
        status: "idle",
        updatedAt: this.options.now(),
        contextUsage: undefined
      };
      delete fallbackDescriptor.streamingStartedAt;

      const baseSystemPrompt = await this.options.resolveSystemPromptForDescriptor(fallbackDescriptor);
      runtimeSystemPrompt = this.options.injectWorkerIdentityContext(fallbackDescriptor, baseSystemPrompt);
      replacementRuntime = await this.options.createRuntimeForDescriptor(fallbackDescriptor, runtimeSystemPrompt);
      replacementRuntimeToken = this.options.runtimeTokensByAgentId.get(input.agentId);

      if (!this.isSpecialistFallbackHandoffStillValid(input.agentId, currentRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(input.agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback handoff was cancelled for ${input.agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      descriptor.model = { ...fallbackDescriptor.model };
      descriptor.status = fallbackDescriptor.status;
      descriptor.updatedAt = fallbackDescriptor.updatedAt;
      descriptor.contextUsage = undefined;
      delete descriptor.streamingStartedAt;
      this.options.descriptors.set(input.agentId, descriptor);
      await this.options.saveStore();

      this.options.attachRuntime(input.agentId, replacementRuntime);

      const persistedSystemPrompt = replacementRuntime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      await this.options.updateSessionMetaForWorkerDescriptor(descriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

      this.options.emitStatus(input.agentId, descriptor.status, replacementRuntime.getPendingCount(), replacementRuntime.getContextUsage());
      this.options.emitAgentsSnapshot();

      if (!this.isSpecialistFallbackHandoffStillValid(input.agentId, replacementRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(input.agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback replay was cancelled for ${input.agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }

      this.options.logDebug("worker:specialist_fallback:rerouted", {
        agentId: input.agentId,
        specialistId: descriptor.specialistId,
        sourcePhase: input.sourcePhase,
        previousModel,
        fallbackModel: descriptor.model,
        message: input.errorMessage,
        replayPreview: previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160),
        replayMessageCount: replaySnapshot.messages.length
      });

      await this.replaySpecialistFallbackSnapshot(replacementRuntime, replaySnapshot);
      resolveWaiters(replacementRuntime);
      if (suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
      }

      void currentRuntime.terminate({ abort: true }).catch((shutdownError) => {
        this.options.logDebug("worker:specialist_fallback:previous_runtime_shutdown_error", {
          agentId: input.agentId,
          specialistId: descriptor.specialistId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      });

      recovered = true;
      return true;
    } catch (fallbackError) {
      const failureDisposition = this.getSpecialistFallbackFailureDisposition(
        input.agentId,
        currentRuntime,
        replacementRuntime,
        suppressedRuntimeToken
      );
      await this.discardSpecialistFallbackReplacementRuntime(input.agentId, replacementRuntime, replacementRuntimeToken);
      let rollbackError: unknown;
      try {
        if (failureDisposition === "restore_original_runtime") {
          await currentRuntime.restorePreparedSpecialistFallbackReplay?.();
          await this.restoreWorkerAfterFailedSpecialistFallback(
            descriptor,
            currentRuntime,
            suppressedRuntimeToken,
            {
              previousModel,
              previousStatus,
              previousUpdatedAt,
              previousStreamingStartedAt,
              previousContextUsage,
              previousRuntimeSystemPrompt
            }
          );
          resolveWaiters(currentRuntime);
        } else {
          await this.terminateSuppressedSpecialistFallbackRuntime(input.agentId, currentRuntime);
          rejectWaiters(
            new Error(
              failureDisposition === "interrupted"
                ? `Specialist fallback replay was interrupted for ${input.agentId}`
                : `Specialist fallback replay failed and original runtime is unavailable for ${input.agentId}`
            )
          );
          if (suppressedRuntimeToken !== undefined) {
            this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
          }
          recovered = failureDisposition === "interrupted";
        }
      } catch (restoreError) {
        rollbackError = restoreError;
        rejectWaiters(restoreError);
      }

      this.options.logDebug("worker:specialist_fallback:failed", {
        agentId: input.agentId,
        specialistId: descriptor.specialistId,
        sourcePhase: input.sourcePhase,
        previousModel,
        fallbackModel,
        message: input.errorMessage,
        replayPreview: replaySnapshot
          ? previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160)
          : undefined,
        replayMessageCount: replaySnapshot?.messages.length ?? 0,
        failureDisposition,
        fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError ?? "")
      });
      return failureDisposition === "interrupted";
    } finally {
      if (handoffStarted && !recovered && suppressedRuntimeToken !== undefined) {
        this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
      }

      if (!deferredSettled) {
        rejectWaiters(new Error(`Specialist fallback handoff did not settle for ${input.agentId}`));
      }

      if (this.options.runtimeCreationPromisesByAgentId.get(input.agentId) === fallbackRuntimeDeferred.promise) {
        this.options.runtimeCreationPromisesByAgentId.delete(input.agentId);
      }
    }
  }

  private async doResolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    if (descriptor.role !== "worker" || !descriptor.specialistId || !descriptor.profileId) {
      return undefined;
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (!specialistId) {
      return undefined;
    }

    const roster = await this.options.resolveSpecialistRosterForProfile(descriptor.profileId);
    const specialist = roster.find((entry) => entry.specialistId === specialistId);
    if (!specialist?.fallbackModelId) {
      return undefined;
    }

    const inferredFallbackProvider = inferProviderFromModelId(specialist.fallbackModelId);
    if (!inferredFallbackProvider) {
      return undefined;
    }

    let fallbackModel: AgentModelDescriptor = {
      provider: inferredFallbackProvider,
      modelId: specialist.fallbackModelId,
      thinkingLevel: specialist.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
    };
    fallbackModel.thinkingLevel = normalizeThinkingLevelForProvider(
      fallbackModel.provider,
      fallbackModel.thinkingLevel
    );
    return this.options.resolveSpawnModelWithCapacityFallback(fallbackModel);
  }

  private getSuppressedSpecialistFallbackHandoff(
    agentId: string,
    runtimeToken?: number
  ): SpecialistFallbackHandoffState | undefined {
    if (runtimeToken === undefined) {
      return undefined;
    }

    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (handoff?.suppressedRuntimeToken === runtimeToken) {
      return handoff;
    }

    return undefined;
  }

  private beginSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken: number): void {
    this.specialistFallbackHandoffsByAgentId.set(agentId, {
      suppressedRuntimeToken,
      startedAt: this.options.now()
    });
  }

  private endSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    const handoff = this.specialistFallbackHandoffsByAgentId.get(agentId);
    if (!handoff) {
      return;
    }

    if (suppressedRuntimeToken !== undefined && handoff.suppressedRuntimeToken !== suppressedRuntimeToken) {
      return;
    }

    this.specialistFallbackHandoffsByAgentId.delete(agentId);
  }

  private async replaySpecialistFallbackSnapshot(
    runtime: SwarmAgentRuntime,
    replaySnapshot: SpecialistFallbackReplaySnapshot
  ): Promise<void> {
    for (const [index, replayMessage] of replaySnapshot.messages.entries()) {
      await runtime.sendMessage(replayMessage, index === 0 ? "auto" : "steer");
    }
  }

  private isSpecialistFallbackHandoffStillValid(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime
  ): boolean {
    const latestDescriptor = this.options.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return false;
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return false;
    }

    return this.options.runtimes.get(agentId) === expectedRuntime;
  }

  private async discardSpecialistFallbackReplacementRuntime(
    agentId: string,
    replacementRuntime: SwarmAgentRuntime | undefined,
    replacementRuntimeToken: number | undefined
  ): Promise<void> {
    if (replacementRuntime) {
      try {
        await replacementRuntime.terminate({
          abort: true,
          shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
          drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
        });
      } catch (shutdownError) {
        this.options.logDebug("worker:specialist_fallback:replacement_runtime_shutdown_error", {
          agentId,
          message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        });
      }
    }

    if (replacementRuntimeToken !== undefined) {
      this.options.detachRuntime(agentId, replacementRuntimeToken);
    } else if (replacementRuntime && this.options.runtimes.get(agentId) === replacementRuntime) {
      this.options.runtimes.delete(agentId);
    }
  }

  private async terminateSuppressedSpecialistFallbackRuntime(
    agentId: string,
    runtime: SwarmAgentRuntime
  ): Promise<void> {
    try {
      await runtime.terminate({
        abort: true,
        shutdownTimeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
        drainTimeoutMs: RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
      });
    } catch (shutdownError) {
      this.options.logDebug("worker:specialist_fallback:suppressed_runtime_shutdown_error", {
        agentId,
        message: shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      });
    }
  }

  private getSpecialistFallbackFailureDisposition(
    agentId: string,
    currentRuntime: SwarmAgentRuntime,
    replacementRuntime: SwarmAgentRuntime | undefined,
    suppressedRuntimeToken: number | undefined
  ): "restore_original_runtime" | "interrupted" | "original_runtime_unavailable" {
    const latestDescriptor = this.options.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return "interrupted";
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return "interrupted";
    }

    if (replacementRuntime && this.options.runtimes.get(agentId) !== replacementRuntime) {
      return "interrupted";
    }

    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(agentId, suppressedRuntimeToken)
        : undefined;
    const originalRuntimeStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    if (isNonRunningAgentStatus(originalRuntimeStatus)) {
      return "original_runtime_unavailable";
    }

    return "restore_original_runtime";
  }

  private async restoreWorkerAfterFailedSpecialistFallback(
    descriptor: AgentDescriptor,
    currentRuntime: SwarmAgentRuntime,
    suppressedRuntimeToken: number | undefined,
    previousState: {
      previousModel: AgentModelDescriptor;
      previousStatus: AgentStatus;
      previousUpdatedAt: string;
      previousStreamingStartedAt?: number;
      previousContextUsage?: AgentContextUsage;
      previousRuntimeSystemPrompt?: string | null;
    }
  ): Promise<void> {
    const handoffState =
      suppressedRuntimeToken !== undefined
        ? this.getSuppressedSpecialistFallbackHandoff(descriptor.agentId, suppressedRuntimeToken)
        : undefined;
    const reconciledStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    const reconciledContextUsage =
      handoffState?.bufferedStatus?.contextUsage ?? currentRuntime.getContextUsage() ?? previousState.previousContextUsage;

    descriptor.model = previousState.previousModel;
    descriptor.status = reconciledStatus;
    descriptor.updatedAt = previousState.previousUpdatedAt;
    descriptor.contextUsage = isNonRunningAgentStatus(reconciledStatus) ? undefined : reconciledContextUsage;
    if (reconciledStatus === "streaming" && previousState.previousStreamingStartedAt !== undefined) {
      descriptor.streamingStartedAt = previousState.previousStreamingStartedAt;
    } else {
      delete descriptor.streamingStartedAt;
    }
    this.options.descriptors.set(descriptor.agentId, descriptor);
    this.options.attachRuntime(descriptor.agentId, currentRuntime);
    if (suppressedRuntimeToken !== undefined) {
      this.options.runtimeTokensByAgentId.set(descriptor.agentId, suppressedRuntimeToken);
    }

    if (handoffState?.receivedAgentEnd) {
      this.options.clearTrackedToolPaths(descriptor.agentId);
    }
    this.options.workerHealthService.reconcileRuntimeStateAfterFallbackRollback(descriptor.agentId, reconciledStatus, {
      receivedAgentEnd: handoffState?.receivedAgentEnd === true
    });

    try {
      await this.options.saveStore();
    } catch (saveError) {
      this.options.logDebug("worker:specialist_fallback:rollback_save_failed", {
        agentId: descriptor.agentId,
        specialistId: descriptor.specialistId,
        message: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }

    await this.options.updateSessionMetaForWorkerDescriptor(
      descriptor,
      previousState.previousRuntimeSystemPrompt ?? undefined
    );
    await this.options.refreshSessionMetaStatsBySessionId(descriptor.managerId);

    this.options.emitStatus(
      descriptor.agentId,
      descriptor.status,
      handoffState?.bufferedStatus?.pendingCount ?? currentRuntime.getPendingCount(),
      descriptor.contextUsage
    );
    this.options.emitAgentsSnapshot();
  }
}
