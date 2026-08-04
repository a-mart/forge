import type { ConversationMessageEvent } from "./types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
} from "./types.js";
import type {
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  SwarmAgentRuntime,
} from "./runtime-contracts.js";
import type { SwarmRuntimeControllerHost } from "./swarm-runtime-controller.js";
import type {
  SwarmWorkerHealthService,
  WorkerActivityState,
  WorkerStallState,
} from "./swarm-worker-health-service.js";
import { ManagerTurnWatchdog } from "./manager-turn-watchdog.js";
import { shouldPreserveActiveTurnForRuntimeError } from "./runtime-error-lifecycle-policy.js";
import { MANUAL_MANAGER_STOP_NOTICE } from "./manual-stop-notice.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
  isAbortLikeErrorMessage,
  normalizeProviderErrorMessage,
} from "./message-utils.js";
import type { TurnLedgerSessionTarget } from "./turn-ledger.js";
import { isRuntimeRecoveryActiveForRuntime } from "./runtime/runtime-recovery-state.js";

export const PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS = 15_000;

export interface RuntimeLifecycleController {
  readonly runtimes: Map<string, SwarmAgentRuntime>;
  allocateRuntimeToken(agentId: string): number;
  clearRuntimeToken(agentId: string, runtimeToken?: number): void;
  detachRuntime(agentId: string, runtimeToken?: number): boolean;
  runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions,
  ): Promise<{ timedOut: boolean; runtimeToken?: number }>;
  handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage,
  ): Promise<void>;
  handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent,
  ): Promise<boolean>;
  handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent,
  ): Promise<void>;
  handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void>;
  clearInvalidatedManualStopMessageEndAllowance(agentId: string): void;
}

