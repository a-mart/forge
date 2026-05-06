import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { AgentDescriptor, ConversationMessageEvent, SwarmConfig } from "../types.js";
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
  isAbortLikeErrorMessage
} from "../message-utils.js";
import type { VersioningMutation } from "../../versioning/versioning-types.js";
import type { WorkerActivityStateLike, WorkerStallStateLike } from "./worker-health-types.js";

const MANUAL_MANAGER_STOP_NOTICE = "Session stopped.";

export interface RuntimeEventProjectorDeps {
  config: Pick<SwarmConfig, "debug">;
  descriptors: Map<string, AgentDescriptor>;
  workerStallState: Map<string, WorkerStallStateLike>;
  workerActivityState: Map<string, WorkerActivityStateLike>;
  now: () => string;
  conversationProjector: {
    captureConversationEventFromRuntime(agentId: string, event: RuntimeSessionEvent): void;
    emitConversationMessage(event: ConversationMessageEvent): void;
  };
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
  queueVersionedToolMutation(descriptor: AgentDescriptor, mutation: VersioningMutation): Promise<void>;
  logDebug(message: string, details?: unknown): void;
}

export interface RuntimeEventProjectionInput {
  agentId: string;
  runtimeToken?: number;
  event: RuntimeSessionEvent;
}

export class RuntimeEventProjector {
  private readonly trackedToolPathsByAgentId = new Map<string, Map<string, { toolName: string; path: string }>>();
  private readonly recoveryAbortedWorkerTurnAgentIds = new Set<string>();

  constructor(private readonly deps: RuntimeEventProjectorDeps) {}

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
    return this.recoveryAbortedWorkerTurnAgentIds.has(descriptor.agentId) || this.deps.isRuntimeRecoveryActive(descriptor.agentId);
  }

  clearRecoveryAbortedWorkerTurn(agentId: string): void {
    this.recoveryAbortedWorkerTurnAgentIds.delete(agentId);
  }

  async projectEvent({ agentId, runtimeToken, event }: RuntimeEventProjectionInput): Promise<void> {
    const descriptor = this.deps.descriptors.get(agentId);
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
        isAbortLikeErrorMessage(errorText) &&
        (this.deps.isRuntimeRecoveryActive(agentId) || parentRecoveryActive)
      ) {
        this.recoveryAbortedWorkerTurnAgentIds.add(agentId);
        return;
      }

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

    const shouldSurfaceManualStopNotice =
      descriptor?.role === "manager" && this.deps.consumePendingManualManagerStopNoticeIfApplicable(agentId, event);

    const isContextRecoveryAbort =
      !shouldSurfaceManualStopNotice &&
      descriptor?.role === "manager" &&
      this.deps.isRuntimeRecoveryActive(agentId) &&
      event.type === "message_end" &&
      extractMessageStopReason(event.message) === "error" &&
      isAbortLikeErrorMessage(extractMessageErrorMessage(event.message) ?? extractMessageText(event.message));

    const effectiveEvent = (shouldSurfaceManualStopNotice || isContextRecoveryAbort)
      ? this.deps.stripManagerAbortErrorFromEvent(event)
      : event;

    this.deps.conversationProjector.captureConversationEventFromRuntime(agentId, effectiveEvent);
    if (shouldSurfaceManualStopNotice) {
      this.deps.conversationProjector.emitConversationMessage({
        type: "conversation_message",
        agentId,
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
