import type { ModelCacheObservationEvent } from "@forge/protocol";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent, SwarmConfig } from "../types.js";
import { captureModelCacheObservationFromRuntimeEvent } from "./model-cache-observation.js";
import {
  extractVersionedToolPath,
  formatToolExecutionPayload,
  isVersionedWriteToolName,
  previewForLog,
  safeJson,
  trimToMaxChars,
  trimToMaxCharsFromEnd
} from "../swarm-manager-utils.js";
import {
  extractMessageErrorMessage,
  extractMessageStopReason,
  extractMessageText,
  extractRole,
  isAbortLikeErrorMessage,
  isLocalRuntimeShutdownErrorMessage
} from "../message-utils.js";
import type { VersioningMutation } from "../../versioning/versioning-types.js";
import { MANUAL_MANAGER_STOP_NOTICE } from "../manual-stop-notice.js";
import type { WorkerActivityStateLike, WorkerStallStateLike } from "./worker-health-types.js";
import type { RuntimeRecoveryState } from "./runtime-recovery-state.js";
import {
  ManagerAssistantOutputTracker,
  type AssistantOutputTarget,
  type SessionTranscriptAssistantOutputTarget,
} from "./manager-assistant-output-tracker.js";
import { extractCleanManagerAssistantFinalMessage } from "./manager-assistant-final-message.js";
import {
  appendMessageRoutingReceipt,
  buildMessageRoutingReceipt,
  type MessageRoutingReceiptRecord,
} from "../session/message-routing-receipts.js";
import type { MessageRouteDecision } from "../message-router.js";

export type RuntimeEventProjectorRecoveryState = Pick<
  RuntimeRecoveryState,
  "markRecoveryAbortedWorkerTurn" | "hasRecoveryAbortedWorkerTurn" | "clearRecoveryAbortedWorkerTurn"
>;

export interface RuntimeEventProjectorDeps {
  config: Pick<SwarmConfig, "debug">;
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  runtimeRecoveryState: RuntimeEventProjectorRecoveryState;
  now: () => string;
  conversationProjector: {
    captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent, options?: { turnId?: string }): void;
    emitConversationMessage(event: ConversationMessageEvent, options?: { routingReceipt?: MessageRoutingReceiptRecord }): void;
  };
  markSessionActivity(agentId: string, timestamp: string): void;
  maybeRecordModelCapacityBlock(
    agentId: string,
    descriptor: AgentDescriptor,
    error: { phase: "prompt_start"; message: string }
  ): void;
  maybeRecoverWorkerWithSpecialistFallback(
    agentId: string,
    errorMessage: string,
    sourcePhase: "prompt_start",
    runtimeToken?: number
  ): Promise<boolean>;
  consumePendingManualManagerStopNoticeIfApplicable(agentId: string, event: RuntimeSessionEvent): boolean;
  stripManagerAbortErrorFromEvent(event: RuntimeSessionEvent): RuntimeSessionEvent;
  isRuntimeRecoveryActive(agentId: string): boolean;
  beginPendingTransientWorkerTerminatedError(
    agentId: string,
    event: RuntimeSessionEvent,
    expire: (event: RuntimeSessionEvent) => void | Promise<void>
  ): boolean;
  cancelPendingTransientWorkerTerminatedError(agentId: string, reason: "runtime_progress" | "worker_reported" | "clear_state"): void;
  hasPendingTransientWorkerTerminatedError(agentId: string): boolean;
  queueVersionedToolMutation(descriptor: AgentDescriptor, mutation: VersioningMutation): Promise<void>;
  logDebug(message: string, details?: unknown): void;
  getRuntime(agentId: string): SwarmAgentRuntime | undefined;
  getActiveTurnId(agentId: string, runtimeToken?: number): string | undefined;
  isModelCacheVisualizationEnabled(): boolean;
  emitModelCacheObservation(event: ModelCacheObservationEvent): void;
  resolveManagerAssistantFinalOutputTarget(
    agentId: string,
    descriptor: AgentDescriptor,
    activeTarget: AssistantOutputTarget | undefined
  ): SessionTranscriptAssistantOutputTarget | undefined;
  resolveManagerAssistantFinalOutputRoute?(
    agentId: string,
    descriptor: AgentDescriptor,
    activeTarget: AssistantOutputTarget | undefined
  ): ManagerAssistantOutputRouteResult | undefined;
}