export interface RuntimeLifecycleTurnContext {
  beforeRuntimeEventProjection(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void;
  afterRuntimeEventProjection(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void;
  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined;
  hasPendingSupersedingUserInput(agentId: string, activeTurnId?: string): boolean;
  handleRuntimeError(agentId: string): void;
  discard(agentId: string): void;
  clearAgentState(agentId: string): void;
}

export interface RuntimeLifecycleCodexScopes {
  closeWorkerScope(agentId: string): void;
  recordManagerAgentEnd(agentId: string): void;
}

export interface RuntimeLifecyclePlans {
  finalizeUsage(owner: AgentDescriptor & { role: "manager"; profileId: string }): Promise<void>;
}

export interface RuntimeLifecycleGoals {
  scheduleContinuation(owner: AgentDescriptor & { role: "manager"; profileId: string }): void;
}

export interface RuntimeLifecycleChoices {
  hasPendingChoicesForSession(sessionAgentId: string): boolean;
}

export interface RuntimeLifecycleDescriptorMutations {
  patchDescriptor(
    agentId: string,
    patch: (descriptor: AgentDescriptor) => AgentDescriptor,
  ): Promise<AgentDescriptor>;
}

export interface RuntimeLifecycleDirectory {
  listWorkersForSession(sessionAgentId: string): AgentDescriptor[];
}

export interface RuntimeLifecycleEvents {
  emitConversationMessage(event: ConversationMessageEvent): void;
  emitSessionWorkersSnapshot(sessionAgentId: string, workers: AgentDescriptor[]): void;
}

export interface SwarmRuntimeLifecycleCoordinatorOptions {
  dataDir: string;
  descriptors: Map<string, AgentDescriptor>;
  controller: RuntimeLifecycleController;
  workerHealth: SwarmWorkerHealthService;
  turnContext: RuntimeLifecycleTurnContext;
  codexScopes: RuntimeLifecycleCodexScopes;
  plans: RuntimeLifecyclePlans;
  goals: RuntimeLifecycleGoals;
  choices: RuntimeLifecycleChoices;
  descriptorMutations: RuntimeLifecycleDescriptorMutations;
  directory: RuntimeLifecycleDirectory;
  events: RuntimeLifecycleEvents;
  now: () => string;
  logDebug(message: string, details?: unknown): void;
}

type RuntimeLifecycleHostCallbackKey =
  | "consumePendingManualManagerStopNoticeIfApplicable"
  | "stripManagerAbortErrorFromEvent"
  | "beginPendingTransientWorkerTerminatedError"
  | "cancelPendingTransientWorkerTerminatedError"
  | "hasPendingTransientWorkerTerminatedError"
  | "handleWorkerStatus"
  | "handleWorkerAgentEnd"
  | "isRuntimeRecoveryActive"
  | "beforeRuntimeEventProjection"
  | "getActiveTurnId"
  | "hasPendingSupersedingUserInput"
  | "recordManagerTurnWatchdogStatus"
  | "recordManagerTurnWatchdogEvent"
  | "recordManagerTurnWatchdogRuntimeError"
  | "recordManagerTurnWatchdogTerminal"
  | "afterRuntimeEventProjection";

export type RuntimeLifecycleControllerHostCallbacks = Pick<
  SwarmRuntimeControllerHost,
  RuntimeLifecycleHostCallbackKey
>;

/**
 * Creates the callback slice required by SwarmRuntimeController without making
 * the manager facade repeat seventeen forwarding closures. Resolution is lazy
 * because the controller is constructed before this coordinator.
 */
export function createRuntimeLifecycleControllerHostCallbacks(
  getCoordinator: () => SwarmRuntimeLifecycleCoordinator,
): RuntimeLifecycleControllerHostCallbacks {
  return {
    consumePendingManualManagerStopNoticeIfApplicable: (agentId, event) =>
      getCoordinator().consumePendingManualManagerStopNoticeIfApplicable(agentId, event),
    stripManagerAbortErrorFromEvent: (event) => getCoordinator().stripManagerAbortErrorFromEvent(event),
    beginPendingTransientWorkerTerminatedError: (agentId, event, expire) =>
      getCoordinator().beginPendingTransientWorkerTerminatedError(agentId, event, expire),
    cancelPendingTransientWorkerTerminatedError: (agentId, reason) =>
      getCoordinator().cancelPendingTransientWorkerTerminatedError(agentId, reason),
    hasPendingTransientWorkerTerminatedError: (agentId) =>
      getCoordinator().hasPendingTransientWorkerTerminatedError(agentId),
    handleWorkerStatus: (agentId, descriptor, status, pendingCount) =>
      getCoordinator().handleWorkerStatus(agentId, descriptor, status, pendingCount),
    handleWorkerAgentEnd: (agentId, descriptor) =>
      getCoordinator().handleWorkerAgentEnd(agentId, descriptor),
    isRuntimeRecoveryActive: (agentId) => getCoordinator().isRuntimeRecoveryActive(agentId),
    beforeRuntimeEventProjection: (agentId, runtimeToken, event) =>
      getCoordinator().beforeRuntimeEventProjection(agentId, runtimeToken, event),
    getActiveTurnId: (agentId, runtimeToken) => getCoordinator().getActiveTurnId(agentId, runtimeToken),
    hasPendingSupersedingUserInput: (agentId, activeTurnId) =>
      getCoordinator().hasPendingSupersedingUserInput(agentId, activeTurnId),
    recordManagerTurnWatchdogStatus: (agentId, runtimeToken, status, pendingCount) =>
      getCoordinator().recordManagerTurnWatchdogStatus(agentId, runtimeToken, status, pendingCount),
    recordManagerTurnWatchdogEvent: (agentId, runtimeToken, event) =>
      getCoordinator().recordManagerTurnWatchdogEvent(agentId, runtimeToken, event),
    recordManagerTurnWatchdogRuntimeError: (agentId, runtimeToken, error) =>
      getCoordinator().recordManagerTurnWatchdogRuntimeError(agentId, runtimeToken, error),
    recordManagerTurnWatchdogTerminal: (agentId, outcome) =>
      getCoordinator().recordManagerTurnWatchdogTerminal(agentId, outcome),
    afterRuntimeEventProjection: (agentId, runtimeToken, event) =>
      getCoordinator().afterRuntimeEventProjection(agentId, runtimeToken, event),
  };
}

/**
 * Owns runtime callback ordering, health projection, turn-ledger target
 * resolution, and manual-stop callback reconciliation. Provider construction
 * remains in SwarmRuntimeController; worker-health policy remains in its leaf
 * service.
 */
export class SwarmRuntimeLifecycleCoordinator {
  private readonly managerTurnWatchdog: ManagerTurnWatchdog;
  private readonly pendingManualStopNoticeTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: SwarmRuntimeLifecycleCoordinatorOptions) {
    this.managerTurnWatchdog = new ManagerTurnWatchdog({
      dataDir: options.dataDir,
      descriptors: options.descriptors,
      now: options.now,
      getSessionTarget: (agentId) => this.getTurnLedgerSessionTarget(agentId),
      getActiveTurnId: (agentId, runtimeToken) => options.turnContext.getActiveTurnId(agentId, runtimeToken),
      hasPendingChoicesForSession: (sessionAgentId) =>
        options.choices.hasPendingChoicesForSession(sessionAgentId),
      isRuntimeRecoveryActive: (agentId) => this.isRuntimeRecoveryActive(agentId),
      emitConversationMessage: (event) => options.events.emitConversationMessage(event),
      logDebug: options.logDebug,
    });
  }

  get workerHealth(): SwarmWorkerHealthService {
    return this.options.workerHealth;
  }

  get runtimes(): Map<string, SwarmAgentRuntime> {
    return this.options.controller.runtimes;
  }

  getTurnLedgerSessionTarget(agentId: string): TurnLedgerSessionTarget | null {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor) return null;

    const manager = descriptor.role === "manager"
      ? descriptor
      : this.options.descriptors.get(descriptor.managerId);
    if (!manager || manager.role !== "manager") return null;

    return {
      dataDir: this.options.dataDir,
      profileId: manager.profileId ?? manager.agentId,
      sessionAgentId: manager.agentId,
    };
  }

