import { resolvePromptVariables, type PromptCategory } from "./prompt-registry.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-contracts.js";
import type {
  AgentDescriptor,
  AgentStatus,
  ConversationEntryEvent,
  RequestedDeliveryMode
} from "./types.js";
import {
  buildWorkerCompletionFallbackReport,
  buildWorkerCompletionReport,
  formatToolExecutionPayload,
  normalizeOptionalAgentId,
  nowIso,
  parseTimestampToMillis,
  previewForLog,
  toDisplayToolName,
  trimToMaxChars,
  trimToMaxCharsFromEnd
} from "./swarm-manager-utils.js";
import { extractMessageErrorMessage, extractMessageText, extractRole } from "./message-utils.js";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { isExternalThreadDescriptor } from "./external-thread-compatibility.js";

const IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE = `⚠️ [IDLE WORKER WATCHDOG — BATCHED]

\${WORKER_COUNT} \${WORKER_WORD} went idle without reporting this turn.
Workers: \${WORKER_IDS}

Use list_agents({"verbose":true,"limit":50,"offset":0}) for a paged full list.`;
const IDLE_WORKER_WATCHDOG_GRACE_MS = 3_000;
const WATCHDOG_BATCH_WINDOW_MS = 750;
const WATCHDOG_BATCH_PREVIEW_LIMIT = 10;
const WATCHDOG_BACKOFF_BASE_MS = 15_000;
const WATCHDOG_BACKOFF_MAX_MS = 5 * 60_000;
const WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS = 3;
const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_NUDGE_THRESHOLD_MS = 5 * 60_000;
const STALL_DETAILED_REPORT_INTERVAL_MS = 10 * 60_000;
const STALL_KILL_AFTER_NUDGE_MS = 25 * 60_000;
export const TRANSIENT_WORKER_TERMINATED_GRACE_MS = 60_000;

export interface WorkerWatchdogState {
  turnSeq: number;
  reportedThisTurn: boolean;
  pendingReportTurnSeq: number | null;
  deferredFinalizeTurnSeq: number | null;
  hadStreamingThisTurn: boolean;
  lastFinalizedTurnSeq: number | null;
  pendingTransientTerminatedTurnSeq: number | null;
  pendingTransientTerminatedStartedAtMs: number | null;
  pendingTransientTerminatedCount: number;
  consecutiveNotifications: number;
  suppressedUntilMs: number;
  circuitOpen: boolean;
}

interface PendingTransientWorkerTerminatedError {
  event: RuntimeSessionEvent;
  expire: (event: RuntimeSessionEvent) => void | Promise<void>;
  token: number;
}

export interface WatchdogBatchEntry {
  workerId: string;
  turnSeq: number;
}

export interface WorkerStallState {
  lastProgressAt: number;
  nudgeSent: boolean;
  nudgeSentAt: number | null;
  lastToolName: string | null;
  lastToolInput: string | null;
  lastToolOutput: string | null;
  lastDetailedReportAt: number | null;
}

export interface WorkerActivityState {
  currentToolName: string | null;
  currentToolStartedAt: number | null;
  lastProgressAt: number;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
}

export interface SwarmWorkerHealthServiceOptions {
  descriptors: Map<string, AgentDescriptor>;
  runtimes: Map<string, SwarmAgentRuntime>;
  now?: () => string;
  getConversationHistory(agentId?: string): ConversationEntryEvent[];
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: { origin?: "user" | "internal" }
  ): Promise<unknown>;
  publishToUser(
    agentId: string,
    text: string,
    source: "speak_to_user" | "system"
  ): Promise<unknown>;
  terminateDescriptor(
    descriptor: AgentDescriptor,
    options: { abort: boolean; emitStatus: boolean }
  ): Promise<void>;
  saveStore(): Promise<void>;
  emitAgentsSnapshot(): void;
  resolvePromptWithFallback(
    category: PromptCategory,
    promptId: string,
    profileId: string,
    fallback: string
  ): Promise<string>;
  isRuntimeInContextRecovery(agentId: string): boolean;
  isRuntimeRecoveryActive?(agentId: string): boolean;
  logDebug(message: string, details?: unknown): void;
}

export class SwarmWorkerHealthService {
  readonly workerWatchdogState = new Map<string, WorkerWatchdogState>();
  readonly workerStallState = new Map<string, WorkerStallState>();
  readonly workerActivityState = new Map<string, WorkerActivityState>();
  readonly watchdogTimers = new Map<string, NodeJS.Timeout>();
  readonly watchdogTimerTokens = new Map<string, number>();
  readonly watchdogBatchQueueByManager = new Map<string, Map<string, WatchdogBatchEntry>>();
  readonly watchdogBatchTimersByManager = new Map<string, NodeJS.Timeout>();
  private readonly pendingTransientWorkerTerminatedErrors = new Map<string, PendingTransientWorkerTerminatedError>();
  private readonly transientWorkerTerminatedTimers = new Map<string, NodeJS.Timeout>();
  private readonly transientWorkerTerminatedTimerTokens = new Map<string, number>();

  private stallCheckInterval: NodeJS.Timeout | null = null;
  private stallCheckPromise: Promise<void> | null = null;
  private readonly lastWorkerCompletionReportTimestampByAgentId = new Map<string, number>();
  private readonly lastWorkerCompletionReportSummaryKeyByAgentId = new Map<string, string>();
  private readonly now: () => string;

  constructor(private readonly options: SwarmWorkerHealthServiceOptions) {
    this.now = options.now ?? nowIso;
  }