export interface ManagerAssistantOutputRouteResult {
  target?: SessionTranscriptAssistantOutputTarget;
  decision: MessageRouteDecision;
  sourceWorkerId?: string;
}

export interface RuntimeEventProjectionInput {
  agentId: string;
  runtimeToken?: number;
  event: RuntimeSessionEvent;
  transientTerminatedExpired?: boolean;
}

export class RuntimeEventProjector {
  private readonly trackedToolPathsByAgentId = new Map<string, Map<string, { toolName: string; path: string }>>();
  private readonly managerAssistantOutputTracker: ManagerAssistantOutputTracker;
  private readonly visibleManagerOutputTurnIds = new Set<string>();
  /**
   * Silent-turn notices armed at `turn_end` but not yet delivered.  A runtime
   * "turn" is one model-call cycle, and a manager run routinely spans several
   * cycles (tool-call cycle -> tool results -> final-text cycle), so at any
   * single `turn_end` we cannot yet know whether visible output is still
   * coming.  The notice is therefore armed here and only emitted at
   * `agent_end` — the run's terminal event — unless user-visible output (or a
   * `present_choices` prompt) lands first and cancels it.  Keyed by agentId;
   * cleared on delivery, cancellation, or the next `agent_end`.
   */
  private readonly pendingSilentManagerNotices = new Map<string, ConversationMessageEvent>();
  /**
   * Managers that have produced user-visible output during the current run.
   * Needed in addition to the per-turn set above because the final text of a
   * multi-cycle run is projected after its ledger turn has already closed
   * (turnId is null by then), so per-turn marking alone cannot suppress the
   * armed notice.  Reset at `agent_end`.
   */
  private readonly visibleManagerOutputAgentIds = new Set<string>();
  /**
   * Monotonic watermark: epoch-ms of the last user-facing manager output this
   * projector actually emitted, per agent.  This is the single source of truth
   * for "did the user see something" — the pi runtime's hidden-output resample
   * ladder consults it (via SwarmRuntimeCallbacks.getLastUserFacingManagerOutputAt)
   * before judging a run silent, so runtime-side text-marker policy can never
   * again contradict what actually rendered.  Never cleared (bounded by agent
   * count), unlike the per-run set above.
   */
  private readonly lastUserFacingOutputAtByAgentId = new Map<string, number>();
  /**
   * Text of the most recent silent-turn notice delivered per agent, cleared as
   * soon as any user-facing output appears.  The pi resample ladder re-runs a
   * silent trigger as a fresh run, so without this an identical notice would be
   * emitted once per attempt; consecutive duplicates are collapsed to one.
   */
  private readonly lastEmittedSilentNoticeTextByAgentId = new Map<string, string>();