  allocateRuntimeToken(agentId: string): number {
    return this.options.controller.allocateRuntimeToken(agentId);
  }

  clearRuntimeToken(agentId: string, runtimeToken?: number): void {
    this.options.controller.clearRuntimeToken(agentId, runtimeToken);
  }

  detachRuntime(agentId: string, runtimeToken?: number): boolean {
    const detached = this.options.controller.detachRuntime(agentId, runtimeToken);
    if (detached) {
      this.options.turnContext.discard(agentId);
      this.options.codexScopes.closeWorkerScope(agentId);
    }
    return detached;
  }

  clearAgentState(agentId: string): void {
    this.options.turnContext.clearAgentState(agentId);
  }

  runRuntimeShutdown(
    descriptor: AgentDescriptor,
    action: "terminate" | "stopInFlight",
    options?: RuntimeShutdownOptions,
  ): Promise<{ timedOut: boolean; runtimeToken?: number }> {
    return this.options.controller.runRuntimeShutdown(descriptor, action, options);
  }

  async handleRuntimeStatus(
    runtimeToken: number,
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage,
  ): Promise<void> {
    await this.options.controller.handleRuntimeStatus(runtimeToken, agentId, status, pendingCount, contextUsage);
    const descriptor = this.options.descriptors.get(agentId);
    if (status === "idle" && pendingCount === 0 && descriptor?.status === "idle" && isSessionManager(descriptor)) {
      await this.options.plans.finalizeUsage(descriptor);
      this.options.goals.scheduleContinuation(descriptor);
    }
  }

  async handleRuntimeSessionEvent(
    runtimeTokenOrAgentId: number | string,
    agentIdOrEvent: string | RuntimeSessionEvent,
    maybeEvent?: RuntimeSessionEvent,
  ): Promise<void> {
    await this.options.controller.handleRuntimeSessionEvent(
      runtimeTokenOrAgentId,
      agentIdOrEvent,
      maybeEvent,
    );
  }

  async handleRuntimeError(
    runtimeTokenOrAgentId: number | string,
    agentIdOrError: string | RuntimeErrorEvent,
    maybeError?: RuntimeErrorEvent,
  ): Promise<void> {
    const agentId = typeof runtimeTokenOrAgentId === "number"
      ? agentIdOrError as string
      : runtimeTokenOrAgentId;
    const error = typeof runtimeTokenOrAgentId === "number" ? maybeError : agentIdOrError as RuntimeErrorEvent;
    if (!error || !shouldPreserveActiveTurnForRuntimeError(error)) {
      this.options.turnContext.handleRuntimeError(agentId);
    }
    await this.options.controller.handleRuntimeError(runtimeTokenOrAgentId, agentIdOrError, maybeError);
  }