  ensureStarted(): void {
    if (this.stallCheckInterval) {
      return;
    }

    this.stallCheckInterval = setInterval(() => {
      void this.checkForStalledWorkers().catch((error) => {
        this.options.logDebug("stall:check:error", {
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, STALL_CHECK_INTERVAL_MS);
    this.stallCheckInterval.unref();
  }

  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined {
    const state = this.workerActivityState.get(agentId);
    if (!state) {
      return undefined;
    }

    const now = Date.now();
    const currentToolElapsedSec = state.currentToolStartedAt !== null
      ? Math.round((now - state.currentToolStartedAt) / 1000)
      : 0;
    const idleSec = state.currentToolName !== null
      ? 0
      : Math.round((now - state.lastProgressAt) / 1000);

    return {
      currentTool: state.currentToolName,
      currentToolElapsedSec,
      toolCalls: state.toolCallCount,
      errors: state.errorCount,
      turns: state.turnCount,
      idleSec
    };
  }

  getWorkerReportDispatchTurnSeq(sender: AgentDescriptor, target: AgentDescriptor): number | undefined {
    const isWorkerReportToManager =
      sender.role === "worker" && target.role === "manager" && sender.managerId === target.agentId;
    const currentSenderAtDispatch = this.options.descriptors.get(sender.agentId);

    return isWorkerReportToManager &&
      currentSenderAtDispatch?.role === "worker" &&
      !isNonRunningAgentStatus(currentSenderAtDispatch.status)
      ? this.getOrCreateWorkerWatchdogState(sender.agentId).turnSeq
      : undefined;
  }

  markPendingWorkerReportDispatch(agentId: string, turnSeq: number | undefined): void {
    if (turnSeq === undefined) {
      return;
    }

    const senderDescriptorAfterPrep = this.options.descriptors.get(agentId);
    const shouldTrackWorkerReportAfterPrep =
      senderDescriptorAfterPrep?.role === "worker" &&
      !isNonRunningAgentStatus(senderDescriptorAfterPrep.status);
    const watchdogState = shouldTrackWorkerReportAfterPrep
      ? this.workerWatchdogState.get(agentId)
      : undefined;

    if (watchdogState && watchdogState.turnSeq === turnSeq) {
      watchdogState.pendingReportTurnSeq = turnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);
    }
  }

  async handleFailedWorkerReportDispatch(agentId: string, turnSeq: number | undefined): Promise<void> {
    if (turnSeq === undefined) {
      return;
    }

    const currentSender = this.options.descriptors.get(agentId);
    const watchdogState =
      currentSender &&
      currentSender.role === "worker" &&
      !isNonRunningAgentStatus(currentSender.status)
        ? this.workerWatchdogState.get(agentId)
        : undefined;

    if (watchdogState?.pendingReportTurnSeq === turnSeq) {
      watchdogState.pendingReportTurnSeq = null;
      this.workerWatchdogState.set(agentId, watchdogState);
      await this.finalizeDeferredWorkerIdleTurn(agentId, turnSeq);
    }
  }

  async handleSuccessfulWorkerReportDispatch(agentId: string, turnSeq: number | undefined): Promise<void> {
    if (turnSeq === undefined) {
      return;
    }

    const currentSender = this.options.descriptors.get(agentId);
    const watchdogState =
      currentSender &&
      currentSender.role === "worker" &&
      !isNonRunningAgentStatus(currentSender.status)
        ? this.workerWatchdogState.get(agentId)
        : undefined;

    if (watchdogState?.pendingReportTurnSeq === turnSeq) {
      watchdogState.pendingReportTurnSeq = null;
    }
    if (watchdogState && watchdogState.turnSeq === turnSeq) {
      watchdogState.reportedThisTurn = true;
      watchdogState.consecutiveNotifications = 0;
      watchdogState.suppressedUntilMs = 0;
      watchdogState.circuitOpen = false;
    }
    if (watchdogState) {
      this.workerWatchdogState.set(agentId, watchdogState);
      this.cancelPendingTransientWorkerTerminatedError(agentId, "worker_reported");
      await this.finalizeDeferredWorkerIdleTurn(agentId, turnSeq);
    }
  }

  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    if (this.hasWorkerReportedForWatchdogTurn(descriptor, watchdogState.turnSeq)) {
      this.options.logDebug("worker:transient_terminated:ignore_reported_turn", {
        agentId,
        turnSeq: watchdogState.turnSeq,
        errorMessage: extractRuntimeEventMessageError(event)
      });
      return true;
    }
    const existing = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    const token = (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1;
    this.transientWorkerTerminatedTimerTokens.set(agentId, token);

    watchdogState.pendingTransientTerminatedTurnSeq = existing
      ? (watchdogState.pendingTransientTerminatedTurnSeq ?? watchdogState.turnSeq)
      : watchdogState.turnSeq;
    watchdogState.pendingTransientTerminatedStartedAtMs ??= Date.now();
    watchdogState.pendingTransientTerminatedCount = (watchdogState.pendingTransientTerminatedCount ?? 0) + 1;
    this.workerWatchdogState.set(agentId, watchdogState);

    this.pendingTransientWorkerTerminatedErrors.set(agentId, { event, expire, token });
    this.clearTransientWorkerTerminatedTimer(agentId);
    const timer = setTimeout(() => {
      this.expirePendingTransientWorkerTerminatedError(agentId, token).catch((error) => {
        this.options.logDebug("worker:transient_terminated:expire_error", {
          agentId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, TRANSIENT_WORKER_TERMINATED_GRACE_MS);
    timer.unref();
    this.transientWorkerTerminatedTimers.set(agentId, timer);

    this.options.logDebug("worker:transient_terminated:pending", {
      agentId,
      turnSeq: watchdogState.pendingTransientTerminatedTurnSeq,
      count: watchdogState.pendingTransientTerminatedCount,
      errorMessage: extractRuntimeEventMessageError(event)
    });
    return true;
  }

  cancelPendingTransientWorkerTerminatedError(
    agentId: string,
    reason: "runtime_progress" | "worker_reported" | "clear_state"
  ): void {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    const watchdogState = this.workerWatchdogState.get(agentId);
    const stateHasPending =
      watchdogState?.pendingTransientTerminatedTurnSeq !== null &&
      watchdogState?.pendingTransientTerminatedTurnSeq !== undefined;
    if (!pending && !stateHasPending) {
      return;
    }

    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.clearTransientWorkerTerminatedTimer(agentId);
    this.transientWorkerTerminatedTimerTokens.set(agentId, (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1);

    if (watchdogState) {
      watchdogState.pendingTransientTerminatedTurnSeq = null;
      watchdogState.pendingTransientTerminatedStartedAtMs = null;
      watchdogState.pendingTransientTerminatedCount = 0;
      this.workerWatchdogState.set(agentId, watchdogState);
    }

    this.options.logDebug("worker:transient_terminated:cancel", { agentId, reason });
  }

  hasPendingTransientWorkerTerminatedError(agentId: string): boolean {
    const watchdogState = this.workerWatchdogState.get(agentId);
    return (
      this.pendingTransientWorkerTerminatedErrors.has(agentId) ||
      (
        watchdogState?.pendingTransientTerminatedTurnSeq !== null &&
        watchdogState?.pendingTransientTerminatedTurnSeq !== undefined
      )
    );
  }

  private hasWorkerReportedForWatchdogTurn(descriptor: AgentDescriptor, turnSeq: number): boolean {
    const watchdogState = this.workerWatchdogState.get(descriptor.agentId);
    return watchdogState?.turnSeq === turnSeq && watchdogState.reportedThisTurn;
  }

  handleRuntimeSessionEvent(agentId: string, event: RuntimeSessionEvent): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (descriptor && isExternalThreadDescriptor(descriptor)) {
      return;
    }

    this.trackWorkerStallProgressEvent(agentId, event);
    this.updateWorkerActivity(agentId, event);
  }

  async handleRuntimeStatus(
    agentId: string,
    descriptor: AgentDescriptor & { role: "worker" },
    nextStatus: AgentStatus,
    pendingCount: number
  ): Promise<void> {
    if (isExternalThreadDescriptor(descriptor)) {
      return;
    }

    const effectiveStatus = descriptor.status;
    if (effectiveStatus === "streaming" && !this.workerStallState.has(agentId)) {
      this.workerStallState.set(agentId, {
        lastProgressAt: Date.now(),
        nudgeSent: false,
        nudgeSentAt: null,
        lastToolName: null,
        lastToolInput: null,
        lastToolOutput: null,
        lastDetailedReportAt: null
      });
    } else if (effectiveStatus !== "streaming" && this.workerStallState.has(agentId)) {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
    }

    if (nextStatus === "streaming") {
      const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
      watchdogState.hadStreamingThisTurn = true;
      this.workerWatchdogState.set(agentId, watchdogState);
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      this.removeWorkerFromWatchdogBatchQueues(agentId);
    } else if (nextStatus === "idle" && pendingCount === 0) {
      const watchdogState = this.workerWatchdogState.get(agentId);
      if (watchdogState?.hadStreamingThisTurn && !this.isRuntimeRecoveryActive(agentId)) {
        await this.finalizeWorkerIdleTurn(agentId, descriptor, "status_idle");
      }
    }
  }

  async handleRuntimeAgentEnd(
    agentId: string,
    descriptor: AgentDescriptor & { role: "worker" }
  ): Promise<void> {
    if (isExternalThreadDescriptor(descriptor)) {
      return;
    }

    if (this.isRuntimeRecoveryActive(agentId)) {
      const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
      watchdogState.turnSeq += 1;
      watchdogState.reportedThisTurn = false;
      watchdogState.pendingReportTurnSeq = null;
      watchdogState.deferredFinalizeTurnSeq = null;
      watchdogState.hadStreamingThisTurn = false;
      watchdogState.lastFinalizedTurnSeq = watchdogState.turnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);

      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "agent_end");
  }

  reconcileRuntimeStateAfterFallbackRollback(
    agentId: string,
    restoredStatus: AgentStatus,
    options?: { receivedAgentEnd?: boolean }
  ): void {
    if (restoredStatus === "streaming") {
      if (!this.workerStallState.has(agentId)) {
        this.workerStallState.set(agentId, {
          lastProgressAt: Date.now(),
          nudgeSent: false,
          nudgeSentAt: null,
          lastToolName: null,
          lastToolInput: null,
          lastToolOutput: null,
          lastDetailedReportAt: null
        });
      }
    } else {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
    }

    if (!options?.receivedAgentEnd) {
      return;
    }

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    watchdogState.turnSeq += 1;
    watchdogState.reportedThisTurn = false;
    watchdogState.pendingReportTurnSeq = null;
    watchdogState.deferredFinalizeTurnSeq = null;
    watchdogState.hadStreamingThisTurn = false;
    watchdogState.lastFinalizedTurnSeq = watchdogState.turnSeq;
    this.workerWatchdogState.set(agentId, watchdogState);

    this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
    this.clearWatchdogTimer(agentId);
  }

  async checkForStalledWorkers(): Promise<void> {
    if (this.stallCheckPromise) {
      return this.stallCheckPromise;
    }

    const run = this.runStalledWorkerCheck().finally(() => {
      if (this.stallCheckPromise === run) {
        this.stallCheckPromise = null;
      }
    });

    this.stallCheckPromise = run;
    return run;
  }

  async handleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallNudge(agentId, elapsedMs);
  }

  async handleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallDetailedReport(agentId, elapsedMs);
  }

  async handleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    await this.runHandleStallAutoKill(agentId, elapsedMs);
  }

  seedWorkerCompletionReportTimestamp(agentId: string): void {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker" || isExternalThreadDescriptor(descriptor)) {
      return;
    }

    this.lastWorkerCompletionReportTimestampByAgentId.set(agentId, parseTimestampToMillis(this.now()) ?? Date.now());
    this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(agentId);
  }

  deleteWorkerStallState(agentId: string): void {
    this.workerStallState.delete(agentId);
  }

  deleteWorkerActivityState(agentId: string): void {
    this.workerActivityState.delete(agentId);
  }

  deleteWorkerCompletionReportState(agentId: string): void {
    this.lastWorkerCompletionReportTimestampByAgentId.delete(agentId);
    this.lastWorkerCompletionReportSummaryKeyByAgentId.delete(agentId);
  }

  getOrCreateWorkerWatchdogState(agentId: string): WorkerWatchdogState {
    const existing = this.workerWatchdogState.get(agentId);
    if (existing) {
      return existing;
    }

    const initialized: WorkerWatchdogState = {
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: false,
      lastFinalizedTurnSeq: null,
      consecutiveNotifications: 0,
      suppressedUntilMs: 0,
      pendingTransientTerminatedTurnSeq: null,
      pendingTransientTerminatedStartedAtMs: null,
      pendingTransientTerminatedCount: 0,
      circuitOpen: false
    };
    this.workerWatchdogState.set(agentId, initialized);
    return initialized;
  }

  clearWatchdogTimer(agentId: string): void {
    const timer = this.watchdogTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.watchdogTimers.delete(agentId);
    }
  }

  private clearTransientWorkerTerminatedTimer(agentId: string): void {
    const timer = this.transientWorkerTerminatedTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.transientWorkerTerminatedTimers.delete(agentId);
    }
  }

  clearWatchdogState(agentId: string): void {
    this.clearWatchdogTimer(agentId);
    this.cancelPendingTransientWorkerTerminatedError(agentId, "clear_state");

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (watchdogState) {
      watchdogState.pendingReportTurnSeq = null;
      watchdogState.deferredFinalizeTurnSeq = null;
      watchdogState.reportedThisTurn = false;
      watchdogState.hadStreamingThisTurn = false;
      watchdogState.lastFinalizedTurnSeq = null;
      watchdogState.pendingTransientTerminatedTurnSeq = null;
      watchdogState.pendingTransientTerminatedStartedAtMs = null;
      watchdogState.pendingTransientTerminatedCount = 0;
    }

    this.workerWatchdogState.delete(agentId);
    this.watchdogTimerTokens.delete(agentId);
    this.transientWorkerTerminatedTimerTokens.delete(agentId);
    this.removeWorkerFromWatchdogBatchQueues(agentId);
  }

  removeWorkerFromWatchdogBatchQueues(agentId: string): void {
    for (const [managerId, queue] of this.watchdogBatchQueueByManager.entries()) {
      if (!queue.delete(agentId)) {
        continue;
      }

      if (queue.size > 0) {
        continue;
      }

      this.watchdogBatchQueueByManager.delete(managerId);

      const batchTimer = this.watchdogBatchTimersByManager.get(managerId);
      if (batchTimer) {
        clearTimeout(batchTimer);
        this.watchdogBatchTimersByManager.delete(managerId);
      }
    }
  }

  async finalizeWorkerIdleTurn(
    agentId: string,
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<void> {
    if (descriptor.role !== "worker") {
      return;
    }

    const watchdogState = this.getOrCreateWorkerWatchdogState(agentId);
    const currentTurnSeq = watchdogState.turnSeq;
    if (watchdogState.lastFinalizedTurnSeq === currentTurnSeq && !watchdogState.hadStreamingThisTurn) {
      this.options.logDebug("watchdog:finalize_skip_duplicate", {
        agentId,
        turnSeq: currentTurnSeq,
        source
      });
      return;
    }

    const reportedThisTurn = watchdogState.reportedThisTurn;
    const hasPendingReport = watchdogState.pendingReportTurnSeq === currentTurnSeq;
    const hasPendingTransientTerminatedError = watchdogState.pendingTransientTerminatedTurnSeq === currentTurnSeq;

    if (hasPendingReport || hasPendingTransientTerminatedError) {
      watchdogState.deferredFinalizeTurnSeq = currentTurnSeq;
      this.workerWatchdogState.set(agentId, watchdogState);
      return;
    }

    watchdogState.turnSeq += 1;
    watchdogState.reportedThisTurn = false;
    watchdogState.pendingReportTurnSeq = null;
    watchdogState.deferredFinalizeTurnSeq = null;
    watchdogState.hadStreamingThisTurn = false;
    const turnSeq = watchdogState.turnSeq;
    watchdogState.lastFinalizedTurnSeq = turnSeq;
    this.workerWatchdogState.set(agentId, watchdogState);

    if (reportedThisTurn) {
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const autoReportOutcome = await this.tryAutoReportWorkerCompletion(descriptor, source);
    if (autoReportOutcome === "sent") {
      this.watchdogTimerTokens.set(agentId, (this.watchdogTimerTokens.get(agentId) ?? 0) + 1);
      this.clearWatchdogTimer(agentId);
      return;
    }

    const nextToken = (this.watchdogTimerTokens.get(agentId) ?? 0) + 1;
    this.watchdogTimerTokens.set(agentId, nextToken);
    this.clearWatchdogTimer(agentId);

    const timer = setTimeout(() => {
      this.handleIdleWorkerWatchdogTimer(agentId, turnSeq, nextToken).catch((error) => {
        this.options.logDebug("watchdog:error", { agentId, error: String(error) });
      });
    }, IDLE_WORKER_WATCHDOG_GRACE_MS);

    this.watchdogTimers.set(agentId, timer);
  }

  private async finalizeDeferredWorkerIdleTurn(agentId: string, turnSeq: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return;
    }

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (
      !watchdogState ||
      watchdogState.turnSeq !== turnSeq ||
      watchdogState.pendingReportTurnSeq !== null ||
      watchdogState.pendingTransientTerminatedTurnSeq !== null ||
      watchdogState.deferredFinalizeTurnSeq !== turnSeq
    ) {
      return;
    }

    await this.finalizeWorkerIdleTurn(agentId, descriptor, "deferred");
  }

  private async expirePendingTransientWorkerTerminatedError(agentId: string, token: number): Promise<void> {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    if (!pending || pending.token !== token || this.transientWorkerTerminatedTimerTokens.get(agentId) !== token) {
      return;
    }

    const watchdogState = this.workerWatchdogState.get(agentId);
    const turnSeq = watchdogState?.pendingTransientTerminatedTurnSeq ?? null;
    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.transientWorkerTerminatedTimers.delete(agentId);
    if (watchdogState) {
      watchdogState.pendingTransientTerminatedTurnSeq = null;
      watchdogState.pendingTransientTerminatedStartedAtMs = null;
      watchdogState.pendingTransientTerminatedCount = 0;
      this.workerWatchdogState.set(agentId, watchdogState);
    }

    this.options.logDebug("worker:transient_terminated:expired", { agentId, turnSeq });
    await pending.expire(pending.event);

    if (turnSeq !== null) {
      await this.finalizeDeferredWorkerIdleTurn(agentId, turnSeq);
    }
  }

  private trackWorkerStallProgressEvent(agentId: string, event: RuntimeSessionEvent): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start": {
        stallState.lastToolName = event.toolName;
        stallState.lastToolInput = trimToMaxChars(formatToolExecutionPayload(event.args), 500);
        stallState.lastToolOutput = null;
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_update": {
        stallState.lastToolName = event.toolName;
        const chunk = formatToolExecutionPayload(event.partialResult);
        const mergedOutput = `${stallState.lastToolOutput ?? ""}${chunk}`;
        stallState.lastToolOutput = trimToMaxCharsFromEnd(mergedOutput, 500);
        this.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_end":
      case "turn_end":
        this.recordWorkerStallProgress(agentId);
        return;

      case "message_update":
      case "message_end": {
        const role = extractRole(event.message);
        if (role === "assistant" || role === "system") {
          this.recordWorkerStallProgress(agentId);
        }
        return;
      }

      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        this.recordWorkerStallProgress(agentId);
        break;

      default:
        break;
    }
  }

  private updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    if (!this.workerStallState.has(agentId)) {
      this.workerActivityState.delete(agentId);
      return;
    }

    let state = this.workerActivityState.get(agentId);
    if (!state) {
      state = {
        currentToolName: null,
        currentToolStartedAt: null,
        lastProgressAt: Date.now(),
        toolCallCount: 0,
        errorCount: 0,
        turnCount: 0
      };
      this.workerActivityState.set(agentId, state);
    }

    switch (event.type) {
      case "tool_execution_start":
        state.currentToolName = event.toolName;
        state.currentToolStartedAt = Date.now();
        state.toolCallCount++;
        state.lastProgressAt = Date.now();
        break;

      case "tool_execution_end":
        state.currentToolName = null;
        state.currentToolStartedAt = null;
        if (event.isError) {
          state.errorCount++;
        }
        state.lastProgressAt = Date.now();
        break;

      case "turn_end":
        state.turnCount++;
        state.lastProgressAt = Date.now();
        break;

      case "message_update":
      case "message_end":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        state.lastProgressAt = Date.now();
        break;

      default:
        break;
    }
  }

