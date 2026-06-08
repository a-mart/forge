import type { RuntimeSessionEvent } from "./runtime-contracts.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
} from "./session/message-utils.js";
import type { AcceptedDeliveryMode, AgentDescriptor, ConversationMessageEvent, SendMessageReceipt } from "./types.js";
import { isActionableWorkerCallbackMessage } from "./worker-callback-message.js";
export { isActionableWorkerCallbackMessage } from "./worker-callback-message.js";

export const MANAGER_NOOP_DIAGNOSTIC_FINAL =
  "Manager returned no visible action after a worker update.";

export const MANAGER_NOOP_RECOVERY_NUDGE_PREFIX = "SYSTEM: [Forge manager recovery]";

const WORKER_AUTO_REPORT_PATTERN = /^SYSTEM:\s*Worker\s+.+\s+(completed its turn|ended its turn)/i;

// The no-op guard enforces that a callback turn produced some Forge action.
// Semantic user/peer closeout requirements stay in the manager prompt and task guidance.
const MANAGER_ACTION_TOOLS = new Set([
  "speak_to_user",
  "send_message_to_agent",
  "present_choices",
  "task",
  "spawn_agent",
  "kill_agent",
  "create_session",
  "create_project_agent",
]);

export type ManagerNoOpTurnTriggerKind = "worker_callback" | "recovery_nudge";

export interface ManagerNoOpTurnState {
  turnSeq: number;
  triggerKind: ManagerNoOpTurnTriggerKind;
  fromWorkerAgentId?: string;
  triggerPreview?: string;
  attemptedActionToolCalls: Map<string, string>;
  hadCompletedToolAction: boolean;
  hadVisibleOutput: boolean;
  guardFired: boolean;
  suppressed: boolean;
  suppressionReason?: string;
}

export interface PendingManagerNoOpTurn {
  pendingTurnId?: string;
  triggerKind: ManagerNoOpTurnTriggerKind;
  fromWorkerAgentId?: string;
  triggerPreview?: string;
  runtimeMessageText: string;
  deliveryId?: string;
  acceptedMode?: AcceptedDeliveryMode;
  requestedDelivery?: string;
}

export interface ManagerNoOpGuardDeps {
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  sendInternalManagerMessage: (managerId: string, message: string) => Promise<SendMessageReceipt | void>;
  isManualStopPending: (managerId: string) => boolean;
  isRuntimeRecoveryActive: (managerId: string) => boolean;
}

export function isWorkerWatchdogAutoReportMessage(message: string): boolean {
  return WORKER_AUTO_REPORT_PATTERN.test(message.trim());
}

export function shouldBeginManagerNoOpGuardForDelivery(acceptedMode: AcceptedDeliveryMode): boolean {
  return acceptedMode === "prompt";
}

export function shouldQueueManagerNoOpGuardForDelivery(acceptedMode: AcceptedDeliveryMode): boolean {
  return acceptedMode === "followUp";
}

export function isManagerNoOpRecoveryNudgeMessage(message: string): boolean {
  return message.trimStart().startsWith(MANAGER_NOOP_RECOVERY_NUDGE_PREFIX);
}

function normalizeManagerActionToolName(toolName: string): string {
  if (MANAGER_ACTION_TOOLS.has(toolName)) {
    return toolName;
  }

  if (toolName.startsWith("mcp:")) {
    const suffix = toolName.split(":").at(-1);
    return suffix && suffix.length > 0 ? suffix : toolName;
  }

  if (!toolName.startsWith("mcp__")) {
    return toolName;
  }

  const namespaceSeparatorIndex = toolName.lastIndexOf("__");
  if (namespaceSeparatorIndex <= "mcp__".length) {
    return toolName;
  }

  const suffix = toolName.slice(namespaceSeparatorIndex + 2);
  return suffix.length > 0 ? suffix : toolName;
}

export function isManagerActionToolName(toolName: string): boolean {
  return MANAGER_ACTION_TOOLS.has(normalizeManagerActionToolName(toolName));
}

export function isRuntimeAssistantMessageEndError(event: RuntimeSessionEvent): boolean {
  if (event.type !== "message_end") {
    return false;
  }

  const stopReason = extractMessageStopReason(event.message);
  if (stopReason === "error") {
    return true;
  }

  if (hasMessageErrorMessageField(event.message)) {
    return true;
  }

  return extractMessageErrorMessage(event.message) !== undefined;
}

