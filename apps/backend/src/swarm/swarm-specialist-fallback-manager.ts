import type { SpecialistTargetSpace } from "@forge/protocol";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { inferProviderFromModelId, normalizeThinkingLevelForModelDescriptor } from "./model-presets.js";
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
  normalizeOptionalAgentId,
  previewForLog,
  shouldRetrySpecialistSpawnWithFallback,
  isCollabSession
} from "./swarm-manager-utils.js";
import type { SwarmWorkerHealthService } from "./swarm-worker-health-service.js";
import { normalizeEffortTier, resolveTierConfig } from "./specialists/specialist-registry.js";

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;

interface ResolvedSpecialistDefinitionLike {
  specialistId: string;
  fallbackModelId?: string;
  fallbackReasoningLevel?: SwarmReasoningLevel;
}

interface SpecialistFallbackHandoffSnapshot {
  suppressedRuntimeToken: number;
  bufferedStatus?: {
    status: AgentStatus;
    pendingCount: number;
    contextUsage?: AgentContextUsage;
  };
  receivedAgentEnd?: boolean;
}

export interface SpecialistFallbackHandoffController {
  beginFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void;
  endFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void;
  getFallbackHandoffSnapshot(
    agentId: string,
    suppressedRuntimeToken?: number
  ): SpecialistFallbackHandoffSnapshot | undefined;
  reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    handlers: {
      handleRuntimeStatus(
        runtimeToken: number,
        targetAgentId: string,
        status: AgentStatus,
        pendingCount: number,
        contextUsage?: AgentContextUsage
      ): Promise<void>;
      handleRuntimeAgentEnd(runtimeToken: number, targetAgentId: string): Promise<void>;
    }
  ): Promise<void>;
}

export interface SwarmSpecialistFallbackManagerOptions {
  dataDir?: string;
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  runtimeCreationPromisesByAgentId?: Map<string, Promise<SwarmAgentRuntime>>;
  runtimeTokensByAgentId?: Map<string, number>;
  getRuntime(agentId: string): SwarmAgentRuntime | undefined;
  isRuntime(agentId: string, runtime: SwarmAgentRuntime): boolean;
  getRuntimeToken(agentId: string): number | undefined;
  clearRuntimeToken(agentId: string, runtimeToken?: number): void;
  restoreRuntimeTokenForFallbackRollback(agentId: string, runtimeToken: number): void;
  hasSecureRuntimeBinding(runtime: SwarmAgentRuntime): boolean;
  isSecureRuntimeBindingValid(runtime: SwarmAgentRuntime): boolean;
  isSecureRuntimeBindingUsable(agentId: string, runtime: SwarmAgentRuntime): boolean;
  getRuntimeCreationPromise(agentId: string): Promise<SwarmAgentRuntime> | undefined;
  setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void;
  clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean;
  workerHealthService: SwarmWorkerHealthService;
  now: () => string;
  resolveSpecialistRosterForProfile(
    profileId: string,
    targetSpace?: SpecialistTargetSpace
  ): Promise<ResolvedSpecialistDefinitionLike[]>;
  resolveSpecialistRosterForManager?(
    manager: AgentDescriptor,
    targetSpace?: SpecialistTargetSpace
  ): Promise<ResolvedSpecialistDefinitionLike[]>;
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
  detachRuntimeIfMatches(agentId: string, expectedRuntime: SwarmAgentRuntime, runtimeToken?: number): boolean;
  updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void>;
  refreshSessionMetaStatsBySessionId(sessionAgentId: string): Promise<void>;
  saveStore(): Promise<void>;
  patchDescriptor?(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
    options?: { saveMode?: "rollback" | "best-effort"; onSaveError?: (error: unknown) => void }
  ): Promise<AgentDescriptor | undefined>;
  patchDescriptorInLiveMaps?(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor
  ): AgentDescriptor | undefined;
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
  private fallbackHandoffController: SpecialistFallbackHandoffController | null = null;

  constructor(private readonly options: SwarmSpecialistFallbackManagerOptions) {}

  setFallbackHandoffController(controller: SpecialistFallbackHandoffController): void {
    this.fallbackHandoffController = controller;
  }

  resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    return this.doResolveSpecialistFallbackModelForDescriptor(descriptor);
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

    const currentRuntime = this.getRuntime(input.agentId);
    const suppressedRuntimeToken = input.runtimeToken ?? this.getRuntimeToken(input.agentId);
    if (!currentRuntime) {
      return false;
    }
    const secureRuntimeRequired = this.options.hasSecureRuntimeBinding(currentRuntime);

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
    let fallbackRerouteUpdatedAt: string | undefined;
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

    this.setRuntimeCreationPromise(input.agentId, fallbackRuntimeDeferred.promise);

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

      fallbackRerouteUpdatedAt = this.options.now();
      const fallbackDescriptor: AgentDescriptor = {
        ...descriptor,
        model: { ...fallbackModel },
        status: "idle",
        updatedAt: fallbackRerouteUpdatedAt,
        contextUsage: undefined
      };
      delete fallbackDescriptor.streamingStartedAt;

      const baseSystemPrompt = await this.options.resolveSystemPromptForDescriptor(fallbackDescriptor);
      runtimeSystemPrompt = this.options.injectWorkerIdentityContext(fallbackDescriptor, baseSystemPrompt);
      replacementRuntime = secureRuntimeRequired
        ? await this.options.createRuntimeForDescriptor(
            fallbackDescriptor,
            runtimeSystemPrompt,
            undefined,
            { secureRuntimeRequired: true },
          )
        : await this.options.createRuntimeForDescriptor(fallbackDescriptor, runtimeSystemPrompt);
      replacementRuntimeToken = this.getRuntimeToken(input.agentId);

      if (!this.isSpecialistFallbackHandoffStillValid(input.agentId, currentRuntime)) {
        await this.discardSpecialistFallbackReplacementRuntime(input.agentId, replacementRuntime, replacementRuntimeToken);
        rejectWaiters(new Error(`Specialist fallback handoff was cancelled for ${input.agentId}`));
        if (suppressedRuntimeToken !== undefined) {
          this.endSpecialistFallbackHandoff(input.agentId, suppressedRuntimeToken);
        }
        recovered = true;
        return true;
      }
      if (
        secureRuntimeRequired
        && (
          !this.options.isSecureRuntimeBindingUsable(input.agentId, currentRuntime)
          || !this.options.isSecureRuntimeBindingValid(replacementRuntime)
        )
      ) {
        throw new Error(`Secure specialist fallback handoff was revoked for ${input.agentId}`);
      }

      const reroutedDescriptor = await this.persistSpecialistFallbackReroute(
        input.agentId,
        fallbackDescriptor
      );
      if (!reroutedDescriptor) {
        throw new Error(`Specialist fallback descriptor disappeared for ${input.agentId}`);
      }

      this.options.attachRuntime(input.agentId, replacementRuntime);

      const persistedSystemPrompt = replacementRuntime.getSystemPrompt?.() ?? runtimeSystemPrompt;
      await this.options.updateSessionMetaForWorkerDescriptor(reroutedDescriptor, persistedSystemPrompt);
      await this.options.refreshSessionMetaStatsBySessionId(reroutedDescriptor.managerId);

      this.options.emitStatus(
        input.agentId,
        reroutedDescriptor.status,
        replacementRuntime.getPendingCount(),
        replacementRuntime.getContextUsage()
      );
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
      if (
        secureRuntimeRequired
        && !this.options.isSecureRuntimeBindingUsable(input.agentId, replacementRuntime)
      ) {
        throw new Error(`Secure specialist fallback replay was revoked for ${input.agentId}`);
      }

      this.options.logDebug("worker:specialist_fallback:rerouted", {
        agentId: input.agentId,
        specialistId: descriptor.specialistId,
        sourcePhase: input.sourcePhase,
        previousModel,
        fallbackModel: reroutedDescriptor.model,
        message: input.errorMessage,
        replayPreview: previewForLog(extractRuntimeMessageText(replaySnapshot.messages[0]), 160),
        replayMessageCount: replaySnapshot.messages.length
      });