  private recordWorkerStallProgress(agentId: string): void {
    const stallState = this.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    stallState.lastProgressAt = Date.now();
    stallState.lastDetailedReportAt = null;
    stallState.lastToolName = null;
    stallState.lastToolInput = null;
    stallState.lastToolOutput = null;

    if (stallState.nudgeSent) {
      stallState.nudgeSent = false;
      stallState.nudgeSentAt = null;
    }

    this.workerStallState.set(agentId, stallState);
  }

  private isRuntimeRecoveryActive(agentId: string): boolean {
    return this.options.isRuntimeRecoveryActive?.(agentId) ?? this.options.isRuntimeInContextRecovery(agentId);
  }

  private isWorkerStallRecoveryActive(agentId: string, descriptor?: AgentDescriptor): boolean {
    if (this.isRuntimeRecoveryActive(agentId)) {
      return true;
    }

    const resolvedDescriptor = descriptor ?? this.options.descriptors.get(agentId);
    const managerId = normalizeOptionalAgentId(resolvedDescriptor?.managerId);
    if (!managerId || managerId === agentId) {
      return false;
    }

    return this.isRuntimeRecoveryActive(managerId);
  }

  private resetWorkerStallProgressDuringRecovery(agentId: string): void {
    if (!this.workerStallState.has(agentId)) {
      return;
    }

    this.recordWorkerStallProgress(agentId);
  }