export function shouldTrackInboundManagerTurn(options: {
  targetRole: AgentDescriptor["role"];
  senderRole?: AgentDescriptor["role"];
  origin: "user" | "internal";
  message: string;
  internalDeliveryKind?: string;
}): ManagerNoOpTurnTriggerKind | null {
  if (options.targetRole !== "manager") {
    return null;
  }

  if (options.internalDeliveryKind === "codex_plugin_bootstrap") {
    return null;
  }

  if (isManagerNoOpRecoveryNudgeMessage(options.message)) {
    return "recovery_nudge";
  }

  if (options.origin === "user") {
    return null;
  }

  if (options.senderRole === "worker" && isActionableWorkerCallbackMessage(options.message)) {
    return "worker_callback";
  }

  if (options.senderRole === "manager" && options.origin === "internal") {
    return null;
  }

  return null;
}

function normalizeRuntimeMessageTextForGuard(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function runtimeMessageTextMatches(expected: string, actual: string): boolean {
  return normalizeRuntimeMessageTextForGuard(expected) === normalizeRuntimeMessageTextForGuard(actual);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function turnLogDetails(managerId: string, state: ManagerNoOpTurnState, extras?: Record<string, unknown>): Record<string, unknown> {
  return {
    managerId,
    turnSeq: state.turnSeq,
    triggerKind: state.triggerKind,
    fromWorkerAgentId: state.fromWorkerAgentId,
    hadCompletedToolAction: state.hadCompletedToolAction,
    hadVisibleOutput: state.hadVisibleOutput,
    guardFired: state.guardFired,
    suppressed: state.suppressed,
    suppressionReason: state.suppressionReason,
    ...extras,
  };
}

function pendingTurnLogDetails(
  managerId: string,
  pendingTurn: PendingManagerNoOpTurn,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    managerId,
    pendingTurnId: pendingTurn.pendingTurnId,
    triggerKind: pendingTurn.triggerKind,
    fromWorkerAgentId: pendingTurn.fromWorkerAgentId,
    deliveryId: pendingTurn.deliveryId,
    requestedDelivery: pendingTurn.requestedDelivery,
    acceptedMode: pendingTurn.acceptedMode,
    runtimeMessageTextLength: pendingTurn.runtimeMessageText.length,
    triggerPreviewLength: pendingTurn.triggerPreview?.length,
    ...extras,
  };
}

export class ManagerNoOpGuard {
  private readonly turnStateByManagerId = new Map<string, ManagerNoOpTurnState>();
  private readonly pendingTurnsByManagerId = new Map<string, PendingManagerNoOpTurn[]>();

  constructor(private readonly deps: ManagerNoOpGuardDeps) {}

  getTurnState(managerId: string): ManagerNoOpTurnState | undefined {
    return this.turnStateByManagerId.get(managerId);
  }

  clearManager(managerId: string): void {
    this.turnStateByManagerId.delete(managerId);
    this.pendingTurnsByManagerId.delete(managerId);
  }

  beginTurn(
    managerId: string,
    triggerKind: ManagerNoOpTurnTriggerKind,
    details?: { fromWorkerAgentId?: string; triggerPreview?: string },
  ): void {
    const previous = this.turnStateByManagerId.get(managerId);
    const turnSeq = (previous?.turnSeq ?? 0) + 1;

    const state: ManagerNoOpTurnState = {
      turnSeq,
      triggerKind,
      fromWorkerAgentId: details?.fromWorkerAgentId,
      triggerPreview: details?.triggerPreview?.slice(0, 240),
      attemptedActionToolCalls: new Map(),
      hadCompletedToolAction: false,
      hadVisibleOutput: false,
      guardFired: false,
      suppressed: false,
    };
    this.turnStateByManagerId.set(managerId, state);
    this.deps.logDebug("manager:noop_guard:turn_begin", turnLogDetails(managerId, state, {
      triggerPreviewLength: state.triggerPreview?.length,
    }));
  }

  queuePendingTurn(managerId: string, pendingTurn: PendingManagerNoOpTurn): void {
    const runtimeMessageText = normalizeRuntimeMessageTextForGuard(pendingTurn.runtimeMessageText);
    if (!runtimeMessageText && !pendingTurn.deliveryId) {
      return;
    }

    const queue = this.pendingTurnsByManagerId.get(managerId) ?? [];
    const normalizedPendingTurn: PendingManagerNoOpTurn = {
      ...pendingTurn,
      runtimeMessageText,
      triggerPreview: pendingTurn.triggerPreview?.slice(0, 240),
    };
    queue.push(normalizedPendingTurn);
    this.pendingTurnsByManagerId.set(managerId, queue);
    this.deps.logDebug("manager:noop_guard:pending_turn_queued", pendingTurnLogDetails(managerId, normalizedPendingTurn, {
      queueLength: queue.length,
    }));
  }

  updatePendingTurn(
    managerId: string,
    pendingTurnId: string,
    updates: Partial<Pick<PendingManagerNoOpTurn, "deliveryId" | "acceptedMode" | "requestedDelivery">>,
  ): boolean {
    const queue = this.pendingTurnsByManagerId.get(managerId);
    if (!queue || queue.length === 0) {
      this.deps.logDebug("manager:noop_guard:pending_turn_update_missed", {
        managerId,
        pendingTurnId,
        reason: "empty_queue",
        ...updates,
      });
      return false;
    }

    const pendingIndex = queue.findIndex((pendingTurn) => pendingTurn.pendingTurnId === pendingTurnId);
    if (pendingIndex < 0) {
      this.deps.logDebug("manager:noop_guard:pending_turn_update_missed", {
        managerId,
        pendingTurnId,
        reason: "not_found",
        queueLength: queue.length,
        ...updates,
      });
      return false;
    }

    queue[pendingIndex] = {
      ...queue[pendingIndex]!,
      ...updates,
    };
    this.pendingTurnsByManagerId.set(managerId, queue);
    this.deps.logDebug("manager:noop_guard:pending_turn_updated", pendingTurnLogDetails(managerId, queue[pendingIndex]!, {
      queueLength: queue.length,
    }));
    return true;
  }

  removePendingTurn(managerId: string, pendingTurnId: string): boolean {
    const queue = this.pendingTurnsByManagerId.get(managerId);
    if (!queue || queue.length === 0) {
      this.deps.logDebug("manager:noop_guard:pending_turn_remove_missed", {
        managerId,
        pendingTurnId,
        reason: "empty_queue",
      });
      return false;
    }

    const removedTurn = queue.find((pendingTurn) => pendingTurn.pendingTurnId === pendingTurnId);
    const nextQueue = queue.filter((pendingTurn) => pendingTurn.pendingTurnId !== pendingTurnId);
    if (nextQueue.length === queue.length) {
      this.deps.logDebug("manager:noop_guard:pending_turn_remove_missed", {
        managerId,
        pendingTurnId,
        reason: "not_found",
        queueLength: queue.length,
      });
      return false;
    }

    if (nextQueue.length === 0) {
      this.pendingTurnsByManagerId.delete(managerId);
    } else {
      this.pendingTurnsByManagerId.set(managerId, nextQueue);
    }
    this.deps.logDebug("manager:noop_guard:pending_turn_removed", {
      ...(removedTurn ? pendingTurnLogDetails(managerId, removedTurn) : { managerId, pendingTurnId }),
      queueLength: nextQueue.length,
    });
    return true;
  }

  suppress(managerId: string, reason: string): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state) {
      return;
    }

    state.suppressed = true;
    state.suppressionReason = reason;
    this.turnStateByManagerId.set(managerId, state);
    this.deps.logDebug("manager:noop_guard:suppressed", turnLogDetails(managerId, state, { reason }));
  }

  private noteToolActionStarted(managerId: string, toolName: string, toolCallId: string): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state || state.suppressed) {
      return;
    }

    if (!isManagerActionToolName(toolName)) {
      return;
    }

    state.attemptedActionToolCalls.set(toolCallId, toolName);
    this.turnStateByManagerId.set(managerId, state);
  }

  private noteToolActionCompleted(managerId: string, toolName: string, toolCallId: string, isError: boolean): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state || state.suppressed) {
      return;
    }

    const startedActionToolName = state.attemptedActionToolCalls.get(toolCallId);
    state.attemptedActionToolCalls.delete(toolCallId);

    if (isError) {
      this.turnStateByManagerId.set(managerId, state);
      this.deps.logDebug("manager:noop_guard:action_tool_completed", turnLogDetails(managerId, state, {
        toolName,
        toolCallId,
        isError,
        actionRecognized: startedActionToolName !== undefined || isManagerActionToolName(toolName),
      }));
      return;
    }

    if (startedActionToolName !== undefined || isManagerActionToolName(toolName)) {
      state.hadCompletedToolAction = true;
      this.turnStateByManagerId.set(managerId, state);
      this.deps.logDebug("manager:noop_guard:action_tool_completed", turnLogDetails(managerId, state, {
        toolName,
        toolCallId,
        isError,
        actionRecognized: true,
      }));
    }
  }

  noteVisibleOutput(managerId: string): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state || state.suppressed) {
      return;
    }

    state.hadVisibleOutput = true;
    this.turnStateByManagerId.set(managerId, state);
    this.deps.logDebug("manager:noop_guard:visible_output_observed", turnLogDetails(managerId, state));
  }

  noteRuntimeSessionEvent(managerId: string, event: RuntimeSessionEvent): void {
    if (event.type === "queued_input_start") {
      this.activatePendingTurnForQueuedInput(managerId, event.deliveryId, event.message.text, event.acceptedMode);
      return;
    }

    if (event.type === "message_start" && extractRole(event.message) === "user") {
      this.activatePendingTurnForRuntimeMessage(managerId, event.message);
      return;
    }

    if (event.type === "tool_execution_start") {
      this.noteToolActionStarted(managerId, event.toolName, event.toolCallId);
      return;
    }

    if (event.type === "tool_execution_end") {
      this.noteToolActionCompleted(managerId, event.toolName, event.toolCallId, event.isError === true);
      return;
    }

    if (isRuntimeAssistantMessageEndError(event)) {
      this.suppress(managerId, "runtime_error");
    }
  }

  private activatePendingTurnForRuntimeMessage(managerId: string, message: unknown): void {
    const runtimeMessageText = extractMessageText(message);
    if (!runtimeMessageText) {
      return;
    }

    this.activatePendingTurn(managerId, (pendingTurn) => {
      if (pendingTurn.deliveryId && pendingTurn.acceptedMode !== "prompt") {
        return false;
      }

      return runtimeMessageTextMatches(pendingTurn.runtimeMessageText, runtimeMessageText);
    });
  }

  private activatePendingTurnForQueuedInput(
    managerId: string,
    deliveryId: string,
    runtimeMessageText: string,
    acceptedMode: AcceptedDeliveryMode,
  ): void {
    this.activatePendingTurn(managerId, (pendingTurn) => {
      if (pendingTurn.deliveryId) {
        return pendingTurn.deliveryId === deliveryId;
      }

      if (pendingTurn.acceptedMode && pendingTurn.acceptedMode !== acceptedMode) {
        return false;
      }

      return runtimeMessageTextMatches(pendingTurn.runtimeMessageText, runtimeMessageText);
    });
  }

  private activatePendingTurn(
    managerId: string,
    matches: (pendingTurn: PendingManagerNoOpTurn) => boolean,
  ): void {
    const queue = this.pendingTurnsByManagerId.get(managerId);
    if (!queue || queue.length === 0) {
      return;
    }

    const pendingIndex = queue.findIndex(matches);
    if (pendingIndex < 0) {
      return;
    }

    const [pendingTurn] = queue.splice(pendingIndex, 1);
    if (queue.length === 0) {
      this.pendingTurnsByManagerId.delete(managerId);
    } else {
      this.pendingTurnsByManagerId.set(managerId, queue);
    }

    this.beginTurn(managerId, pendingTurn.triggerKind, {
      fromWorkerAgentId: pendingTurn.fromWorkerAgentId,
      triggerPreview: pendingTurn.triggerPreview,
    });

    const state = this.turnStateByManagerId.get(managerId);
    this.deps.logDebug("manager:noop_guard:pending_turn_started", pendingTurnLogDetails(managerId, pendingTurn, {
      turnSeq: state?.turnSeq,
    }));
  }

  async tryFinalize(
    managerId: string,
    source: "agent_end" | "idle",
    options?: { pendingCount?: number },
  ): Promise<void> {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state) {
      return;
    }

    if (state.suppressed) {
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: "suppressed",
      }));
      return;
    }

    if (state.guardFired) {
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: "already_fired",
      }));
      return;
    }

    if (options?.pendingCount !== undefined && options.pendingCount > 0) {
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: "pending_input",
        pendingCount: options.pendingCount,
      }));
      return;
    }

    if (state.hadCompletedToolAction || state.hadVisibleOutput) {
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: state.hadCompletedToolAction ? "completed_action" : "visible_output",
      }));
      this.turnStateByManagerId.delete(managerId);
      return;
    }

    if (this.deps.isManualStopPending(managerId)) {
      this.suppress(managerId, "manual_stop");
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: "manual_stop",
      }));
      return;
    }

    if (this.deps.isRuntimeRecoveryActive(managerId)) {
      this.suppress(managerId, "runtime_recovery");
      this.deps.logDebug("manager:noop_guard:finalize_skipped", turnLogDetails(managerId, state, {
        source,
        reason: "runtime_recovery",
      }));
      return;
    }

    state.guardFired = true;
    this.turnStateByManagerId.set(managerId, state);

    const shouldSendNudge = state.triggerKind === "worker_callback";

    this.deps.logDebug("manager:noop_guard:fired", turnLogDetails(managerId, state, {
      source,
      shouldSendNudge,
    }));

    if (shouldSendNudge) {
      const preview = state.triggerPreview ? `\n\nWorker update preview:\n${state.triggerPreview}` : "";
      const recoveryNudgeMessage = [
        `${MANAGER_NOOP_RECOVERY_NUDGE_PREFIX} Your previous turn ended without a visible Forge action.`,
        "Close the actionable worker callback with speak_to_user, send_message_to_agent, present_choices, further delegation, or task plus any needed user/peer closeout.",
        "If intentional silence is correct, state that rationale explicitly instead of returning empty assistant text.",
        preview,
      ]
        .join(" ")
        .trim();
      this.deps.logDebug("manager:noop_guard:recovery_nudge_send_start", turnLogDetails(managerId, state, {
        source,
        messageLength: recoveryNudgeMessage.length,
      }));
      try {
        const receipt = await this.deps.sendInternalManagerMessage(managerId, recoveryNudgeMessage);
        this.deps.logDebug("manager:noop_guard:recovery_nudge_sent", turnLogDetails(managerId, state, {
          source,
          deliveryId: receipt?.deliveryId,
          acceptedMode: receipt?.acceptedMode,
        }));
        if (receipt && !shouldBeginManagerNoOpGuardForDelivery(receipt.acceptedMode) && !shouldQueueManagerNoOpGuardForDelivery(receipt.acceptedMode)) {
          this.turnStateByManagerId.delete(managerId);
          this.deps.emitConversationMessage({
            type: "conversation_message",
            agentId: managerId,
            role: "system",
            text: MANAGER_NOOP_DIAGNOSTIC_FINAL,
            timestamp: this.deps.now(),
            source: "system",
          });
          this.deps.logDebug("manager:noop_guard:final_diagnostic_emitted", turnLogDetails(managerId, state, {
            source,
            reason: "recovery_nudge_not_guardable",
            deliveryId: receipt.deliveryId,
            acceptedMode: receipt.acceptedMode,
          }));
        }
        return;
      } catch (error) {
        this.deps.logDebug("manager:noop_guard:recovery_nudge_failed", turnLogDetails(managerId, state, {
          source,
          error: errorMessage(error),
        }));
        this.turnStateByManagerId.delete(managerId);
        this.deps.emitConversationMessage({
          type: "conversation_message",
          agentId: managerId,
          role: "system",
          text: MANAGER_NOOP_DIAGNOSTIC_FINAL,
          timestamp: this.deps.now(),
          source: "system",
        });
        this.deps.logDebug("manager:noop_guard:final_diagnostic_emitted", turnLogDetails(managerId, state, {
          source,
          reason: "recovery_nudge_send_failed",
        }));
        throw error;
      }
    }

    this.deps.emitConversationMessage({
      type: "conversation_message",
      agentId: managerId,
      role: "system",
      text: MANAGER_NOOP_DIAGNOSTIC_FINAL,
      timestamp: this.deps.now(),
      source: "system",
    });
    this.deps.logDebug("manager:noop_guard:final_diagnostic_emitted", turnLogDetails(managerId, state, {
      source,
      reason: state.triggerKind === "recovery_nudge" ? "recovery_nudge_noop" : "worker_callback_noop",
    }));

    this.turnStateByManagerId.delete(managerId);
  }
}