      await this.replaySpecialistFallbackSnapshot(
        input.agentId,
        replacementRuntime,
        replaySnapshot,
        secureRuntimeRequired,
      );
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
        suppressedRuntimeToken,
        secureRuntimeRequired,
      );
      await this.discardSpecialistFallbackReplacementRuntime(input.agentId, replacementRuntime, replacementRuntimeToken);
      let rollbackError: unknown;
      try {
        if (failureDisposition === "restore_original_runtime") {
          await currentRuntime.restorePreparedSpecialistFallbackReplay?.();
          await this.restoreWorkerAfterFailedSpecialistFallback(
            input.agentId,
            currentRuntime,
            suppressedRuntimeToken,
            {
              previousModel,
              previousStatus,
              previousUpdatedAt,
              previousStreamingStartedAt,
              previousContextUsage,
              previousRuntimeSystemPrompt,
              fallbackRerouteUpdatedAt
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

      this.clearRuntimeCreationPromiseIfCurrent(input.agentId, fallbackRuntimeDeferred.promise);
    }
  }

  private getRuntime(agentId: string): SwarmAgentRuntime | undefined {
    return this.options.getRuntime(agentId);
  }

  private isRuntime(agentId: string, runtime: SwarmAgentRuntime): boolean {
    return this.options.isRuntime(agentId, runtime);
  }

  private getRuntimeToken(agentId: string): number | undefined {
    return this.options.getRuntimeToken(agentId);
  }

  private clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    this.options.clearRuntimeToken(agentId, runtimeToken);
  }

  private restoreRuntimeTokenForFallbackRollback(agentId: string, runtimeToken: number): void {
    this.options.restoreRuntimeTokenForFallbackRollback(agentId, runtimeToken);
  }

  private setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void {
    this.options.setRuntimeCreationPromise(agentId, promise);
  }

  private clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean {
    return this.options.clearRuntimeCreationPromiseIfCurrent(agentId, promise);
  }

  private detachRuntimeIfMatches(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime,
    runtimeToken?: number
  ): boolean {
    return this.options.detachRuntimeIfMatches(agentId, expectedRuntime, runtimeToken);
  }

  private async doResolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    if (descriptor.role === "worker" && descriptor.delegationFallbackModel) {
      return this.options.resolveSpawnModelWithCapacityFallback({
        ...descriptor.delegationFallbackModel,
      });
    }

    if (descriptor.role !== "worker" || !descriptor.specialistId || !descriptor.profileId) {
      return undefined;
    }

    const specialistId = normalizeOptionalAgentId(descriptor.specialistId)?.toLowerCase();
    if (!specialistId) {
      return undefined;
    }

    const tier = descriptor.specialistTier ?? normalizeEffortTier(specialistId.split(":")[0]);
    if (tier && this.options.dataDir) {
      const tierConfig = await resolveTierConfig(this.options.dataDir, tier);
      if (!tierConfig.fallbackModelId) {
        return undefined;
      }
      const inferredFallbackProvider =
        tierConfig.fallbackProvider ?? inferProviderFromModelId(tierConfig.fallbackModelId);
      if (!inferredFallbackProvider) {
        return undefined;
      }
      const fallbackModel: AgentModelDescriptor = {
        provider: inferredFallbackProvider,
        modelId: tierConfig.fallbackModelId,
        thinkingLevel: tierConfig.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
      };
      fallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(fallbackModel);
      return this.options.resolveSpawnModelWithCapacityFallback(fallbackModel);
    }

    const managerDescriptor = this.options.descriptors.get(descriptor.managerId);
    const roster = managerDescriptor && this.options.resolveSpecialistRosterForManager
      ? await this.options.resolveSpecialistRosterForManager(
          managerDescriptor,
          managerDescriptor && isCollabSession(managerDescriptor) ? "collaboration" : "builder"
        )
      : await this.options.resolveSpecialistRosterForProfile(
          descriptor.profileId,
          managerDescriptor && isCollabSession(managerDescriptor) ? "collaboration" : "builder"
        );
    const specialist = roster.find((entry) => entry.specialistId === specialistId);
    if (!specialist?.fallbackModelId) {
      return undefined;
    }

    const inferredFallbackProvider = inferProviderFromModelId(specialist.fallbackModelId);
    if (!inferredFallbackProvider) {
      return undefined;
    }

    const fallbackModel: AgentModelDescriptor = {
      provider: inferredFallbackProvider,
      modelId: specialist.fallbackModelId,
      thinkingLevel: specialist.fallbackReasoningLevel ?? descriptor.model.thinkingLevel
    };
    fallbackModel.thinkingLevel = normalizeThinkingLevelForModelDescriptor(fallbackModel);
    return this.options.resolveSpawnModelWithCapacityFallback(fallbackModel);
  }

  private getSpecialistFallbackHandoffSnapshot(
    agentId: string,
    runtimeToken?: number
  ): SpecialistFallbackHandoffSnapshot | undefined {
    return this.fallbackHandoffController?.getFallbackHandoffSnapshot(agentId, runtimeToken);
  }

  private beginSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken: number): void {
    this.fallbackHandoffController?.beginFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  private endSpecialistFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    this.fallbackHandoffController?.endFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  private async reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    handlers: Parameters<SpecialistFallbackHandoffController["reconcileBufferedCallbacksOnAbort"]>[2]
  ): Promise<void> {
    await this.fallbackHandoffController?.reconcileBufferedCallbacksOnAbort(
      agentId,
      suppressedRuntimeToken,
      handlers
    );
  }

  private async replaySpecialistFallbackSnapshot(
    agentId: string,
    runtime: SwarmAgentRuntime,
    replaySnapshot: SpecialistFallbackReplaySnapshot,
    secureRuntimeRequired: boolean,
  ): Promise<void> {
    for (const [index, replayMessage] of replaySnapshot.messages.entries()) {
      if (
        secureRuntimeRequired
        && !this.options.isSecureRuntimeBindingUsable(agentId, runtime)
      ) {
        throw new Error(`Secure specialist fallback replay was revoked for ${agentId}`);
      }
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

    return this.isRuntime(agentId, expectedRuntime);
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

    if (replacementRuntime) {
      const detached = this.detachRuntimeIfMatches(agentId, replacementRuntime, replacementRuntimeToken);
      if (!detached && replacementRuntimeToken !== undefined && this.getRuntimeToken(agentId) === replacementRuntimeToken) {
        this.clearRuntimeToken(agentId, replacementRuntimeToken);
      }
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
    suppressedRuntimeToken: number | undefined,
    secureRuntimeRequired: boolean,
  ): "restore_original_runtime" | "interrupted" | "original_runtime_unavailable" {
    const latestDescriptor = this.options.descriptors.get(agentId);
    if (!latestDescriptor || latestDescriptor.role !== "worker") {
      return "interrupted";
    }

    if (isNonRunningAgentStatus(latestDescriptor.status)) {
      return "interrupted";
    }

    if (replacementRuntime && !this.isRuntime(agentId, replacementRuntime) && !this.isRuntime(agentId, currentRuntime)) {
      return "interrupted";
    }

    if (
      secureRuntimeRequired
      && !this.options.isSecureRuntimeBindingValid(currentRuntime)
      && (
        !replacementRuntime
        || !this.options.isSecureRuntimeBindingValid(replacementRuntime)
      )
    ) {
      return "interrupted";
    }

    const handoffState = this.getSpecialistFallbackHandoffSnapshot(agentId, suppressedRuntimeToken);
    const originalRuntimeStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    if (isNonRunningAgentStatus(originalRuntimeStatus)) {
      return "original_runtime_unavailable";
    }

    return "restore_original_runtime";
  }

  private async persistSpecialistFallbackReroute(
    agentId: string,
    fallbackDescriptor: AgentDescriptor
  ): Promise<AgentDescriptor | undefined> {
    const patch = (current: AgentDescriptor): AgentDescriptor => {
      const next: AgentDescriptor = {
        ...current,
        model: { ...fallbackDescriptor.model },
        status: fallbackDescriptor.status,
        updatedAt: fallbackDescriptor.updatedAt,
        contextUsage: undefined
      };
      delete next.streamingStartedAt;
      return next;
    };

    if (this.options.patchDescriptor) {
      return this.options.patchDescriptor(agentId, patch);
    }

    const current = this.options.descriptors.get(agentId);
    if (!current) {
      return undefined;
    }

    const updated = patch(current);
    this.options.descriptors.set(agentId, updated);
    await this.options.saveStore();
    return updated;
  }

  private patchWorkerDescriptorInLiveMaps(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor
  ): AgentDescriptor | undefined {
    if (this.options.patchDescriptorInLiveMaps) {
      return this.options.patchDescriptorInLiveMaps(agentId, patch);
    }

    const current = this.options.descriptors.get(agentId);
    if (!current) {
      return undefined;
    }

    const updated = patch(current);
    this.options.descriptors.set(agentId, updated);
    return updated;
  }

  private async saveWorkerDescriptorBestEffort(
    agentId: string,
    specialistId: string | undefined
  ): Promise<void> {
    try {
      await this.options.saveStore();
    } catch (saveError) {
      this.options.logDebug("worker:specialist_fallback:rollback_save_failed", {
        agentId,
        specialistId,
        message: saveError instanceof Error ? saveError.message : String(saveError)
      });
    }
  }

  private async restoreWorkerAfterFailedSpecialistFallback(
    agentId: string,
    currentRuntime: SwarmAgentRuntime,
    suppressedRuntimeToken: number | undefined,
    previousState: {
      previousModel: AgentModelDescriptor;
      previousStatus: AgentStatus;
      previousUpdatedAt: string;
      previousStreamingStartedAt?: number;
      previousContextUsage?: AgentContextUsage;
      previousRuntimeSystemPrompt?: string | null;
      fallbackRerouteUpdatedAt?: string;
    }
  ): Promise<void> {
    const handoffState = this.getSpecialistFallbackHandoffSnapshot(agentId, suppressedRuntimeToken);
    const reconciledStatus = handoffState?.bufferedStatus?.status ?? currentRuntime.getStatus();
    const reconciledContextUsage =
      handoffState?.bufferedStatus?.contextUsage ?? currentRuntime.getContextUsage() ?? previousState.previousContextUsage;

    const restoredDescriptor = this.patchWorkerDescriptorInLiveMaps(agentId, (current) => {
      const next: AgentDescriptor = {
        ...current,
        model: previousState.previousModel,
        status: reconciledStatus,
        updatedAt: current.updatedAt === previousState.fallbackRerouteUpdatedAt
          ? previousState.previousUpdatedAt
          : current.updatedAt,
        contextUsage: isNonRunningAgentStatus(reconciledStatus) ? undefined : reconciledContextUsage
      };
      if (reconciledStatus === "streaming" && previousState.previousStreamingStartedAt !== undefined) {
        next.streamingStartedAt = previousState.previousStreamingStartedAt;
      } else {
        delete next.streamingStartedAt;
      }
      return next;
    });
    if (!restoredDescriptor) {
      throw new Error(`Specialist fallback rollback descriptor disappeared for ${agentId}`);
    }

    this.options.attachRuntime(agentId, currentRuntime);
    if (suppressedRuntimeToken !== undefined) {
      this.restoreRuntimeTokenForFallbackRollback(agentId, suppressedRuntimeToken);
    }

    if (handoffState?.receivedAgentEnd) {
      this.options.clearTrackedToolPaths(agentId);
    }
    this.options.workerHealthService.reconcileRuntimeStateAfterFallbackRollback(agentId, reconciledStatus, {
      receivedAgentEnd: handoffState?.receivedAgentEnd === true
    });

    await this.saveWorkerDescriptorBestEffort(agentId, restoredDescriptor.specialistId);

    await this.options.updateSessionMetaForWorkerDescriptor(
      restoredDescriptor,
      previousState.previousRuntimeSystemPrompt ?? undefined
    );
    await this.options.refreshSessionMetaStatsBySessionId(restoredDescriptor.managerId);

    this.options.emitStatus(
      agentId,
      restoredDescriptor.status,
      handoffState?.bufferedStatus?.pendingCount ?? currentRuntime.getPendingCount(),
      restoredDescriptor.contextUsage
    );
    this.options.emitAgentsSnapshot();
  }
}