  private async runStalledWorkerCheck(): Promise<void> {
    const now = Date.now();

    for (const [agentId, descriptor] of this.options.descriptors.entries()) {
      if (descriptor.role !== "worker" || descriptor.status !== "streaming" || isExternalThreadDescriptor(descriptor)) {
        continue;
      }

      const stallState = this.workerStallState.get(agentId);
      if (!stallState) {
        continue;
      }

      if (this.isWorkerStallRecoveryActive(agentId, descriptor)) {
        this.resetWorkerStallProgressDuringRecovery(agentId);
        continue;
      }

      const elapsedSinceProgressMs = now - stallState.lastProgressAt;
      if (stallState.nudgeSent && stallState.nudgeSentAt !== null) {
        const elapsedSinceNudgeMs = now - stallState.nudgeSentAt;
        if (elapsedSinceNudgeMs >= STALL_KILL_AFTER_NUDGE_MS) {
          await this.runHandleStallAutoKill(agentId, elapsedSinceProgressMs);
          continue;
        }

        const detailedReportDue =
          elapsedSinceProgressMs >= STALL_DETAILED_REPORT_INTERVAL_MS &&
          (
            stallState.lastDetailedReportAt === null ||
            now - stallState.lastDetailedReportAt >= STALL_DETAILED_REPORT_INTERVAL_MS
          );

        if (detailedReportDue) {
          await this.runHandleStallDetailedReport(agentId, elapsedSinceProgressMs);
          continue;
        }
      }

      if (!stallState.nudgeSent && elapsedSinceProgressMs >= STALL_NUDGE_THRESHOLD_MS) {
        await this.runHandleStallNudge(agentId, elapsedSinceProgressMs);
      }
    }
  }

