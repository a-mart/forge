import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import type { ForgeExtensionHost } from "./forge-extension-host.js";
import { createForgeBindingToken } from "./forge-extension-types.js";
import type { ProjectExecutableTrustPlan } from "./project-executable-trust.js";
import type { CredentialPoolService } from "./credential-pool.js";
import type { OpenAIAuthBrokerRuntimeService } from "./openai-auth/openai-auth-broker-runtime-service.js";
import type { SkillMetadata } from "./skills/skill-metadata-service.js";
import type {
  RuntimeCreationOptions,
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  SwarmAgentRuntime
} from "./runtime-contracts.js";
import {
  RuntimeCallbackGate,
  type RuntimeCallbackFallbackHandoffReplayHandlers,
  type RuntimeCallbackFallbackHandoffSnapshot
} from "./runtime/runtime-callback-gate.js";
import { RuntimeBinding } from "./runtime/runtime-binding.js";
import type { CompactionRuntimeSettingsProvider } from "./compaction-runtime-settings-provider.js";
import { RuntimeFactory } from "./runtime/runtime-factory.js";
import { RuntimeStatusProjector } from "./runtime/runtime-status-projector.js";
import { RuntimeErrorProjector } from "./runtime/runtime-error-projector.js";
import { RuntimeEventProjector, type ManagerAssistantOutputRouteResult } from "./runtime/runtime-event-projector.js";
import type {
  AssistantOutputTarget,
  SessionTranscriptAssistantOutputTarget,
} from "./runtime/manager-assistant-output-tracker.js";
import type { RuntimeRecoveryState } from "./runtime/runtime-recovery-state.js";
import type {
  WorkerActivityStateLike,
  WorkerStallStateLike
} from "./runtime/worker-health-types.js";
import type { SwarmToolHost } from "./swarm-tool-host.js";
import type { ModelCacheObservationEvent } from "@forge/protocol";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentModelDescriptor,
  AgentStatus,
  ConversationMessageEvent,
  SwarmConfig
} from "./types.js";
import { withManagerTimeout } from "./swarm-manager-utils.js";
import type { VersioningMutation } from "../versioning/versioning-types.js";
import type { SwarmSpecialistFallbackManager } from "./swarm-specialist-fallback-manager.js";
import type { ObservabilityFacade } from "../observability/observability-types.js";
import type { MessageRoutingReceiptRecord } from "./session/message-routing-receipts.js";
import type {
  GetSecureRuntimeBinding,
  SecureRuntimeBinding,
} from "./secure-sessions/runtime/secure-runtime-binding.js";
import {
  guardSecureRuntimeValue,
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  SECURE_RUNTIME_GUARD_FAILURE_MESSAGE,
} from "./secure-sessions/runtime/secure-runtime-binding.js";

const RUNTIME_SHUTDOWN_TIMEOUT_MS = 1_500;
const RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 500;
const RUNTIME_SHUTDOWN_QUARANTINE_MESSAGE =
  "This session runtime did not stop cleanly. Restart Forge before sending another message to protect the session history.";
const RUNTIME_SHUTDOWN_IN_PROGRESS_MESSAGE =
  "This session runtime is stopping. Wait for it to finish before sending another message.";

interface RuntimeShutdownQuarantine {
  runtime?: SwarmAgentRuntime;
  runtimeToken?: number;
  phase: "stopping" | "unclean";
}