  constructor(private readonly deps: RuntimeEventProjectorDeps) {
    this.managerAssistantOutputTracker = new ManagerAssistantOutputTracker({
      now: deps.now,
      emitConversationMessage: (event) => {
        this.markVisibleManagerOutput(event);
        deps.conversationProjector.emitConversationMessage(event);
      },
      markSessionActivity: (agentId, timestamp) => deps.markSessionActivity(agentId, timestamp),
      resolveRoute: (agentId, target) => {
        const descriptor = deps.descriptors.get(agentId);
        return descriptor?.role === "manager"
          ? deps.resolveManagerAssistantFinalOutputRoute?.(agentId, descriptor, target)
          : undefined;
      },
      recordRoutingDecision: (agentId, turnId, decision, timestamp) => {
        const descriptor = deps.descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager") {
          return;
        }
        this.appendRoutingReceiptBestEffort(descriptor, buildMessageRoutingReceipt({
          agentId,
          timestamp,
          decision,
          ...(turnId ? { turnId } : {}),
        }));
      },
    });
  }

  activateManagerAssistantOutputTurn(agentId: string, target: AssistantOutputTarget, options?: { turnId?: string }): void {
    this.managerAssistantOutputTracker.activateTurn(agentId, target, options);
  }

  clearManagerAssistantOutputTurn(agentId: string): void {
    this.managerAssistantOutputTracker.clearTurn(agentId);
  }

  flushManagerAssistantOutputTurn(agentId: string): void {
    this.managerAssistantOutputTracker.flushTurn(agentId);
  }

  flushPreservedManagerAssistantOutputForTool(agentId: string, toolName: string): boolean {
    return this.managerAssistantOutputTracker.flushPreservedCandidateForTool(agentId, toolName);
  }

  markExplicitManagerAssistantOutput(agentId: string): void {
    this.markUserFacingManagerActivity(agentId, this.deps.getActiveTurnId(agentId));
    this.managerAssistantOutputTracker.markExplicitAssistantOutput(agentId);
  }

  getTrackedToolPathsByAgentId(): Map<string, Map<string, { toolName: string; path: string }>> {
    return this.trackedToolPathsByAgentId;
  }

  clearTrackedToolPaths(agentId: string): void {
    this.trackedToolPathsByAgentId.delete(agentId);
  }

  updateWorkerActivity(agentId: string, event: RuntimeSessionEvent): void {
    if (!this.deps.workerStallState.has(agentId)) {
      this.deps.workerActivityState.delete(agentId);
      return;
    }

    let state = this.deps.workerActivityState.get(agentId);
    if (!state) {
      state = {
        currentToolName: null,
        currentToolStartedAt: null,
        lastProgressAt: Date.now(),
        toolCallCount: 0,
        errorCount: 0,
        turnCount: 0
      };
      this.deps.workerActivityState.set(agentId, state);
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

  shouldSuppressWorkerIdleFinalization(descriptor: AgentDescriptor): boolean {
    return (
      this.deps.runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(descriptor.agentId) ||
      this.deps.isRuntimeRecoveryActive(descriptor.agentId)
    );
  }

  clearRecoveryAbortedWorkerTurn(agentId: string): void {
    this.deps.runtimeRecoveryState.clearRecoveryAbortedWorkerTurn(agentId);
  }

  async projectEvent({ agentId, runtimeToken, event, transientTerminatedExpired = false }: RuntimeEventProjectionInput): Promise<void> {
    const descriptor = this.deps.descriptors.get(agentId);
    if (descriptor?.role === "worker" && !transientTerminatedExpired && isPositiveWorkerRuntimeProgressEvent(event)) {
      this.deps.cancelPendingTransientWorkerTerminatedError(agentId, "runtime_progress");
    }

    if (
      descriptor?.role === "worker" &&
      event.type === "message_end" &&
      extractMessageStopReason(event.message) === "error"
    ) {
      const errorText =
        extractMessageErrorMessage(event.message) ??
        extractMessageText(event.message) ??
        "Unknown runtime error";
      const parentRecoveryActive = descriptor.managerId
        ? this.deps.isRuntimeRecoveryActive(descriptor.managerId)
        : false;
      if (
        extractRole(event.message) === "assistant" &&
        isLocalRuntimeShutdownErrorMessage(errorText) &&
        (
          this.deps.isRuntimeRecoveryActive(agentId) ||
          parentRecoveryActive ||
          isIntendedWorkerShutdownStatus(descriptor.status)
        )
      ) {
        this.deps.runtimeRecoveryState.markRecoveryAbortedWorkerTurn(agentId);
        return;
      }

      if (extractRole(event.message) === "assistant" && isBareTerminatedErrorMessage(errorText)) {
        if (!transientTerminatedExpired) {
          const handled = this.deps.beginPendingTransientWorkerTerminatedError(agentId, event, (expiredEvent) =>
            this.projectEvent({ agentId, runtimeToken, event: expiredEvent, transientTerminatedExpired: true })
          );
          if (handled) {
            return;
          }
        }
      } else {
        this.deps.maybeRecordModelCapacityBlock(agentId, descriptor, {
          phase: "prompt_start",
          message: errorText
        });

        const recoveredWithFallback = await this.deps.maybeRecoverWorkerWithSpecialistFallback(
          agentId,
          errorText,
          "prompt_start",
          runtimeToken
        );
        if (recoveredWithFallback) {
          return;
        }
      }
    }

    const shouldSurfaceManualStopNotice =
      descriptor?.role === "manager" && this.deps.consumePendingManualManagerStopNoticeIfApplicable(agentId, event);

    const managerStopReason = event.type === "message_end" ? extractMessageStopReason(event.message) : undefined;
    const managerErrorMessage = event.type === "message_end" ? extractMessageErrorMessage(event.message) : undefined;
    const isContextRecoveryAbort =
      !shouldSurfaceManualStopNotice &&
      descriptor?.role === "manager" &&
      this.deps.isRuntimeRecoveryActive(agentId) &&
      event.type === "message_end" &&
      (managerStopReason === "error" || managerStopReason === "aborted" || managerErrorMessage !== undefined) &&
      isAbortLikeErrorMessage(managerErrorMessage ?? extractMessageText(event.message));

    const effectiveEvent = (shouldSurfaceManualStopNotice || isContextRecoveryAbort)
      ? this.deps.stripManagerAbortErrorFromEvent(event)
      : event;

    const activeTurnId = this.deps.getActiveTurnId(agentId, runtimeToken);
    if (activeTurnId) {
      this.deps.conversationProjector.captureConversationEventFromRuntime(agentId, effectiveEvent, {
        turnId: activeTurnId
      });
    } else {
      this.deps.conversationProjector.captureConversationEventFromRuntime(agentId, effectiveEvent);
    }
    this.maybeEmitWorkerReportConversationMessage(agentId, descriptor, effectiveEvent, activeTurnId);
    const activeAssistantTarget = this.managerAssistantOutputTracker.getActiveTarget(agentId);
    if (shouldSurfaceManualStopNotice || isContextRecoveryAbort) {
      this.managerAssistantOutputTracker.clearTurn(agentId);
    } else {
      this.managerAssistantOutputTracker.handleRuntimeEvent(agentId, effectiveEvent);
      this.maybeProjectCleanManagerAssistantFinalMessage(agentId, descriptor, effectiveEvent, activeTurnId);
      // Presenting choices IS a visible response: the user sees an
      // interactive prompt even though no assistant text is emitted, so it
      // must suppress the silent-turn notice for this run.
      if (
        descriptor?.role === "manager" &&
        effectiveEvent.type === "tool_execution_start" &&
        effectiveEvent.toolName === "present_choices"
      ) {
        this.markUserFacingManagerActivity(agentId, activeTurnId);
      }
      this.maybeEmitSilentManagerBackstop(agentId, descriptor, effectiveEvent, activeTurnId, activeAssistantTarget);
      this.maybeEmitModelCacheObservation(agentId, descriptor, effectiveEvent);
    }
    if (shouldSurfaceManualStopNotice) {
      this.deps.conversationProjector.emitConversationMessage({
        type: "conversation_message",
        agentId,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        role: "system",
        text: MANUAL_MANAGER_STOP_NOTICE,
        timestamp: this.deps.now(),
        source: "system"
      });
    }
    this.maybeRecordVersionedToolMutation(agentId, effectiveEvent);

    if (descriptor?.role === "worker") {
      this.trackWorkerStallProgressEvent(descriptor.agentId, effectiveEvent);
      this.updateWorkerActivity(descriptor.agentId, effectiveEvent);
    }

    this.logManagerDebug(descriptor, event, effectiveEvent);
  }

  private maybeProjectCleanManagerAssistantFinalMessage(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    effectiveEvent: RuntimeSessionEvent,
    turnId?: string
  ): void {
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    const finalMessage = extractCleanManagerAssistantFinalMessage(effectiveEvent);
    if (!finalMessage) {
      return;
    }

    const route = this.deps.resolveManagerAssistantFinalOutputRoute?.(
      agentId,
      descriptor,
      this.managerAssistantOutputTracker.getActiveTarget(agentId)
    );
    const target = route
      ? route.target
      : this.deps.resolveManagerAssistantFinalOutputTarget(
          agentId,
          descriptor,
          this.managerAssistantOutputTracker.getActiveTarget(agentId)
        );
    const timestamp = this.deps.now();
    const decision = route?.decision;
    if (!target || target.channel !== "web") {
      if (decision) {
        this.appendRoutingReceiptBestEffort(descriptor, buildMessageRoutingReceipt({
          agentId,
          timestamp,
          decision,
          ...(turnId ? { turnId } : {}),
        }));
      }
      return;
    }

    const routingReceipt = decision
      ? buildMessageRoutingReceipt({
          agentId,
          timestamp,
          decision,
          ...(turnId ? { turnId } : {}),
        })
      : undefined;
    const outputEvent: ConversationMessageEvent = {
      type: "conversation_message",
      agentId,
      ...(turnId ? { turnId } : {}),
      role: "assistant",
      text: finalMessage.text,
      timestamp,
      source: "assistant_output",
      sourceContext: target.sourceContext ?? { channel: target.channel },
    };
    this.markVisibleManagerOutput(outputEvent);
    if (routingReceipt) {
      this.deps.conversationProjector.emitConversationMessage(outputEvent, { routingReceipt });
    } else {
      this.deps.conversationProjector.emitConversationMessage(outputEvent);
    }
    this.deps.markSessionActivity(agentId, timestamp);
  }

  /**
   * Two-phase silent-manager detection (arm at `turn_end`, decide at
   * `agent_end`).
   *
   * The previous single-phase version emitted the notice directly at
   * `turn_end`, which produced a steady stream of false positives: a manager
   * run is a sequence of model-call cycles, and the runtime emits `turn_end`
   * after EACH cycle.  A tool-only cycle (queueing worker messages, presenting
   * choices) looks "silent" at its own `turn_end` even though the run's final
   * text lands seconds later in a later cycle — after the ledger turn has
   * closed, so that text also carries no turnId and could never mark the turn
   * visible retroactively.  Observed in production: notice at 17:40:20.089,
   * real `assistant_output` at 17:40:26.377 with `turnId: null`.
   *
   * Phase 1 (turn_end): if the run has produced no user-visible output so
   * far and the output route says a visible response was expected, ARM the
   * notice (latest silent cycle wins).
   * Phase 2 (agent_end): if the armed notice survived — i.e. no visible text
   * and no `present_choices` prompt arrived in any later cycle — emit it.
   */
  private maybeEmitSilentManagerBackstop(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    effectiveEvent: RuntimeSessionEvent,
    turnId: string | undefined,
    activeTarget: AssistantOutputTarget | undefined,
  ): void {
    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    if (effectiveEvent.type !== "turn_end" && effectiveEvent.type !== "agent_end") {
      return;
    }

    if (turnId && this.visibleManagerOutputTurnIds.has(turnId)) {
      this.visibleManagerOutputTurnIds.delete(turnId);
      this.pendingSilentManagerNotices.delete(agentId);
    } else if (turnId && !this.visibleManagerOutputAgentIds.has(agentId)) {
      const route = this.deps.resolveManagerAssistantFinalOutputRoute?.(agentId, descriptor, activeTarget);
      const reasonCode = route?.decision.reasonCode;
      if (
        reasonCode === "render:user_web" ||
        reasonCode === "render:scheduled_web" ||
        reasonCode === "render:terminal_worker_report_closeout"
      ) {
        const text = route?.sourceWorkerId
          ? `Worker \`${route.sourceWorkerId}\` completed and reported back; the manager did not summarize it. View worker report in All.`
          : "The manager completed this turn without a visible response.";
        this.pendingSilentManagerNotices.set(agentId, {
          type: "conversation_message",
          agentId,
          turnId,
          role: "system",
          text,
          timestamp: this.deps.now(),
          source: "system",
        });
      }
    }

    if (effectiveEvent.type === "agent_end") {
      const armed = this.pendingSilentManagerNotices.get(agentId);
      this.pendingSilentManagerNotices.delete(agentId);
      this.visibleManagerOutputAgentIds.delete(agentId);
      if (armed) {
        // The pi resample ladder re-dispatches a silent trigger as a fresh
        // run, so a genuinely silent obligation would otherwise emit this same
        // notice once per attempt.  Collapse consecutive identical notices;
        // the memo clears the moment any user-facing output lands.
        if (this.lastEmittedSilentNoticeTextByAgentId.get(agentId) === armed.text) {
          return;
        }
        this.lastEmittedSilentNoticeTextByAgentId.set(agentId, armed.text);
        this.deps.conversationProjector.emitConversationMessage({ ...armed, timestamp: this.deps.now() });
      }
    }
  }

  private markVisibleManagerOutput(event: ConversationMessageEvent): void {
    if (
      event.role === "assistant" &&
      (event.source === "speak_to_user" || event.source === "assistant_output" || event.source === "assistant_progress")
    ) {
      this.markUserFacingManagerActivity(event.agentId, event.turnId);
    }
  }

  /**
   * Record that the manager put something in front of the user (assistant
   * text on any channel, or an interactive `present_choices` prompt) and
   * cancel any armed silent-turn notice.  Deliberately does NOT require a
   * turnId: the final text of a multi-cycle run arrives after its ledger turn
   * closed, and choice prompts are emitted outside turn context entirely.
   */
  private markUserFacingManagerActivity(agentId: string, turnId?: string): void {
    if (turnId) {
      this.visibleManagerOutputTurnIds.add(turnId);
    }
    this.visibleManagerOutputAgentIds.add(agentId);
    this.pendingSilentManagerNotices.delete(agentId);
    this.lastEmittedSilentNoticeTextByAgentId.delete(agentId);
    const at = Date.parse(this.deps.now());
    this.lastUserFacingOutputAtByAgentId.set(agentId, Number.isNaN(at) ? Date.now() : at);
  }

  /**
   * Ground truth for "when did the user last see manager output" — consulted
   * by the pi runtime's hidden-output resample ladder so it never re-prompts
   * (or reports a silent-turn error) over a response that actually rendered.
   */
  getLastUserFacingManagerOutputAt(agentId: string): number | undefined {
    return this.lastUserFacingOutputAtByAgentId.get(agentId);
  }

  /**
   * Record an out-of-band user-facing delivery (e.g. the terminal-obligation
   * backstop surfacing a worker outcome via SwarmManager).  Cancels any armed
   * silent-turn notice and advances the visibility watermark so no other layer
   * piles a second artifact on top of the delivery.
   */
  noteUserFacingManagerDelivery(agentId: string): void {
    this.markUserFacingManagerActivity(agentId);
  }

  private maybeEmitWorkerReportConversationMessage(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    effectiveEvent: RuntimeSessionEvent,
    turnId?: string,
  ): void {
    if (descriptor?.role !== "worker" || effectiveEvent.type !== "message_end") {
      return;
    }

    const role = extractRole(effectiveEvent.message);
    if (role !== "assistant" && role !== "system") {
      return;
    }

    const text = extractMessageText(effectiveEvent.message)?.trim();
    if (!text) {
      return;
    }

    const timestamp = this.deps.now();
    this.deps.conversationProjector.emitConversationMessage({
      type: "conversation_message",
      agentId: descriptor.managerId,
      ...(turnId ? { turnId } : {}),
      role: "system",
      text,
      timestamp,
      source: "worker_report",
      terminal: true,
      sourceWorkerId: agentId,
      excludeFromModelContext: true,
    }, {
      routingReceipt: {
        type: "message_routing",
        timestamp,
        ...(turnId ? { turnId } : {}),
        agentId: descriptor.managerId,
        decision: "route",
        reasonCode: "route:worker_report_all_view",
        targetKind: "session_transcript",
        sourceWorkerId: agentId,
      },
    });
  }

  private appendRoutingReceiptBestEffort(descriptor: AgentDescriptor, receipt: MessageRoutingReceiptRecord): void {
    try {
      appendMessageRoutingReceipt({ sessionFile: descriptor.sessionFile, record: receipt });
    } catch (error) {
      this.deps.logDebug("message_routing:receipt:error", {
        agentId: descriptor.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private maybeEmitModelCacheObservation(
    agentId: string,
    descriptor: AgentDescriptor | undefined,
    effectiveEvent: RuntimeSessionEvent
  ): void {
    if (!this.deps.isModelCacheVisualizationEnabled()) {
      return;
    }

    const observation = captureModelCacheObservationFromRuntimeEvent({
      agentId,
      descriptor,
      effectiveEvent,
      runtime: this.deps.getRuntime(agentId),
      timestamp: this.deps.now(),
      enabled: true
    });

    if (observation) {
      this.deps.emitModelCacheObservation(observation);
    }
  }

  private logManagerDebug(
    descriptor: AgentDescriptor | undefined,
    event: RuntimeSessionEvent,
    effectiveEvent: RuntimeSessionEvent
  ): void {
    if (!this.deps.config.debug) return;

    if (!descriptor || descriptor.role !== "manager") {
      return;
    }

    switch (effectiveEvent.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
        this.deps.logDebug(`manager:event:${event.type}`);
        return;

      case "turn_end":
        this.deps.logDebug("manager:event:turn_end", {
          toolResults: effectiveEvent.toolResults.length
        });
        return;

      case "tool_execution_start":
        this.deps.logDebug("manager:tool:start", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          args: previewForLog(safeJson(effectiveEvent.args), 240)
        });
        return;

      case "tool_execution_end":
        this.deps.logDebug("manager:tool:end", {
          toolName: effectiveEvent.toolName,
          toolCallId: effectiveEvent.toolCallId,
          isError: effectiveEvent.isError,
          result: previewForLog(safeJson(effectiveEvent.result), 240)
        });
        return;

      case "message_start":
      case "message_end":
        this.deps.logDebug(`manager:event:${effectiveEvent.type}`, {
          role: extractRole(effectiveEvent.message),
          textPreview: previewForLog(extractMessageText(effectiveEvent.message) ?? "")
        });
        break;

      case "message_update":
      case "tool_execution_update":
      case "auto_compaction_start":
      case "auto_compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
        break;
    }
  }

  private trackWorkerStallProgressEvent(agentId: string, event: RuntimeSessionEvent): void {
    const stallState = this.deps.workerStallState.get(agentId);
    if (!stallState) {
      return;
    }

    switch (event.type) {
      case "tool_execution_start": {
        stallState.lastToolName = event.toolName;
        stallState.lastToolInput = trimToMaxChars(formatToolExecutionPayload(event.args), 500);
        stallState.lastToolOutput = null;
        this.deps.workerStallState.set(agentId, stallState);
        return;
      }

      case "tool_execution_update": {
        stallState.lastToolName = event.toolName;
        const chunk = formatToolExecutionPayload(event.partialResult);
        const mergedOutput = `${stallState.lastToolOutput ?? ""}${chunk}`;
        stallState.lastToolOutput = trimToMaxCharsFromEnd(mergedOutput, 500);
        this.deps.workerStallState.set(agentId, stallState);
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

  private recordWorkerStallProgress(agentId: string): void {
    const stallState = this.deps.workerStallState.get(agentId);
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

    this.deps.workerStallState.set(agentId, stallState);
  }

  private maybeRecordVersionedToolMutation(agentId: string, event: RuntimeSessionEvent): void {
    if (event.type === "tool_execution_start") {
      if (!isVersionedWriteToolName(event.toolName)) {
        return;
      }

      const path = extractVersionedToolPath(event.args);
      if (!path) {
        return;
      }

      const byToolCallId = this.trackedToolPathsByAgentId.get(agentId) ?? new Map<string, { toolName: string; path: string }>();
      byToolCallId.set(event.toolCallId, { toolName: event.toolName, path });
      this.trackedToolPathsByAgentId.set(agentId, byToolCallId);
      return;
    }

    if (event.type !== "tool_execution_end" || event.isError || !isVersionedWriteToolName(event.toolName)) {
      return;
    }

    const descriptor = this.deps.descriptors.get(agentId);
    const tracked = this.trackedToolPathsByAgentId.get(agentId)?.get(event.toolCallId);
    this.trackedToolPathsByAgentId.get(agentId)?.delete(event.toolCallId);

    const path = tracked?.path ?? extractVersionedToolPath(event.result);
    if (!descriptor || !path) {
      return;
    }

    void this.deps.queueVersionedToolMutation(descriptor, {
      path,
      action: "write",
      source: tracked?.toolName === "edit" ? "agent-edit-tool" : "agent-write-tool",
      profileId: descriptor.profileId ?? descriptor.agentId,
      sessionId: descriptor.role === "manager" ? descriptor.agentId : descriptor.managerId,
      agentId
    });
  }
}

function isIntendedWorkerShutdownStatus(status: AgentDescriptor["status"]): boolean {
  return status === "terminated" || status === "stopped";
}

function isBareTerminatedErrorMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  return /^terminated\.?$/i.test(message.replace(/\s+/g, " ").trim());
}

function isPositiveWorkerRuntimeProgressEvent(event: RuntimeSessionEvent): boolean {
  switch (event.type) {
    case "turn_start":
    case "message_start":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "turn_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return true;
    case "message_update":
      return extractRole(event.message) === "assistant" || extractRole(event.message) === "system";
    case "message_end":
      return (
        extractMessageStopReason(event.message) !== "error" &&
        (extractRole(event.message) === "assistant" || extractRole(event.message) === "system")
      );
    default:
      return false;
  }
}