  private async runHandleStallNudge(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const managerMessage = `SYSTEM: ⚠️ [WORKER STALL DETECTED]\nWorker \`${agentId}\` has made no progress for ${elapsedText}.\nIt may be stuck in a long-running tool call or hung process.\nConsider: send_message_to_agent to check on it, or kill_agent(\"${agentId}\") to terminate.`;

    try {
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.nudgeSent = true;
      stallState.nudgeSentAt = Date.now();
      stallState.lastDetailedReportAt = null;
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.options.logDebug("stall:nudge:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.options.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:nudge:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runHandleStallDetailedReport(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      return;
    }

    const stallState = this.workerStallState.get(agentId);
    if (!stallState || !stallState.nudgeSent) {
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const elapsedText = this.formatDuration(elapsedMs);
    const toolInfo = stallState.lastToolName
      ? `Tool: ${toDisplayToolName(stallState.lastToolName)}`
      : "Tool: unknown (no tool execution events received)";
    const inputPreview = stallState.lastToolInput
      ? `Input (truncated): ${trimToMaxChars(stallState.lastToolInput, 200)}`
      : "Input: not available";
    const outputPreview = stallState.lastToolOutput
      ? `Last output (truncated): ${trimToMaxCharsFromEnd(stallState.lastToolOutput, 200)}`
      : "Output: none received";

    const managerMessage =
      `SYSTEM: ⚠️ [WORKER STALL REPORT]\n` +
      `Worker \`${agentId}\` has made no progress for ${elapsedText}.\n\n` +
      `${toolInfo}\n${inputPreview}\n${outputPreview}\n\n` +
      `If this looks like a hung process, terminate with: kill_agent(\"${agentId}\")\n` +
      "If it's a legitimate long-running operation, no action needed — auto-termination will occur at 30 minutes total.";

    try {
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
      stallState.lastDetailedReportAt = Date.now();
      this.workerStallState.set(agentId, stallState);
    } catch (error) {
      this.options.logDebug("stall:detailed_report:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.options.publishToUser(
        managerId,
        `⚠️ Worker \`${agentId}\` still appears stalled — no progress for ${elapsedText}.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:detailed_report:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async runHandleStallAutoKill(agentId: string, elapsedMs: number): Promise<void> {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.workerStallState.delete(agentId);
      this.workerActivityState.delete(agentId);
      return;
    }

    if (descriptor.status !== "streaming" || this.isWorkerStallRecoveryActive(agentId, descriptor)) {
      if (descriptor.status !== "streaming") {
        this.workerStallState.delete(agentId);
        this.workerActivityState.delete(agentId);
      }
      return;
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    const elapsedText = this.formatDuration(elapsedMs);

    try {
      await this.options.terminateDescriptor(descriptor, { abort: true, emitStatus: true });
      await this.options.saveStore();
      this.options.emitAgentsSnapshot();
    } catch (error) {
      this.options.logDebug("stall:auto_kill:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });

      if (managerId) {
        try {
          await this.options.publishToUser(
            managerId,
            `⚠️ Failed to auto-terminate stalled worker \`${agentId}\` — manual intervention needed.`,
            "system"
          );
        } catch (publishError) {
          this.options.logDebug("stall:auto_kill:publish_to_user:error", {
            agentId,
            managerId,
            message: publishError instanceof Error ? publishError.message : String(publishError)
          });
        }
      }
      return;
    }

    if (!managerId) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const managerMessage = `SYSTEM: 🛑 [STALLED WORKER AUTO-TERMINATED]\nWorker \`${agentId}\` was automatically terminated after ${elapsedText} with no progress.\nThe worker was stuck in a tool execution that never completed.\nYou may need to spawn a replacement worker or handle the incomplete task.`;

    try {
      await this.options.sendMessage(managerId, managerId, managerMessage, "auto", { origin: "internal" });
    } catch (error) {
      this.options.logDebug("stall:auto_kill:send_message:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    try {
      await this.options.publishToUser(
        managerId,
        `🛑 Worker \`${agentId}\` auto-terminated after ${elapsedText} stall.`,
        "system"
      );
    } catch (error) {
      this.options.logDebug("stall:auto_kill:publish_to_user:error", {
        agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
  }

  private async tryAutoReportWorkerCompletion(
    descriptor: AgentDescriptor,
    source: "agent_end" | "status_idle" | "deferred"
  ): Promise<"sent" | "skipped" | "failed"> {
    if (descriptor.role !== "worker") {
      return "skipped";
    }

    const managerId = normalizeOptionalAgentId(descriptor.managerId);
    if (!managerId) {
      return "skipped";
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    const managerRuntime = this.options.runtimes.get(managerId);
    if (
      !managerDescriptor ||
      managerDescriptor.role !== "manager" ||
      isNonRunningAgentStatus(managerDescriptor.status) ||
      !managerRuntime
    ) {
      this.options.logDebug("worker:completion_report:skip_manager_unavailable", {
        workerAgentId: descriptor.agentId,
        managerId,
        managerStatus: managerDescriptor?.status,
        hasManagerRuntime: Boolean(managerRuntime)
      });
      return "skipped";
    }

    const workerRuntime = this.options.runtimes.get(descriptor.agentId);
    if (!workerRuntime) {
      this.options.logDebug("worker:completion_report:skip_worker_runtime_missing", {
        workerAgentId: descriptor.agentId,
        managerId
      });
      return "skipped";
    }

    if (source !== "agent_end" && (workerRuntime.getStatus() !== "idle" || workerRuntime.getPendingCount() > 0)) {
      this.options.logDebug("worker:completion_report:skip_worker_runtime_active", {
        workerAgentId: descriptor.agentId,
        managerId,
        source,
        workerStatus: workerRuntime.getStatus(),
        pendingCount: workerRuntime.getPendingCount()
      });
      return "skipped";
    }

    const report = buildWorkerCompletionReport(descriptor.agentId, this.options.getConversationHistory(descriptor.agentId));
    const lastReportedTimestamp = this.lastWorkerCompletionReportTimestampByAgentId.get(descriptor.agentId);
    const lastReportedSummaryKey = this.lastWorkerCompletionReportSummaryKeyByAgentId.get(descriptor.agentId);
    const hasFreshSummary =
      typeof report.summaryTimestamp === "number" &&
      (typeof lastReportedTimestamp !== "number" || report.summaryTimestamp > lastReportedTimestamp);
    const isDuplicateSummary = typeof report.summaryKey === "string" && report.summaryKey === lastReportedSummaryKey;

    if (isDuplicateSummary) {
      this.options.logDebug("worker:completion_report:suppress_duplicate_summary", {
        workerAgentId: descriptor.agentId,
        managerId,
        summaryTimestamp: report.summaryTimestamp,
        summaryKey: report.summaryKey
      });
    }

    const includeSummary = hasFreshSummary && !isDuplicateSummary;
    const message = includeSummary
      ? report.message
      : buildWorkerCompletionFallbackReport(descriptor.agentId);

    try {
      await this.options.sendMessage(managerId, managerId, message, "auto", {
        origin: "internal"
      });

      if ((includeSummary || isDuplicateSummary) && typeof report.summaryTimestamp === "number") {
        this.lastWorkerCompletionReportTimestampByAgentId.set(descriptor.agentId, report.summaryTimestamp);
        if (report.summaryKey) {
          this.lastWorkerCompletionReportSummaryKeyByAgentId.set(descriptor.agentId, report.summaryKey);
        }
      }

      this.options.logDebug("worker:completion_report:sent", {
        workerAgentId: descriptor.agentId,
        managerId,
        includedSummary: includeSummary,
        summaryTimestamp: includeSummary ? report.summaryTimestamp : undefined,
        textPreview: previewForLog(message)
      });

      return "sent";
    } catch (error) {
      this.options.logDebug("worker:completion_report:error", {
        workerAgentId: descriptor.agentId,
        managerId,
        message: error instanceof Error ? error.message : String(error)
      });
      return "failed";
    }
  }

  private async handleIdleWorkerWatchdogTimer(
    agentId: string,
    turnSeq: number,
    token: number
  ): Promise<void> {
    if (this.watchdogTimerTokens.get(agentId) !== token) {
      return;
    }

    this.watchdogTimers.delete(agentId);

    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      this.clearWatchdogState(agentId);
      return;
    }

    const watchdogState = this.workerWatchdogState.get(agentId);
    if (
      !watchdogState ||
      watchdogState.turnSeq !== turnSeq ||
      watchdogState.reportedThisTurn ||
      watchdogState.pendingTransientTerminatedTurnSeq === turnSeq
    ) {
      return;
    }

    if (watchdogState.circuitOpen) {
      return;
    }

    if (Date.now() < watchdogState.suppressedUntilMs) {
      return;
    }

    if (descriptor.status !== "idle") {
      return;
    }

    if (this.isRuntimeRecoveryActive(descriptor.agentId)) {
      return;
    }

    const parentDescriptor = this.options.descriptors.get(descriptor.managerId);
    if (!parentDescriptor || isNonRunningAgentStatus(parentDescriptor.status)) {
      return;
    }

    this.enqueueWatchdogForBatch(descriptor.managerId, descriptor.agentId, turnSeq);
  }

  private enqueueWatchdogForBatch(managerId: string, workerId: string, turnSeq: number): void {
    let queue = this.watchdogBatchQueueByManager.get(managerId);
    if (!queue) {
      queue = new Map<string, WatchdogBatchEntry>();
      this.watchdogBatchQueueByManager.set(managerId, queue);
    }
    queue.set(workerId, { workerId, turnSeq });

    if (this.watchdogBatchTimersByManager.has(managerId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.flushWatchdogBatch(managerId).catch((error) => {
        this.options.logDebug("watchdog:batch_flush:error", {
          managerId,
          message: error instanceof Error ? error.message : String(error)
        });
      });
    }, WATCHDOG_BATCH_WINDOW_MS);

    this.watchdogBatchTimersByManager.set(managerId, timer);
  }

  private async flushWatchdogBatch(managerId: string): Promise<void> {
    const batchTimer = this.watchdogBatchTimersByManager.get(managerId);
    if (batchTimer) {
      clearTimeout(batchTimer);
      this.watchdogBatchTimersByManager.delete(managerId);
    }

    const queuedWorkers = this.watchdogBatchQueueByManager.get(managerId);
    this.watchdogBatchQueueByManager.delete(managerId);

    if (!queuedWorkers || queuedWorkers.size === 0) {
      return;
    }

    const managerDescriptor = this.options.descriptors.get(managerId);
    if (!managerDescriptor || managerDescriptor.role !== "manager" || isNonRunningAgentStatus(managerDescriptor.status)) {
      return;
    }

    const nowMs = Date.now();
    const eligibleWorkerIds: string[] = [];

    for (const queuedWorker of queuedWorkers.values()) {
      const workerDescriptor = this.options.descriptors.get(queuedWorker.workerId);
      if (!workerDescriptor || workerDescriptor.role !== "worker" || workerDescriptor.managerId !== managerId) {
        continue;
      }

      if (workerDescriptor.status !== "idle") {
        continue;
      }

      if (this.isRuntimeRecoveryActive(queuedWorker.workerId)) {
        continue;
      }

      const watchdogState = this.workerWatchdogState.get(queuedWorker.workerId);
      if (
        !watchdogState ||
        watchdogState.turnSeq !== queuedWorker.turnSeq ||
        watchdogState.reportedThisTurn ||
        watchdogState.pendingTransientTerminatedTurnSeq === queuedWorker.turnSeq ||
        watchdogState.circuitOpen
      ) {
        continue;
      }

      if (nowMs < watchdogState.suppressedUntilMs) {
        continue;
      }

      eligibleWorkerIds.push(queuedWorker.workerId);
    }

    if (eligibleWorkerIds.length === 0) {
      return;
    }

    const previewWorkerIds = eligibleWorkerIds.slice(0, WATCHDOG_BATCH_PREVIEW_LIMIT);
    const omittedCount = eligibleWorkerIds.length - previewWorkerIds.length;
    const workersPreview =
      previewWorkerIds.map((workerId) => `\`${workerId}\``).join(", ") +
      (omittedCount > 0 ? ` (+${omittedCount} more)` : "");

    const workerWord = eligibleWorkerIds.length === 1 ? "worker" : "workers";
    const profileId = managerDescriptor.profileId ?? managerId;
    const watchdogTemplate = await this.options.resolvePromptWithFallback(
      "operational",
      "idle-watchdog",
      profileId,
      IDLE_WORKER_WATCHDOG_MESSAGE_TEMPLATE
    );
    const watchdogMessage = resolvePromptVariables(watchdogTemplate, {
      WORKER_COUNT: String(eligibleWorkerIds.length),
      WORKER_WORD: workerWord,
      WORKER_IDS: workersPreview
    });

    let managerNotified = false;
    try {
      await this.options.sendMessage(managerId, managerId, watchdogMessage, "auto", { origin: "internal" });
      managerNotified = true;
    } catch (error) {
      this.options.logDebug("watchdog:notify:error", {
        managerId,
        workerCount: eligibleWorkerIds.length,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const userVisibleMessage = managerNotified
      ? `⚠️ Idle worker watchdog detected ${eligibleWorkerIds.length} ${workerWord} without a report this turn. Workers: ${workersPreview}.`
      : `⚠️ Idle worker watchdog detected ${eligibleWorkerIds.length} ${workerWord} without a report this turn. An automated manager notification was attempted.`;

    try {
      await this.options.publishToUser(managerId, userVisibleMessage, "system");
    } catch (error) {
      this.options.logDebug("watchdog:publish_to_user:error", {
        managerId,
        workerCount: eligibleWorkerIds.length,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    const suppressionAppliedAtMs = Date.now();

    for (const workerId of eligibleWorkerIds) {
      const watchdogState = this.workerWatchdogState.get(workerId);
      if (!watchdogState) {
        continue;
      }

      watchdogState.consecutiveNotifications += 1;

      if (watchdogState.consecutiveNotifications >= WATCHDOG_MAX_CONSECUTIVE_NOTIFICATIONS) {
        watchdogState.circuitOpen = true;
        watchdogState.suppressedUntilMs = Number.MAX_SAFE_INTEGER;
        this.options.logDebug("watchdog:circuit_open", {
          workerAgentId: workerId,
          managerId,
          consecutiveNotifications: watchdogState.consecutiveNotifications
        });
      } else {
        const backoffMs = Math.min(
          WATCHDOG_BACKOFF_BASE_MS * 2 ** (watchdogState.consecutiveNotifications - 1),
          WATCHDOG_BACKOFF_MAX_MS
        );
        watchdogState.suppressedUntilMs = suppressionAppliedAtMs + backoffMs;
      }

      this.workerWatchdogState.set(workerId, watchdogState);
    }
  }
}

function extractRuntimeEventMessageError(event: RuntimeSessionEvent): string | undefined {
  if (
    event.type !== "message_end" &&
    event.type !== "message_update" &&
    event.type !== "message_start"
  ) {
    return undefined;
  }

  return extractMessageErrorMessage(event.message) ?? extractMessageText(event.message);
}