export interface SwarmRuntimeControllerHost extends SwarmToolHost {
  config: SwarmConfig;
  forgeExtensionHost: ForgeExtensionHost;
  now: () => string;
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  runtimeRecoveryState: Pick<
    RuntimeRecoveryState,
    "markRecoveryAbortedWorkerTurn"
  >;
  conversationProjector: {
    captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent, options?: { turnId?: string }): void;
    emitConversationMessage(event: ConversationMessageEvent, options?: { routingReceipt?: MessageRoutingReceiptRecord }): void;
  };
  promptService: {
    buildCursorSdkRuntimeSystemPrompt(descriptor: AgentDescriptor, systemPrompt: string): Promise<string>;
  };
  secretsEnvService: {
    getCredentialPoolService(): CredentialPoolService;
    getOpenAIAuthBrokerRuntimeService(): OpenAIAuthBrokerRuntimeService;
  };
  getObservabilityService?(): ObservabilityFacade | undefined;
  cortexService: {
    handleManagerStatusTransition(
      descriptor: AgentDescriptor,
      status: AgentStatus,
      pendingCount: number
    ): void | Promise<void>;
  };
  getPiModelsJsonPathOrThrow(): string;
  getSecureRuntimeBinding?: GetSecureRuntimeBinding;
  getCompactionRuntimeSettingsProvider(): CompactionRuntimeSettingsProvider;
  getMemoryRuntimeResources(descriptor: AgentDescriptor): Promise<{
    memoryContextFile: { path: string; content: string };
    additionalSkillPaths: string[];
    skillMetadata: SkillMetadata[];
  }>;
  getSwarmContextFiles(cwd: string): Promise<Array<{ path: string; content: string }>>;
  resolveProjectExecutableTrustPlanForRuntime(options: {
    descriptor: AgentDescriptor;
    sessionDescriptor?: AgentDescriptor;
  }): Promise<ProjectExecutableTrustPlan>;
  maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean>;
  updateSessionMetaForWorkerDescriptor(
    descriptor: AgentDescriptor,
    resolvedSystemPrompt?: string | null
  ): Promise<void>;
  refreshSessionMetaStatsBySessionId(sessionAgentId: string, sessionFileOverride?: string): Promise<void>;
  refreshSessionMetaStats(descriptor: AgentDescriptor, sessionFileOverride?: string): Promise<void>;
  maybeRecordModelCapacityBlock(agentId: string, descriptor: AgentDescriptor, error: RuntimeErrorEvent): void;
  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean;
  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent;
  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean;
  cancelPendingTransientWorkerTerminatedError(agentId: string, reason: "runtime_progress" | "clear_state"): void;
  hasPendingTransientWorkerTerminatedError(agentId: string): boolean;
  handleWorkerStatus(
    agentId: string,
    descriptor: AgentDescriptor & { role: "worker" },
    status: AgentStatus,
    pendingCount: number
  ): Promise<void>;
  handleWorkerAgentEnd(
    agentId: string,
    descriptor: AgentDescriptor
  ): Promise<void>;
  isRuntimeRecoveryActive(agentId: string): boolean;
  beforeRuntimeEventProjection?(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void;
  getActiveTurnId?(agentId: string, runtimeToken?: number): string | undefined;
  handoffExternalChromeAtTurnEnd?(profileId: string, sessionAgentId: string, turnId: string): Promise<void>;
  recordManagerTurnWatchdogStatus?(
    agentId: string,
    runtimeToken: number | undefined,
    status: AgentStatus,
    pendingCount: number
  ): void;
  recordManagerTurnWatchdogEvent?(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent
  ): void;
  recordManagerTurnWatchdogRuntimeError?(
    agentId: string,
    runtimeToken: number | undefined,
    error: RuntimeErrorEvent
  ): void;
  recordManagerTurnWatchdogTerminal?(agentId: string, outcome: "agent_end" | "idle" | "error"): void;
  afterRuntimeEventProjection?(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void;
  onAcceptedRuntimeSessionEvent?(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void;
  incrementSessionCompactionCount(
    profileId: string,
    sessionId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  incrementWorkerCompactionCount(
    agentId: string,
    failureLogKey: string
  ): Promise<number | undefined>;
  patchDescriptorFromRuntimeStatus(
    agentId: string,
    patch: Partial<AgentDescriptor>
  ): Promise<AgentDescriptor | undefined>;
  emitConversationMessage(event: ConversationMessageEvent, options?: { routingReceipt?: MessageRoutingReceiptRecord }): void;
  markSessionActivity(agentId: string, timestamp?: string): void;
  emitStatus(
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): void;
  saveStore(): Promise<void>;
  queueVersionedToolMutation(descriptor: AgentDescriptor, mutation: VersioningMutation): Promise<void>;
  logDebug(message: string, details?: unknown): void;
  isModelCacheVisualizationEnabled(): boolean;
  emitModelCacheObservation(event: ModelCacheObservationEvent): void;
  resolveManagerAssistantFinalOutputTarget(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined
  ): SessionTranscriptAssistantOutputTarget | undefined;
  resolveManagerAssistantFinalOutputRoute?(
    agentId: string,
    activeTarget: AssistantOutputTarget | undefined
  ): ManagerAssistantOutputRouteResult;
  hasPendingSupersedingUserInput?(agentId: string, activeTurnId?: string): boolean;
}

export class SwarmRuntimeController {
  readonly runtimes: Map<string, SwarmAgentRuntime>;
  readonly runtimeCreationPromisesByAgentId: Map<string, Promise<SwarmAgentRuntime>>;
  readonly runtimeTokensByAgentId: Map<string, number>;
  readonly runtimeExtensionSnapshotsByAgentId: Map<string, AgentRuntimeExtensionSnapshot>;

  private specialistFallbackManager: SwarmSpecialistFallbackManager | null = null;
  private readonly runtimeBinding: RuntimeBinding;
  private readonly runtimeCallbackGate: RuntimeCallbackGate;
  private readonly runtimeFactory: RuntimeFactory;
  private runtimeStatusProjector: RuntimeStatusProjector | null = null;
  private runtimeErrorProjector: RuntimeErrorProjector | null = null;
  private runtimeEventProjector: RuntimeEventProjector | null = null;
  private readonly runtimeShutdownQuarantinesByAgentId = new Map<
    string,
    RuntimeShutdownQuarantine
  >();
  private readonly runtimeAdmissionCountsByAgentId = new Map<string, number>();
  private readonly runtimeAdmissionDrainResolversByAgentId = new Map<
    string,
    Set<() => void>
  >();
  private readonly runtimeAdmissionContext = new AsyncLocalStorage<ReadonlySet<string>>();
  private readonly secureRuntimeBindingsByRuntime = new Map<string, SecureRuntimeBinding>();
  private readonly secureRuntimeBindingsByRuntimeObject =
    new WeakMap<SwarmAgentRuntime, SecureRuntimeBinding>();

  constructor(private readonly host: SwarmRuntimeControllerHost) {
    this.runtimeBinding = new RuntimeBinding({
      deactivateRuntimeBindings: (bindingToken) => this.host.forgeExtensionHost.deactivateRuntimeBindings(bindingToken),
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, runtimeToken) =>
        this.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken)
    });
    this.runtimes = this.runtimeBinding.runtimes;
    this.runtimeCreationPromisesByAgentId = this.runtimeBinding.runtimeCreationPromisesByAgentId;
    this.runtimeTokensByAgentId = this.runtimeBinding.runtimeTokensByAgentId;
    this.runtimeExtensionSnapshotsByAgentId = this.runtimeBinding.runtimeExtensionSnapshotsByAgentId;

    this.runtimeCallbackGate = new RuntimeCallbackGate({
      getCurrentRuntimeToken: (agentId) => this.runtimeBinding.getRuntimeToken(agentId),
      now: () => this.now()
    });
    this.runtimeFactory = new RuntimeFactory({
      host,
      forgeExtensionHost: host.forgeExtensionHost,
      config: host.config,
      now: host.now,
      logDebug: (message, details) => this.logDebug(message, details),
      getPiModelsJsonPath: () => this.host.getPiModelsJsonPathOrThrow(),
      getAgentDescriptor: (agentId) => this.host.descriptors.get(agentId),
      getCredentialPoolService: () => this.host.secretsEnvService.getCredentialPoolService(),
      getOpenAIAuthBrokerRuntimeService: () => this.host.secretsEnvService.getOpenAIAuthBrokerRuntimeService(),
      observability: this.host.getObservabilityService?.(),
      getCompactionRuntimeSettingsProvider: () => this.host.getCompactionRuntimeSettingsProvider(),
      onSessionFileRotated: async (descriptor, sessionFile) => {
        if (descriptor.role !== "manager") {
          await this.refreshSessionMetaStatsBySessionId(descriptor.managerId, sessionFile);
          return;
        }

        await this.refreshSessionMetaStats(descriptor, sessionFile);
      },
      getMemoryRuntimeResources: async (descriptor) => this.host.getMemoryRuntimeResources(descriptor),
      getSwarmContextFiles: async (cwd) => this.host.getSwarmContextFiles(cwd),
      resolveProjectExecutableTrustPlan: async (options) =>
        this.host.resolveProjectExecutableTrustPlanForRuntime(options),
      buildCursorSdkRuntimeSystemPrompt: async (descriptor, systemPrompt) =>
        this.host.promptService.buildCursorSdkRuntimeSystemPrompt(descriptor, systemPrompt),
      mergeRuntimeContextFiles: (baseAgentsFiles, options) =>
        this.mergeRuntimeContextFiles(baseAgentsFiles, options),
      callbacks: {
        onStatusChange: async (runtimeToken, agentId, status, pendingCount, contextUsage) => {
          await this.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (runtimeToken, agentId, event) => {
          await this.handleRuntimeSessionEvent(runtimeToken, agentId, event);
        },
        onAgentEnd: async (runtimeToken, agentId) => {
          await this.handleRuntimeAgentEnd(runtimeToken, agentId);
        },
        onRuntimeError: async (runtimeToken, agentId, error) => {
          await this.handleRuntimeError(runtimeToken, agentId, error);
        },
        onRuntimeExtensionSnapshot: async (runtimeToken, agentId, snapshot) => {
          this.handleRuntimeExtensionSnapshot(runtimeToken, agentId, snapshot);
        },
        getLastUserFacingManagerOutputAt: (agentId) =>
          this.getRuntimeEventProjector().getLastUserFacingManagerOutputAt(agentId)
      }
    });
  }

  setSpecialistFallbackManager(manager: SwarmSpecialistFallbackManager): void {
    this.specialistFallbackManager = manager;
    manager.setFallbackHandoffController({
      beginFallbackHandoff: (agentId, suppressedRuntimeToken) =>
        this.beginFallbackHandoff(agentId, suppressedRuntimeToken),
      endFallbackHandoff: (agentId, suppressedRuntimeToken) =>
        this.endFallbackHandoff(agentId, suppressedRuntimeToken),
      getFallbackHandoffSnapshot: (agentId, suppressedRuntimeToken) =>
        this.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken),
      reconcileBufferedCallbacksOnAbort: (agentId, suppressedRuntimeToken, handlers) =>
        this.reconcileBufferedCallbacksOnAbort(agentId, suppressedRuntimeToken, handlers)
    });
  }

  listRuntimeExtensionSnapshots(): AgentRuntimeExtensionSnapshot[] {
    return this.runtimeBinding.listRuntimeExtensionSnapshots();
  }

  getRuntime(agentId: string): SwarmAgentRuntime | undefined {
    return this.runtimeBinding.getRuntime(agentId);
  }

  hasRuntime(agentId: string): boolean {
    return this.runtimeBinding.hasRuntime(agentId);
  }

  isRuntime(agentId: string, runtime: SwarmAgentRuntime): boolean {
    return this.runtimeBinding.isRuntime(agentId, runtime);
  }

  attachRuntime(agentId: string, runtime: SwarmAgentRuntime): void {
    this.runtimeBinding.attachRuntime(agentId, runtime);
  }

  get trackedToolPathsByAgentId(): Map<string, Map<string, { toolName: string; path: string }>> {
    return this.getRuntimeEventProjector().getTrackedToolPathsByAgentId();
  }

  clearTrackedToolPaths(agentId: string): void {
    this.getRuntimeEventProjector().clearTrackedToolPaths(agentId);
  }

  activateManagerAssistantOutputTurn(
    agentId: string,
    target: AssistantOutputTarget,
    options?: { turnId?: string; beginUserVisibleObligation?: boolean },
  ): void {
    this.getRuntimeEventProjector().activateManagerAssistantOutputTurn(agentId, target, options);
  }

  clearManagerAssistantOutputTurn(agentId: string): void {
    this.getRuntimeEventProjector().clearManagerAssistantOutputTurn(agentId);
  }

  flushManagerAssistantOutputTurn(agentId: string): void {
    this.getRuntimeEventProjector().flushManagerAssistantOutputTurn(agentId);
  }

  flushPreservedManagerAssistantOutputForTool(agentId: string, toolName: string): boolean {
    return this.getRuntimeEventProjector().flushPreservedManagerAssistantOutputForTool(agentId, toolName);
  }

  markExplicitManagerAssistantOutput(agentId: string): void {
    this.getRuntimeEventProjector().markExplicitManagerAssistantOutput(agentId);
  }

  suppressIntentionalStopRuntimeCallbacks(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.suppressIntentionalStopRuntimeCallbacks(agentId, runtimeToken);
  }

  clearIntentionalStopRuntimeCallbackSuppression(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.clearIntentionalStopRuntimeCallbackSuppression(agentId, runtimeToken);
  }

  allowInvalidatedManualStopMessageEnd(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.allowInvalidatedManualStopMessageEnd(agentId, runtimeToken);
  }

  clearInvalidatedManualStopMessageEndAllowance(agentId: string, runtimeToken?: number): void {
    this.runtimeCallbackGate.clearInvalidatedManualStopMessageEndAllowance(agentId, runtimeToken);
  }

  beginFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    this.runtimeCallbackGate.beginFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  endFallbackHandoff(agentId: string, suppressedRuntimeToken?: number): void {
    this.runtimeCallbackGate.endFallbackHandoff(agentId, suppressedRuntimeToken);
  }

  getFallbackHandoffSnapshot(
    agentId: string,
    suppressedRuntimeToken?: number
  ): RuntimeCallbackFallbackHandoffSnapshot | undefined {
    return this.runtimeCallbackGate.getFallbackHandoffSnapshot(agentId, suppressedRuntimeToken);
  }

  async reconcileBufferedCallbacksOnAbort(
    agentId: string,
    suppressedRuntimeToken: number | undefined,
    handlers: RuntimeCallbackFallbackHandoffReplayHandlers
  ): Promise<void> {
    await this.runtimeCallbackGate.reconcileBufferedCallbacksOnAbort(agentId, suppressedRuntimeToken, handlers);
  }

  async createRuntimeForDescriptor(
    descriptor: AgentDescriptor,
    systemPrompt: string,
    runtimeToken = this.allocateRuntimeToken(descriptor.agentId),
    options?: RuntimeCreationOptions
  ): Promise<SwarmAgentRuntime> {
    let secureRuntimeBinding = options?.secureRuntimeBinding;
    if (!secureRuntimeBinding && this.host.getSecureRuntimeBinding) {
      try {
        secureRuntimeBinding = await this.host.getSecureRuntimeBinding(
          descriptor,
          runtimeToken,
        );
      } catch {
        this.clearRuntimeToken(descriptor.agentId, runtimeToken);
        throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
      }
    }
    if (options?.secureRuntimeRequired && !secureRuntimeBinding) {
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw new Error(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);
    }

    if (secureRuntimeBinding) {
      this.secureRuntimeBindingsByRuntime.set(
        secureRuntimeBindingKey(descriptor.agentId, runtimeToken),
        secureRuntimeBinding,
      );
    }

    try {
      const runtime = await this.runtimeFactory.createRuntimeForDescriptor(
        descriptor,
        systemPrompt,
        runtimeToken,
        secureRuntimeBinding
          ? { ...options, secureRuntimeBinding }
          : options,
      );
      if (secureRuntimeBinding) {
        this.secureRuntimeBindingsByRuntimeObject.set(
          runtime,
          secureRuntimeBinding,
        );
      }
      return runtime;
    } catch (error) {
      this.invalidateSecureRuntimeBinding(descriptor.agentId, runtimeToken);
      this.clearRuntimeToken(descriptor.agentId, runtimeToken);
      throw error;
    }
  }

  allocateRuntimeToken(agentId: string): number {
    return this.runtimeBinding.allocateRuntimeToken(agentId);
  }

  getRuntimeToken(agentId: string): number | undefined {
    return this.runtimeBinding.getRuntimeToken(agentId);
  }

  clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    const resolvedRuntimeToken =
      runtimeToken ?? this.runtimeBinding.getRuntimeToken(agentId);
    if (resolvedRuntimeToken !== undefined) {
      this.invalidateSecureRuntimeBinding(agentId, resolvedRuntimeToken);
    }
    this.runtimeBinding.clearRuntimeToken(agentId, runtimeToken);
  }

  restoreRuntimeTokenForFallbackRollback(agentId: string, runtimeToken: number): void {
    this.runtimeBinding.restoreRuntimeTokenForFallbackRollback(agentId, runtimeToken);
  }

  detachRuntime(agentId: string, runtimeToken?: number): boolean {
    const resolvedRuntimeToken =
      runtimeToken ?? this.runtimeBinding.getRuntimeToken(agentId);
    const detached = this.runtimeBinding.detachRuntime(agentId, runtimeToken);
    if (detached && resolvedRuntimeToken !== undefined) {
      this.invalidateSecureRuntimeBinding(agentId, resolvedRuntimeToken);
    }
    return detached;
  }

  detachRuntimeIfMatches(
    agentId: string,
    expectedRuntime: SwarmAgentRuntime,
    runtimeToken?: number
  ): boolean {
    const resolvedRuntimeToken =
      runtimeToken ?? this.runtimeBinding.getRuntimeToken(agentId);
    const detached = this.runtimeBinding.detachRuntimeIfMatches(
      agentId,
      expectedRuntime,
      runtimeToken,
    );
    if (detached && resolvedRuntimeToken !== undefined) {
      this.invalidateSecureRuntimeBinding(agentId, resolvedRuntimeToken);
    }
    return detached;
  }

  private invalidateSecureRuntimeBinding(agentId: string, runtimeToken: number): void {
    const key = secureRuntimeBindingKey(agentId, runtimeToken);
    const binding = this.secureRuntimeBindingsByRuntime.get(key);
    try {
      binding?.invalidate?.();
    } finally {
      this.secureRuntimeBindingsByRuntime.delete(key);
    }
  }

  getRuntimeCreationPromise(agentId: string): Promise<SwarmAgentRuntime> | undefined {
    return this.runtimeBinding.getRuntimeCreationPromise(agentId);
  }

  setRuntimeCreationPromise(agentId: string, promise: Promise<SwarmAgentRuntime>): void {
    this.runtimeBinding.setRuntimeCreationPromise(agentId, promise);
  }

  clearRuntimeCreationPromiseIfCurrent(agentId: string, promise: Promise<SwarmAgentRuntime>): boolean {
    return this.runtimeBinding.clearRuntimeCreationPromiseIfCurrent(agentId, promise);
  }

  isRuntimeShutdownQuarantined(agentId: string): boolean {
    return this.runtimeShutdownQuarantinesByAgentId.has(agentId);
  }

  assertRuntimeCreationAllowed(agentId: string): void {
    const quarantine = this.runtimeShutdownQuarantinesByAgentId.get(agentId);
    if (quarantine && !this.runtimeAdmissionContext.getStore()?.has(agentId)) {
      throw new Error(
        quarantine.phase === "stopping"
          ? RUNTIME_SHUTDOWN_IN_PROGRESS_MESSAGE
          : RUNTIME_SHUTDOWN_QUARANTINE_MESSAGE,
      );
    }
  }

  async withRuntimeAdmission<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const quarantine = this.runtimeShutdownQuarantinesByAgentId.get(agentId);
    if (quarantine) {
      throw new Error(
        quarantine.phase === "stopping"
          ? RUNTIME_SHUTDOWN_IN_PROGRESS_MESSAGE
          : RUNTIME_SHUTDOWN_QUARANTINE_MESSAGE,
      );
    }

    this.runtimeAdmissionCountsByAgentId.set(
      agentId,
      (this.runtimeAdmissionCountsByAgentId.get(agentId) ?? 0) + 1,
    );
    const inheritedAdmissions = this.runtimeAdmissionContext.getStore();
    const activeAdmissions = new Set(inheritedAdmissions ?? []);
    activeAdmissions.add(agentId);

    try {
      return await this.runtimeAdmissionContext.run(activeAdmissions, operation);
    } finally {
      const nextCount = Math.max(
        0,
        (this.runtimeAdmissionCountsByAgentId.get(agentId) ?? 1) - 1,
      );
      if (nextCount > 0) {
        this.runtimeAdmissionCountsByAgentId.set(agentId, nextCount);
      } else {
        this.runtimeAdmissionCountsByAgentId.delete(agentId);
        const resolvers = this.runtimeAdmissionDrainResolversByAgentId.get(agentId);
        this.runtimeAdmissionDrainResolversByAgentId.delete(agentId);
        for (const resolve of resolvers ?? []) {
          resolve();
        }
      }
    }
  }

  prepareRuntimeShutdown(agentId: string): void {
    if (this.runtimeShutdownQuarantinesByAgentId.has(agentId)) {
      return;
    }
    this.runtimeShutdownQuarantinesByAgentId.set(agentId, {
      runtime: this.runtimes.get(agentId),
      runtimeToken: this.runtimeTokensByAgentId.get(agentId),
      phase: "stopping",
    });
  }

  async runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    const timeoutMs = options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS;
    this.prepareRuntimeShutdown(descriptor.agentId);
    const preparedQuarantine = this.runtimeShutdownQuarantinesByAgentId.get(descriptor.agentId);
    if (preparedQuarantine?.phase === "unclean") {
      throw new Error(RUNTIME_SHUTDOWN_QUARANTINE_MESSAGE);
    }

    // Message admission covers only the bounded append/enqueue/send-acceptance
    // transaction, not the provider turn. Do not detach or start shutdown until
    // that transaction releases its lease; otherwise it could continue through
    // a detached runtime and create a second writer for the same session file.
    await this.waitForRuntimeAdmissions(descriptor.agentId);

    const runtime = this.runtimes.get(descriptor.agentId);
    if (!runtime) {
      if (preparedQuarantine) {
        this.runtimeShutdownQuarantinesByAgentId.delete(descriptor.agentId);
      }
      return { timedOut: false, runtimeToken: undefined };
    }

    const runtimeToken = this.runtimeTokensByAgentId.get(descriptor.agentId);
    const quarantine: RuntimeShutdownQuarantine = preparedQuarantine ?? {
      runtime,
      runtimeToken,
      phase: "stopping",
    };
    quarantine.runtime = runtime;
    quarantine.runtimeToken = runtimeToken;
    if (!preparedQuarantine) {
      this.runtimeShutdownQuarantinesByAgentId.set(descriptor.agentId, quarantine);
    }

    let operation: Promise<void>;
    try {
      operation = action === "terminate"
        ? runtime.terminate({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          })
        : runtime.stopInFlight({
            abort: options?.abort,
            shutdownTimeoutMs: options?.shutdownTimeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS,
            drainTimeoutMs: options?.drainTimeoutMs ?? RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS,
          });
    } catch (error) {
      if (this.runtimeShutdownQuarantinesByAgentId.get(descriptor.agentId) === quarantine) {
        this.runtimeShutdownQuarantinesByAgentId.delete(descriptor.agentId);
      }
      throw error;
    }

    try {
      await withManagerTimeout(
        operation,
        timeoutMs,
        `${action}:${descriptor.agentId}`
      );
      this.detachRuntime(descriptor.agentId, runtimeToken);
      if (this.runtimeShutdownQuarantinesByAgentId.get(descriptor.agentId) === quarantine) {
        this.runtimeShutdownQuarantinesByAgentId.delete(descriptor.agentId);
      }
      return { timedOut: false, runtimeToken };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const timedOut = /timed out/i.test(message);
      if (timedOut) {
        this.logDebug("runtime:shutdown:timeout", {
          agentId: descriptor.agentId,
          action,
          timeoutMs,
          message,
        });
        quarantine.phase = "unclean";
        this.detachRuntime(descriptor.agentId, runtimeToken);
        void operation.then(
          () => {
            if (this.runtimeShutdownQuarantinesByAgentId.get(descriptor.agentId) !== quarantine) {
              return;
            }
            this.runtimeShutdownQuarantinesByAgentId.delete(descriptor.agentId);
            this.logDebug("runtime:shutdown:quarantine_cleared", {
              agentId: descriptor.agentId,
              action,
            });
          },
          (lateError) => {
            this.logDebug("runtime:shutdown:late_completion", {
              agentId: descriptor.agentId,
              action,
              message: lateError instanceof Error ? lateError.message : String(lateError),
            });
          },
        );
        return { timedOut: true, runtimeToken };
      }

      if (this.runtimeShutdownQuarantinesByAgentId.get(descriptor.agentId) === quarantine) {
        this.runtimeShutdownQuarantinesByAgentId.delete(descriptor.agentId);
      }
      throw error;
    }
  }

  private waitForRuntimeAdmissions(agentId: string): Promise<void> {
    if ((this.runtimeAdmissionCountsByAgentId.get(agentId) ?? 0) === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const resolvers = this.runtimeAdmissionDrainResolversByAgentId.get(agentId) ?? new Set();
      resolvers.add(resolve);
      this.runtimeAdmissionDrainResolversByAgentId.set(agentId, resolvers);
    });
  }

  private getRuntimeStatusProjector(): RuntimeStatusProjector {
    if (!this.runtimeStatusProjector) {
      this.runtimeStatusProjector = new RuntimeStatusProjector({
        descriptors: this.host.descriptors,
        workerStallState: this.host.workerStallState,
        workerActivityState: this.host.workerActivityState,
        now: () => this.now(),
        patchDescriptorFromRuntimeStatus: (agentId, patch) => this.host.patchDescriptorFromRuntimeStatus(agentId, patch),
        updateSessionMetaForWorkerDescriptor: (descriptor) => this.host.updateSessionMetaForWorkerDescriptor(descriptor),
        refreshSessionMetaStatsBySessionId: (sessionAgentId) => this.host.refreshSessionMetaStatsBySessionId(sessionAgentId),
        refreshSessionMetaStats: (descriptor) => this.host.refreshSessionMetaStats(descriptor),
        saveStore: () => this.host.saveStore(),
        emitStatus: (agentId, status, pendingCount, contextUsage) =>
          this.host.emitStatus(agentId, status, pendingCount, contextUsage),
        logDebug: (message, details) => this.logDebug(message, details),
        handleManagerStatusTransition: (descriptor, status, pendingCount) =>
          this.host.cortexService.handleManagerStatusTransition(descriptor, status, pendingCount)
      });
    }

    return this.runtimeStatusProjector;
  }

  private getRuntimeErrorProjector(): RuntimeErrorProjector {
    if (!this.runtimeErrorProjector) {
      this.runtimeErrorProjector = new RuntimeErrorProjector({
        descriptors: this.host.descriptors,
        getRuntimeToken: (agentId) => this.runtimeBinding.getRuntimeToken(agentId),
        now: () => this.now(),
        maybeRecordModelCapacityBlock: (agentId, descriptor, error) =>
          this.host.maybeRecordModelCapacityBlock(agentId, descriptor, error),
        dispatchRuntimeError: (runtimeToken, error) =>
          this.host.forgeExtensionHost.dispatchRuntimeError(createForgeBindingToken(runtimeToken), error),
        maybeRecoverWorkerWithSpecialistFallback: (agentId, errorMessage, sourcePhase, runtimeToken) =>
          this.maybeRecoverWorkerWithSpecialistFallback(agentId, errorMessage, sourcePhase, runtimeToken),
        incrementSessionCompactionCount: (profileId, sessionId, failureLogKey) =>
          this.host.incrementSessionCompactionCount(profileId, sessionId, failureLogKey),
        incrementWorkerCompactionCount: (agentId, failureLogKey) =>
          this.host.incrementWorkerCompactionCount(agentId, failureLogKey),
        patchDescriptorFromRuntimeStatus: (agentId, patch) =>
          this.host.patchDescriptorFromRuntimeStatus(agentId, patch),
        emitConversationMessage: (event) => this.host.emitConversationMessage(event),
        logDebug: (message, details) => this.logDebug(message, details)
      });
    }

    return this.runtimeErrorProjector;
  }

  private getRuntimeEventProjector(): RuntimeEventProjector {
    if (!this.runtimeEventProjector) {
      this.runtimeEventProjector = new RuntimeEventProjector({
        config: this.host.config,
        descriptors: this.host.descriptors,
        workerStallState: this.host.workerStallState,
        workerActivityState: this.host.workerActivityState,
        runtimeRecoveryState: this.host.runtimeRecoveryState,
        now: () => this.now(),
        conversationProjector: {
          captureConversationEventFromRuntime: (agentId, event, options) => {
            if (options?.turnId) {
              this.host.conversationProjector.captureConversationEventFromRuntime(agentId, event, options);
            } else {
              this.host.conversationProjector.captureConversationEventFromRuntime(agentId, event);
            }
          },
          emitConversationMessage: (event, options) => {
            if (options) {
              this.host.emitConversationMessage(event, options);
            } else {
              this.host.emitConversationMessage(event);
            }
          },
        },
        markSessionActivity: (agentId, timestamp) => this.host.markSessionActivity(agentId, timestamp),
        maybeRecordModelCapacityBlock: (agentId, descriptor, error) =>
          this.host.maybeRecordModelCapacityBlock(agentId, descriptor, error),
        maybeRecoverWorkerWithSpecialistFallback: (agentId, errorMessage, sourcePhase, runtimeToken) =>
          this.maybeRecoverWorkerWithSpecialistFallback(agentId, errorMessage, sourcePhase, runtimeToken),
        consumePendingManualManagerStopNoticeIfApplicable: (agentId, event) =>
          this.host.consumePendingManualManagerStopNoticeIfApplicable(agentId, event),
        stripManagerAbortErrorFromEvent: (event) => this.host.stripManagerAbortErrorFromEvent(event),
        isRuntimeRecoveryActive: (agentId) => this.host.isRuntimeRecoveryActive(agentId),
        beginPendingTransientWorkerTerminatedError: (agentId, event, expire) =>
          this.host.beginPendingTransientWorkerTerminatedError(agentId, event, expire),
        cancelPendingTransientWorkerTerminatedError: (agentId, reason) =>
          this.host.cancelPendingTransientWorkerTerminatedError(agentId, reason),
        hasPendingTransientWorkerTerminatedError: (agentId) =>
          this.host.hasPendingTransientWorkerTerminatedError(agentId),
        queueVersionedToolMutation: (descriptor, mutation) => this.host.queueVersionedToolMutation(descriptor, mutation),
        logDebug: (message, details) => this.logDebug(message, details),
        getRuntime: (agentId) => this.getRuntime(agentId),
        isModelCacheVisualizationEnabled: () => this.host.isModelCacheVisualizationEnabled(),
        emitModelCacheObservation: (event) => this.host.emitModelCacheObservation(event),
        getActiveTurnId: (agentId, runtimeToken) => this.host.getActiveTurnId?.(agentId, runtimeToken),
        hasPendingSupersedingUserInput: (agentId, activeTurnId) =>
          this.host.hasPendingSupersedingUserInput?.(agentId, activeTurnId) ?? false,
        resolveManagerAssistantFinalOutputTarget: (agentId, _descriptor, activeTarget) =>
          this.host.resolveManagerAssistantFinalOutputTarget(agentId, activeTarget),
        resolveManagerAssistantFinalOutputRoute: (agentId, _descriptor, activeTarget) =>
          this.host.resolveManagerAssistantFinalOutputRoute?.(agentId, activeTarget)
      });
    }

    return this.runtimeEventProjector;
  }

  async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ): Promise<void> {
    if (this.runtimeCallbackGate.bufferStatusDuringHandoff(agentId, runtimeToken, status, pendingCount, contextUsage)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.host.recordManagerTurnWatchdogStatus?.(agentId, runtimeToken, status, pendingCount);
    await this.getRuntimeStatusProjector().projectStatus({ agentId, status, pendingCount, contextUsage });
    const descriptor = this.descriptors.get(agentId);
    if (descriptor?.role === "worker") {
      await this.host.handleWorkerStatus(
        agentId,
        descriptor as AgentDescriptor & { role: "worker" },
        descriptor.status,
        pendingCount,
      );
    }
  }

  async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent
  ): Promise<boolean> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrEvent as string)
      : runtimeTokenOrAgentId;
    const event = invokedWithExplicitToken ? maybeEvent : (agentIdOrEvent as RuntimeSessionEvent);

    if (!event) {
      return false;
    }

    if (this.runtimeCallbackGate.shouldIgnoreRuntimeSessionEvent(agentId, runtimeToken, event.type)) {
      return false;
    }

    const guardedEvent = this.guardRuntimeSessionEvent(
      agentId,
      runtimeToken,
      event,
    );
    this.host.recordManagerTurnWatchdogEvent?.(agentId, runtimeToken, guardedEvent);
    this.host.beforeRuntimeEventProjection?.(agentId, runtimeToken, guardedEvent);
    // Capture exact terminal-turn authority before TurnContext consumes it during
    // after-projection. Raw provider retry events never reach this accepted boundary.
    const terminalTurnId = guardedEvent.type === "agent_end"
      ? this.host.getActiveTurnId?.(agentId, runtimeToken)
      : undefined;
    await this.getRuntimeEventProjector().projectEvent({
      agentId,
      runtimeToken,
      event: guardedEvent,
    });
    if (this.host.afterRuntimeEventProjection) {
      this.host.afterRuntimeEventProjection(agentId, runtimeToken, guardedEvent);
    } else {
      this.host.onAcceptedRuntimeSessionEvent?.(agentId, runtimeToken, guardedEvent);
    }
    const descriptor = terminalTurnId ? this.descriptors.get(agentId) : undefined;
    if (terminalTurnId && descriptor?.profileId) {
      try {
        await this.host.handoffExternalChromeAtTurnEnd?.(descriptor.profileId, agentId, terminalTurnId);
      } catch (error) {
        // The browser service persisted opaque pending authority before transport.
        // Runtime settlement must remain available while reconnect/retry completes it.
        this.host.logDebug("external-chrome:turn-disposition-pending", { agentId, turnId: terminalTurnId, error: String(error) });
      }
    }
    return true;
  }

  async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent
  ): Promise<void> {
    const invokedWithExplicitToken = typeof runtimeTokenOrAgentId === "number";
    const runtimeToken = invokedWithExplicitToken ? runtimeTokenOrAgentId : undefined;
    const agentId = invokedWithExplicitToken
      ? (agentIdOrError as string)
      : runtimeTokenOrAgentId;
    const error = invokedWithExplicitToken ? maybeError : (agentIdOrError as RuntimeErrorEvent);

    if (!error) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    const guardedError = this.guardRuntimeErrorEvent(
      agentId,
      runtimeToken,
      error,
    );
    this.host.recordManagerTurnWatchdogRuntimeError?.(agentId, runtimeToken, guardedError);
    this.clearManagerAssistantOutputTurn(agentId);
    this.recordObservabilityRuntimeError(agentId, runtimeToken, guardedError);

    await this.getRuntimeErrorProjector().projectError({ agentId, runtimeToken, error: guardedError });
  }

  private guardRuntimeSessionEvent(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): RuntimeSessionEvent {
    const binding = this.getSecureRuntimeBindingForCallback(agentId, runtimeToken);
    if (!binding) {
      return event;
    }

    const guarded = guardSecureRuntimeValue(binding, event);
    if (
      !guarded ||
      typeof guarded !== "object" ||
      Array.isArray(guarded) ||
      guarded.type !== event.type
    ) {
      throw new Error(SECURE_RUNTIME_GUARD_FAILURE_MESSAGE);
    }
    return guarded;
  }

  private guardRuntimeErrorEvent(
    agentId: string,
    runtimeToken: number | undefined,
    error: RuntimeErrorEvent,
  ): RuntimeErrorEvent {
    const binding = this.getSecureRuntimeBindingForCallback(agentId, runtimeToken);
    if (!binding) {
      return error;
    }

    try {
      const guarded = guardSecureRuntimeValue(binding, error);
      if (
        guarded &&
        typeof guarded === "object" &&
        !Array.isArray(guarded) &&
        guarded.phase === error.phase &&
        typeof guarded.message === "string"
      ) {
        return guarded;
      }
    } catch {
      // Use a fixed event below so no raw runtime error reaches another sink.
    }

    return {
      phase: error.phase,
      message: SECURE_RUNTIME_GUARD_FAILURE_MESSAGE,
    };
  }

  private getSecureRuntimeBindingForCallback(
    agentId: string,
    runtimeToken: number | undefined,
  ): SecureRuntimeBinding | undefined {
    const resolvedRuntimeToken =
      runtimeToken ?? this.runtimeBinding.getRuntimeToken(agentId);
    if (resolvedRuntimeToken === undefined) {
      return undefined;
    }
    return this.secureRuntimeBindingsByRuntime.get(
      secureRuntimeBindingKey(agentId, resolvedRuntimeToken),
    );
  }

  isSecureRuntimeBindingUsable(
    agentId: string,
    runtime: SwarmAgentRuntime,
  ): boolean {
    if (this.runtimes.get(agentId) !== runtime) return false;
    return this.isSecureRuntimeBindingValid(runtime);
  }

  hasSecureRuntimeBinding(runtime: SwarmAgentRuntime): boolean {
    return this.secureRuntimeBindingsByRuntimeObject.has(runtime);
  }

  isSecureRuntimeBindingValid(runtime: SwarmAgentRuntime): boolean {
    const binding = this.secureRuntimeBindingsByRuntimeObject.get(runtime);
    if (!binding) return false;
    try {
      return binding.guardValue(true) === true;
    } catch {
      return false;
    }
  }

  async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    const runtimeToken = typeof runtimeTokenOrAgentId === "number" ? runtimeTokenOrAgentId : undefined;
    const agentId = typeof runtimeTokenOrAgentId === "number" ? maybeAgentId : runtimeTokenOrAgentId;

    if (!agentId) {
      return;
    }

    if (this.runtimeCallbackGate.bufferAgentEndDuringHandoff(agentId, runtimeToken)) {
      return;
    }

    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }
    this.clearTrackedToolPaths(agentId);
    const descriptor = this.descriptors.get(agentId);
    if (descriptor?.role === "manager") {
      this.flushManagerAssistantOutputTurn(agentId);
      this.host.recordManagerTurnWatchdogTerminal?.(agentId, "agent_end");
    }
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    await this.host.handleWorkerAgentEnd(agentId, descriptor);
  }

  private recordObservabilityRuntimeError(agentId: string, runtimeToken: number | undefined, error: RuntimeErrorEvent): void {
    const descriptor = this.descriptors.get(agentId);
    const observability = this.host.getObservabilityService?.();
    if (!descriptor || !observability) {
      return;
    }

    observability.recordRuntimeError({
      agentId,
      managerId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      profileId: descriptor.profileId,
      role: descriptor.role,
      runtimeType: descriptor.model.provider === "cursor-sdk" ? "cursor-sdk" : "pi",
      runtimeToken,
      agentName: descriptor.displayName,
      phase: error.phase,
      message: error.message,
      stack: error.stack,
      details: error.details,
      metadata: {
        modelProvider: descriptor.model.provider,
        modelId: descriptor.model.modelId,
        status: descriptor.status,
      },
    });
  }

  private get descriptors(): Map<string, AgentDescriptor> {
    return this.host.descriptors;
  }

  private now(): string {
    return this.host.now();
  }

  private logDebug(message: string, details?: unknown): void {
    this.host.logDebug(message, details);
  }

  private async refreshSessionMetaStatsBySessionId(
    sessionAgentId: string,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.host.refreshSessionMetaStatsBySessionId(sessionAgentId, sessionFileOverride);
  }

  private async refreshSessionMetaStats(
    descriptor: AgentDescriptor,
    sessionFileOverride?: string
  ): Promise<void> {
    await this.host.refreshSessionMetaStats(descriptor, sessionFileOverride);
  }

  private mergeRuntimeContextFiles(
    baseAgentsFiles: Array<{ path: string; content: string }>,
    options: {
      memoryContextFile: { path: string; content: string };
      swarmContextFiles: Array<{ path: string; content: string }>;
    }
  ): Array<{ path: string; content: string }> {
    const swarmContextPaths = new Set(options.swarmContextFiles.map((entry) => entry.path));
    const withoutSwarmAndMemory = baseAgentsFiles.filter(
      (entry) => entry.path !== options.memoryContextFile.path && !swarmContextPaths.has(entry.path)
    );

    return [...withoutSwarmAndMemory, ...options.swarmContextFiles, options.memoryContextFile];
  }

  private shouldIgnoreRuntimeCallback(agentId: string, runtimeToken?: number): boolean {
    return this.runtimeCallbackGate.shouldIgnoreRuntimeCallback(agentId, runtimeToken);
  }

  private handleRuntimeExtensionSnapshot(
    runtimeToken: number,
    agentId: string,
    snapshot: AgentRuntimeExtensionSnapshot
  ): void {
    if (this.shouldIgnoreRuntimeCallback(agentId, runtimeToken)) {
      return;
    }

    this.runtimeBinding.recordRuntimeExtensionSnapshot(agentId, snapshot);
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    this.getRuntimeEventProjector().updateWorkerActivity(agentId, event);
  }

  async resolveSpecialistFallbackModelForDescriptor(
    descriptor: AgentDescriptor
  ): Promise<AgentModelDescriptor | undefined> {
    return this.specialistFallbackManager?.resolveSpecialistFallbackModelForDescriptor(descriptor);
  }

  private async maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_dispatch" | "prompt_start",
    runtimeToken?: number
  ): Promise<boolean> {
    return this.host.maybeRecoverWorkerWithSpecialistFallback(
      agentId,
      errorMessage,
      sourcePhase,
      runtimeToken
    );
  }
}

function secureRuntimeBindingKey(agentId: string, runtimeToken: number): string {
  return `${agentId}\0${runtimeToken}`;
}
