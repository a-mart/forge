import type { RuntimeSessionEvent } from "./runtime-contracts.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  hasMessageErrorMessageField,
} from "./session/message-utils.js";
import type { AcceptedDeliveryMode, AgentDescriptor, ConversationMessageEvent } from "./types.js";
import { isActionableWorkerCallbackMessage } from "./worker-callback-message.js";
export { isActionableWorkerCallbackMessage } from "./worker-callback-message.js";

export const MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE =
  "Manager returned no visible action after a worker update. Forge sent an internal recovery nudge.";

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
  nudgeSentForTrigger: boolean;
  suppressed: boolean;
  suppressionReason?: string;
}

export interface PendingManagerNoOpTurn {
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
  sendInternalManagerMessage: (managerId: string, message: string) => Promise<void>;
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

export class ManagerNoOpGuard {
  private readonly turnStateByManagerId = new Map<string, ManagerNoOpTurnState>();
  private readonly pendingTurnsByManagerId = new Map<string, PendingManagerNoOpTurn[]>();
  private readonly nudgeSentForWorkerTriggerByManagerId = new Map<string, boolean>();

  constructor(private readonly deps: ManagerNoOpGuardDeps) {}

  getTurnState(managerId: string): ManagerNoOpTurnState | undefined {
    return this.turnStateByManagerId.get(managerId);
  }

  clearManager(managerId: string): void {
    this.turnStateByManagerId.delete(managerId);
    this.pendingTurnsByManagerId.delete(managerId);
    this.nudgeSentForWorkerTriggerByManagerId.delete(managerId);
  }

  beginTurn(
    managerId: string,
    triggerKind: ManagerNoOpTurnTriggerKind,
    details?: { fromWorkerAgentId?: string; triggerPreview?: string },
  ): void {
    const previous = this.turnStateByManagerId.get(managerId);
    const turnSeq = (previous?.turnSeq ?? 0) + 1;

    this.turnStateByManagerId.set(managerId, {
      turnSeq,
      triggerKind,
      fromWorkerAgentId: details?.fromWorkerAgentId,
      triggerPreview: details?.triggerPreview?.slice(0, 240),
      attemptedActionToolCalls: new Map(),
      hadCompletedToolAction: false,
      hadVisibleOutput: false,
      guardFired: false,
      nudgeSentForTrigger: false,
      suppressed: false,
    });
  }

  queuePendingTurn(managerId: string, pendingTurn: PendingManagerNoOpTurn): void {
    const runtimeMessageText = normalizeRuntimeMessageTextForGuard(pendingTurn.runtimeMessageText);
    if (!runtimeMessageText && !pendingTurn.deliveryId) {
      return;
    }

    const queue = this.pendingTurnsByManagerId.get(managerId) ?? [];
    queue.push({
      ...pendingTurn,
      runtimeMessageText,
      triggerPreview: pendingTurn.triggerPreview?.slice(0, 240),
    });
    this.pendingTurnsByManagerId.set(managerId, queue);
  }

  suppress(managerId: string, reason: string): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state) {
      return;
    }

    state.suppressed = true;
    state.suppressionReason = reason;
    this.turnStateByManagerId.set(managerId, state);
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
      return;
    }

    if (startedActionToolName !== undefined || isManagerActionToolName(toolName)) {
      state.hadCompletedToolAction = true;
      this.turnStateByManagerId.set(managerId, state);
    }
  }

  noteVisibleOutput(managerId: string): void {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state || state.suppressed) {
      return;
    }

    state.hadVisibleOutput = true;
    this.turnStateByManagerId.set(managerId, state);
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
      if (pendingTurn.deliveryId) {
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

    this.deps.logDebug("manager:noop_guard:pending_turn_started", {
      managerId,
      deliveryId: pendingTurn.deliveryId,
      acceptedMode: pendingTurn.acceptedMode,
      requestedDelivery: pendingTurn.requestedDelivery,
      triggerKind: pendingTurn.triggerKind,
      fromWorkerAgentId: pendingTurn.fromWorkerAgentId,
    });
  }

  async tryFinalize(
    managerId: string,
    source: "agent_end" | "idle",
    options?: { pendingCount?: number },
  ): Promise<void> {
    const state = this.turnStateByManagerId.get(managerId);
    if (!state || state.suppressed || state.guardFired) {
      return;
    }

    if (options?.pendingCount !== undefined && options.pendingCount > 0) {
      return;
    }

    if (state.hadCompletedToolAction || state.hadVisibleOutput) {
      this.turnStateByManagerId.delete(managerId);
      return;
    }

    if (this.deps.isManualStopPending(managerId)) {
      this.suppress(managerId, "manual_stop");
      return;
    }

    if (this.deps.isRuntimeRecoveryActive(managerId)) {
      this.suppress(managerId, "runtime_recovery");
      return;
    }

    state.guardFired = true;
    this.turnStateByManagerId.set(managerId, state);

    const alreadyNudgedForWorkerTrigger = this.nudgeSentForWorkerTriggerByManagerId.get(managerId) === true;
    const shouldSendNudge =
      state.triggerKind === "worker_callback" && !alreadyNudgedForWorkerTrigger;

    this.deps.emitConversationMessage({
      type: "conversation_message",
      agentId: managerId,
      role: "system",
      text: shouldSendNudge ? MANAGER_NOOP_DIAGNOSTIC_WITH_NUDGE : MANAGER_NOOP_DIAGNOSTIC_FINAL,
      timestamp: this.deps.now(),
      source: "system",
    });

    this.deps.logDebug("manager:noop_guard:fired", {
      managerId,
      source,
      triggerKind: state.triggerKind,
      fromWorkerAgentId: state.fromWorkerAgentId,
      shouldSendNudge,
    });

    if (shouldSendNudge) {
      this.nudgeSentForWorkerTriggerByManagerId.set(managerId, true);
      const preview = state.triggerPreview ? `\n\nWorker update preview:\n${state.triggerPreview}` : "";
      await this.deps.sendInternalManagerMessage(
        managerId,
        [
          `${MANAGER_NOOP_RECOVERY_NUDGE_PREFIX} Your previous turn ended without a visible Forge action.`,
          "Close the actionable worker callback with speak_to_user, send_message_to_agent, present_choices, further delegation, or task plus any needed user/peer closeout.",
          "If intentional silence is correct, state that rationale explicitly instead of returning empty assistant text.",
          preview,
        ]
          .join(" ")
          .trim(),
      );
      return;
    }

    this.turnStateByManagerId.delete(managerId);
  }
}