  async incrementWorkerCompactionCount(
    agentId: string,
    failureLogKey: string,
  ): Promise<number | undefined> {
    try {
      const updated = await this.options.descriptorMutations.patchDescriptor(
        agentId,
        (descriptor) => {
          if (descriptor.role !== "worker") {
            throw new Error(`Agent is not a worker: ${agentId}`);
          }

          const currentCount =
            typeof descriptor.compactionCount === "number"
            && Number.isFinite(descriptor.compactionCount)
            && descriptor.compactionCount >= 0
              ? Math.floor(descriptor.compactionCount)
              : 0;
          return { ...descriptor, compactionCount: currentCount + 1 };
        },
      );
      this.options.events.emitSessionWorkersSnapshot(
        updated.managerId,
        this.options.directory.listWorkersForSession(updated.managerId),
      );
      return updated.compactionCount;
    } catch (error) {
      this.options.logDebug(failureLogKey, { agentId, error: String(error) });
      return undefined;
    }
  }

  async handleRuntimeAgentEnd(runtimeTokenOrAgentId: number | string, maybeAgentId?: string): Promise<void> {
    const agentId = typeof runtimeTokenOrAgentId === "number" ? maybeAgentId : runtimeTokenOrAgentId;
    const descriptor = agentId ? this.options.descriptors.get(agentId) : undefined;
    if (agentId && descriptor?.role === "manager") {
      this.options.codexScopes.recordManagerAgentEnd(agentId);
    }

    await this.options.controller.handleRuntimeAgentEnd(runtimeTokenOrAgentId, maybeAgentId);
    if (isSessionManager(descriptor)) {
      await this.options.plans.finalizeUsage(descriptor);
    }
  }

  beforeRuntimeEventProjection(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    this.options.turnContext.beforeRuntimeEventProjection(agentId, runtimeToken, event);
  }

  afterRuntimeEventProjection(agentId: string, runtimeToken: number | undefined, event: RuntimeSessionEvent): void {
    this.options.turnContext.afterRuntimeEventProjection(agentId, runtimeToken, event);
  }

  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined {
    return this.options.turnContext.getActiveTurnId(agentId, runtimeToken);
  }

  hasPendingSupersedingUserInput(agentId: string, activeTurnId?: string): boolean {
    return this.options.turnContext.hasPendingSupersedingUserInput(agentId, activeTurnId);
  }

  runLivenessHealthSweep(): void {
    this.managerTurnWatchdog.check();
  }

  recordManagerTurnWatchdogStatus(
    agentId: string,
    runtimeToken: number | undefined,
    status: AgentStatus,
    pendingCount: number,
  ): void {
    this.managerTurnWatchdog.recordStatus(agentId, runtimeToken, status, pendingCount);
  }

  recordManagerTurnWatchdogEvent(
    agentId: string,
    runtimeToken: number | undefined,
    event: RuntimeSessionEvent,
  ): void {
    this.managerTurnWatchdog.recordEvent(agentId, runtimeToken, event);
  }

  recordManagerTurnWatchdogRuntimeError(
    agentId: string,
    _runtimeToken: number | undefined,
    error: RuntimeErrorEvent,
  ): void {
    this.managerTurnWatchdog.recordRuntimeError(agentId, error);
  }

  recordManagerTurnWatchdogTerminal(agentId: string, outcome: "agent_end" | "idle" | "error"): void {
    this.managerTurnWatchdog.recordTerminal(agentId, outcome);
  }

  isRuntimeInContextRecovery(agentId: string): boolean {
    return Boolean(this.runtimes.get(agentId)?.isContextRecoveryInProgress?.());
  }

  isRuntimeRecoveryActive(agentId: string): boolean {
    return isRuntimeRecoveryActiveForRuntime(this.runtimes.get(agentId));
  }

  markPendingManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNoticeTimer(agentId);
    const timer = setTimeout(() => {
      this.pendingManualStopNoticeTimers.delete(agentId);
      this.options.controller.clearInvalidatedManualStopMessageEndAllowance(agentId);
    }, PENDING_MANUAL_MANAGER_STOP_NOTICE_TTL_MS);
    timer.unref?.();
    this.pendingManualStopNoticeTimers.set(agentId, timer);
  }

  clearPendingManualManagerStopNotice(agentId: string): void {
    this.clearPendingManualManagerStopNoticeTimer(agentId);
  }

  emitImmediateManualManagerStopNotice(
    agentId: string,
    text = MANUAL_MANAGER_STOP_NOTICE,
  ): void {
    this.clearPendingManualManagerStopNotice(agentId);
    this.options.controller.clearInvalidatedManualStopMessageEndAllowance(agentId);
    this.options.events.emitConversationMessage({
      type: "conversation_message",
      agentId,
      role: "system",
      text,
      timestamp: this.options.now(),
      source: "system",
    });
  }

  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean {
    if (!this.pendingManualStopNoticeTimers.has(agentId) || event.type !== "message_end") return false;
    if (extractRole(event.message) !== "assistant") return false;

    const stopReason = extractMessageStopReason(event.message);
    if (stopReason !== "error" && !hasMessageErrorMessageField(event.message)) return false;

    const normalizedErrorMessage = normalizeProviderErrorMessage(
      extractMessageErrorMessage(event.message) ?? extractMessageText(event.message),
    );
    this.clearPendingManualManagerStopNotice(agentId);
    return isAbortLikeErrorMessage(normalizedErrorMessage);
  }

  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent {
    if (event.type !== "message_end") return event;
    const message = event.message as typeof event.message & { errorMessage?: unknown; stopReason?: unknown };
    const { errorMessage: _errorMessage, ...messageWithoutError } = message;
    return {
      ...event,
      message: { ...messageWithoutError, stopReason: "stop" } as typeof event.message,
    };
  }

  startWorkerHealth(): void {
    this.options.workerHealth.ensureStarted();
  }

  getWorkerActivity(agentId: string): ReturnType<SwarmWorkerHealthService["getWorkerActivity"]> {
    return this.options.workerHealth.getWorkerActivity(agentId);
  }

  checkForStalledWorkers(): Promise<void> {
    return this.options.workerHealth.checkForStalledWorkers();
  }

  handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    return this.options.workerHealth.handleStallNudge(agentId, elapsedMs);
  }

  handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    return this.options.workerHealth.handleStallDetailedReport(agentId, elapsedMs);
  }

  handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    return this.options.workerHealth.handleStallAutoKill(agentId, elapsedMs);
  }

  handleWorkerAgentEnd(
    agentId: string,
    descriptor: AgentDescriptor,
  ): Promise<void> {
    return this.options.workerHealth.handleRuntimeAgentEnd(agentId, descriptor);
  }

  handleWorkerStatus(
    agentId: string,
    descriptor: AgentDescriptor & { role: "worker" },
    status: AgentStatus,
    pendingCount: number,
  ): Promise<void> {
    return this.options.workerHealth.handleRuntimeStatus(agentId, descriptor, status, pendingCount);
  }

  deleteWorkerStallState(agentId: string): void {
    this.options.workerHealth.deleteWorkerStallState(agentId);
  }

  deleteWorkerActivityState(agentId: string): void {
    this.options.workerHealth.deleteWorkerActivityState(agentId);
  }

  clearWorkerHealthState(agentId: string): void {
    this.options.workerHealth.clearWorkerHealthState(agentId);
  }

  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>,
  ): boolean {
    return this.options.workerHealth.beginPendingTransientWorkerTerminatedError(agentId, event, expire);
  }

  cancelPendingTransientWorkerTerminatedError(
    agentId: string,
    reason: "runtime_progress" | "clear_state",
  ): void {
    this.options.workerHealth.cancelPendingTransientWorkerTerminatedError(agentId, reason);
  }

  hasPendingTransientWorkerTerminatedError(agentId: string): boolean {
    return this.options.workerHealth.hasPendingTransientWorkerTerminatedError(agentId);
  }

  get workerStallState(): Map<string, WorkerStallState> {
    return this.options.workerHealth.workerStallState;
  }

  get workerActivityState(): Map<string, WorkerActivityState> {
    return this.options.workerHealth.workerActivityState;
  }

  private clearPendingManualManagerStopNoticeTimer(agentId: string): void {
    const timer = this.pendingManualStopNoticeTimers.get(agentId);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingManualStopNoticeTimers.delete(agentId);
  }
}

function isSessionManager(
  descriptor: AgentDescriptor | undefined,
): descriptor is AgentDescriptor & { role: "manager"; profileId: string } {
  return descriptor?.role === "manager"
    && typeof descriptor.profileId === "string"
    && descriptor.profileId.trim().length > 0;
}
