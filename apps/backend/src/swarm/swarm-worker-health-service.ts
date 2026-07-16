import type { RuntimeSessionEvent, SwarmAgentRuntime } from "./runtime-contracts.js";
import type {
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode
} from "./types.js";
import {
  formatToolExecutionPayload,
  normalizeOptionalAgentId,
  toDisplayToolName,
  trimToMaxChars,
  trimToMaxCharsFromEnd
} from "./swarm-manager-utils.js";
import { extractMessageErrorMessage, extractMessageText, extractRole } from "./message-utils.js";
import { isNonRunningAgentStatus } from "./agent-state-machine.js";
import { isExternalThreadDescriptor } from "./external-thread-compatibility.js";
import type { WorkerResultCoordinator } from "./worker-result-coordinator.js";

const STALL_CHECK_INTERVAL_MS = 60_000;
const STALL_NUDGE_THRESHOLD_MS = 5 * 60_000;
const STALL_DETAILED_REPORT_INTERVAL_MS = 10 * 60_000;
const STALL_KILL_AFTER_NUDGE_MS = 25 * 60_000;
export const TRANSIENT_WORKER_TERMINATED_GRACE_MS = 60_000;

interface PendingTransientWorkerTerminatedError {
  event: RuntimeSessionEvent;
  expire: (event: RuntimeSessionEvent) => void | Promise<void>;
  token: number;
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
  workerResults: WorkerResultCoordinator;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: { origin?: "user" | "internal"; skipTurnLedger?: boolean }
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
  isRuntimeInContextRecovery(agentId: string): boolean;
  isRuntimeRecoveryActive?(agentId: string): boolean;
  logDebug(message: string, details?: unknown): void;
  onHealthSweep?(): void | Promise<void>;
}

export class SwarmWorkerHealthService {
  readonly workerStallState = new Map<string, WorkerStallState>();
  readonly workerActivityState = new Map<string, WorkerActivityState>();
  private readonly pendingTransientWorkerTerminatedErrors = new Map<string, PendingTransientWorkerTerminatedError>();
  private readonly transientWorkerTerminatedTimers = new Map<string, NodeJS.Timeout>();
  private readonly transientWorkerTerminatedTimerTokens = new Map<string, number>();
  private readonly deferredWorkerResultAgentIds = new Set<string>();

  private stallCheckInterval: NodeJS.Timeout | null = null;
  private stallCheckPromise: Promise<void> | null = null;

  constructor(private readonly options: SwarmWorkerHealthServiceOptions) {}

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
      void this.options.onHealthSweep?.();
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

  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean {
    const descriptor = this.options.descriptors.get(agentId);
    if (!descriptor || descriptor.role !== "worker") {
      return false;
    }

    const token = (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1;
    this.transientWorkerTerminatedTimerTokens.set(agentId, token);

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
      errorMessage: extractRuntimeEventMessageError(event)
    });
    return true;
  }

  cancelPendingTransientWorkerTerminatedError(
    agentId: string,
    reason: "runtime_progress" | "clear_state"
  ): void {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    if (!pending) {
      return;
    }

    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.clearTransientWorkerTerminatedTimer(agentId);
    this.transientWorkerTerminatedTimerTokens.set(agentId, (this.transientWorkerTerminatedTimerTokens.get(agentId) ?? 0) + 1);

    this.deferredWorkerResultAgentIds.delete(agentId);

    this.options.logDebug("worker:transient_terminated:cancel", { agentId, reason });
  }

  hasPendingTransientWorkerTerminatedError(agentId: string): boolean {
    return this.pendingTransientWorkerTerminatedErrors.has(agentId);
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
    _nextStatus: AgentStatus,
    _pendingCount: number
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

  }

  async handleRuntimeAgentEnd(
    agentId: string,
    descriptor: AgentDescriptor
  ): Promise<void> {
    if (!isWorkerDescriptor(descriptor) || isExternalThreadDescriptor(descriptor)) {
      return;
    }

    if (this.isRuntimeRecoveryActive(agentId)) {
      return;
    }

    if (this.hasPendingTransientWorkerTerminatedError(agentId)) {
      this.deferredWorkerResultAgentIds.add(agentId);
      this.options.logDebug("worker_result:deferred_transient_error", { agentId });
      return;
    }

    await this.options.workerResults.deliverCompletedWorker(descriptor);
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

    void options;
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

  deleteWorkerStallState(agentId: string): void {
    this.workerStallState.delete(agentId);
  }

  deleteWorkerActivityState(agentId: string): void {
    this.workerActivityState.delete(agentId);
  }

  private clearTransientWorkerTerminatedTimer(agentId: string): void {
    const timer = this.transientWorkerTerminatedTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.transientWorkerTerminatedTimers.delete(agentId);
    }
  }

  clearWorkerHealthState(agentId: string): void {
    this.cancelPendingTransientWorkerTerminatedError(agentId, "clear_state");
    this.deferredWorkerResultAgentIds.delete(agentId);
    this.transientWorkerTerminatedTimerTokens.delete(agentId);
  }

  private async expirePendingTransientWorkerTerminatedError(agentId: string, token: number): Promise<void> {
    const pending = this.pendingTransientWorkerTerminatedErrors.get(agentId);
    if (!pending || pending.token !== token || this.transientWorkerTerminatedTimerTokens.get(agentId) !== token) {
      return;
    }

    this.pendingTransientWorkerTerminatedErrors.delete(agentId);
    this.transientWorkerTerminatedTimers.delete(agentId);

    this.options.logDebug("worker:transient_terminated:expired", { agentId });
    await pending.expire(pending.event);

    if (this.deferredWorkerResultAgentIds.delete(agentId)) {
      const descriptor = this.options.descriptors.get(agentId);
      if (
        descriptor &&
        isWorkerDescriptor(descriptor) &&
        !isExternalThreadDescriptor(descriptor) &&
        !this.isRuntimeRecoveryActive(agentId)
      ) {
        await this.options.workerResults.deliverCompletedWorker(descriptor);
      }
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

function isWorkerDescriptor(
  descriptor: AgentDescriptor
): descriptor is AgentDescriptor & { role: "worker" } {
  return descriptor.role === "worker";
}
