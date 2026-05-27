import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openSessionManagerWithSizeGuard } from "../../session-file-guard.js";
import { transitionAgentStatus } from "../../agent-state-machine.js";
import { normalizeRuntimeError, normalizeRuntimeUserMessage } from "../runtime-utils.js";
import type {
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SmartCompactOptions,
  SmartCompactResult,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "../../runtime-contracts.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "../../types.js";
import type {
  CursorSdkAgent,
  CursorSdkAgentOptions,
  CursorSdkMcpServers,
  CursorSdkModelSelection,
  CursorSdkModule,
  CursorSdkRun
} from "./cursor-sdk-loader.js";
import { CursorSdkEventMapper } from "./cursor-sdk-event-mapper.js";
import {
  createCursorSdkBackgroundScope,
  CursorSdkContainedBackgroundError,
  type CursorSdkBackgroundScope,
  isCursorSdkTransientAuthConnectError
} from "./cursor-sdk-error-containment.js";
import {
  CURSOR_SDK_PROVIDER_ID,
  CURSOR_SDK_USAGE_ENTRY_TYPE,
  CURSOR_SDK_USAGE_SOURCE,
  type CursorSdkUsageOutcome,
  type CursorSdkUsageRecordV1,
  type CursorSdkUsageTotals,
  extractCursorSdkUsageFromDelta
} from "../../../utils/cursor-sdk-usage-records.js";

export const CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE = "swarm_cursor_sdk_runtime_state";
const SESSION_HEADER_VERSION = 3;
const MAX_PRE_OUTPUT_CURSOR_AUTH_RETRIES = 1;

interface CursorSdkRuntimeState {
  version: 1;
  sdkAgentId: string;
  model: { provider: "cursor-sdk"; modelId: string; thinkingLevel?: string };
  cwd: string;
  stateRoot: string;
  promptHash?: string;
  savedAt: string;
}

interface QueuedPrompt {
  deliveryId: string;
  message: RuntimeUserMessage;
}

interface ActivePromptState {
  token: number;
  message: RuntimeUserMessage;
  run?: CursorSdkRun;
  backgroundScope?: CursorSdkBackgroundScope;
  cancelled: boolean;
  visibleOutputEmitted: boolean;
  cursorUsage?: CursorSdkUsageTotals;
  usageRecorded: boolean;
  providerStatus?: string | null;
  runStatus?: string | null;
  waitStatus?: string | null;
  terminalStatus?: string | null;
  outcome?: CursorSdkUsageOutcome;
}

interface PreparedSendPayload {
  payload: string | { text: string; images?: Array<{ data: string; mimeType: string }> };
  consumesPromptInjection: boolean;
}

export class CursorSdkAgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType = "cursor-sdk" as const;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly model: CursorSdkModelSelection;
  private readonly systemPrompt: string;
  private readonly mcpServers: CursorSdkMcpServers;
  private readonly stateRoot: string;
  private readonly eventMapper: CursorSdkEventMapper;
  private readonly customEntries = new Map<string, Array<{ id: string; data: unknown }>>();
  private readonly queuedPrompts: QueuedPrompt[] = [];
  private readonly promptHash: string | undefined;

  private status: AgentStatus;
  private sdkAgent: CursorSdkAgent;
  private needsPromptInjection = true;
  private activePrompt: ActivePromptState | undefined;
  private promptDispatchPending = false;
  private stoppedPendingDispatch = false;
  private nextPromptToken = 0;
  private currentTurnReplayMessage: RuntimeUserMessage | undefined;
  private lastSessionEntryId: string | null = null;

  private constructor(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    sdk: CursorSdkModule;
    sdkAgent: CursorSdkAgent;
    apiKey: string;
    model: CursorSdkModelSelection;
    systemPrompt: string;
    mcpServers: CursorSdkMcpServers;
    stateRoot: string;
    promptHash?: string;
  }) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.sdkAgent = options.sdkAgent;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.mcpServers = options.mcpServers;
    this.stateRoot = options.stateRoot;
    this.promptHash = options.promptHash;
    this.status = options.descriptor.status;
    this.eventMapper = new CursorSdkEventMapper({
      debug: process.env.FORGE_DEBUG === "true",
      logDebug: (message, details) => this.logDebug(`event_mapper:${message}`, details)
    });

    const sessionManager = openSessionManagerWithSizeGuard(options.descriptor.sessionFile, {
      context: `runtime:create:cursor-sdk:${options.descriptor.agentId}`,
      rotateOversizedFile: true
    });
    if (!sessionManager) {
      throw new Error(`Unable to open session file for agent ${options.descriptor.agentId}: ${options.descriptor.sessionFile}`);
    }

    const existingEntries = typeof sessionManager.getEntries === "function" ? sessionManager.getEntries() : [];
    for (const entry of existingEntries) {
      this.lastSessionEntryId = entry.id;
      if (entry.type !== "custom") continue;
      const existing = this.customEntries.get(entry.customType) ?? [];
      existing.push({ id: entry.id, data: entry.data });
      this.customEntries.set(entry.customType, existing);
    }
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    sdk: CursorSdkModule;
    apiKey: string;
    model: CursorSdkModelSelection;
    systemPrompt: string;
    mcpServers: CursorSdkMcpServers;
    stateRoot: string;
    promptHash?: string;
  }): Promise<CursorSdkAgentRuntime> {
    if (!options.stateRoot.trim()) {
      throw new Error("Cursor SDK runtime requires a Forge-owned stateRoot.");
    }

    const persisted = readLatestRuntimeState(options.descriptor.sessionFile);
    const agentOptions: CursorSdkAgentOptions = {
      apiKey: options.apiKey,
      model: options.model,
      local: { cwd: options.descriptor.cwd, settingSources: [] },
      platform: { stateRoot: options.stateRoot, workspaceRef: options.descriptor.cwd },
      mcpServers: options.mcpServers,
      name: options.descriptor.displayName
    };

    let sdkAgent: CursorSdkAgent;
    if (persisted?.sdkAgentId) {
      try {
        sdkAgent = await options.sdk.Agent.resume(persisted.sdkAgentId, agentOptions);
      } catch {
        sdkAgent = await options.sdk.Agent.create(agentOptions);
      }
    } else {
      sdkAgent = await options.sdk.Agent.create(agentOptions);
    }

    const runtime = new CursorSdkAgentRuntime({ ...options, sdkAgent });
    runtime.persistRuntimeState();
    return runtime;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getPendingCount(): number {
    return this.queuedPrompts.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return undefined;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  async prepareForSpecialistFallbackReplay(): Promise<SpecialistFallbackReplaySnapshot | undefined> {
    const replayMessages = [
      ...(this.currentTurnReplayMessage ? [cloneRuntimeUserMessage(this.currentTurnReplayMessage)] : []),
      ...this.queuedPrompts.map((entry) => cloneRuntimeUserMessage(entry.message))
    ];
    return replayMessages.length > 0 ? { messages: replayMessages } : undefined;
  }

  async restorePreparedSpecialistFallbackReplay(): Promise<void> {
    // Replay snapshots are non-destructive.
  }

  async sendMessage(input: RuntimeUserMessageInput, _requestedMode: RequestedDeliveryMode = "auto"): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();
    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();

    if (this.activePrompt || this.promptDispatchPending) {
      this.queuedPrompts.push({ deliveryId, message });
      await this.emitStatus();
      return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "followUp" };
    }

    this.promptDispatchPending = true;
    this.currentTurnReplayMessage = cloneRuntimeUserMessage(message);
    this.schedulePromptDispatch(message);
    return { targetAgentId: this.descriptor.agentId, deliveryId, acceptedMode: "prompt" };
  }

  async compact(): Promise<unknown> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support manual compaction`);
  }

  async smartCompact(_customInstructions?: string, _options?: SmartCompactOptions): Promise<SmartCompactResult> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support smart compaction`);
  }

  async stopInFlight(): Promise<void> {
    this.queuedPrompts.length = 0;
    this.currentTurnReplayMessage = undefined;
    const active = this.activePrompt;
    if (active) {
      active.cancelled = true;
      active.backgroundScope?.markCancelled();
      if (active.run) {
        await active.run.cancel().catch(() => undefined);
      }
    } else if (this.promptDispatchPending) {
      this.stoppedPendingDispatch = true;
    }
    this.promptDispatchPending = false;
    if (this.status !== "terminated") {
      await this.updateStatus("idle");
    }
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.status === "terminated") return;
    if (options?.abort ?? true) {
      await this.stopInFlight();
    }
    this.sdkAgent.close();
    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  async shutdownForReplacement(): Promise<void> {
    this.assertIdleForReplacementShutdown();
    this.sdkAgent.close();
  }

  async recycle(): Promise<void> {
    this.assertIdleForReplacementShutdown();
    this.sdkAgent.close();
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.customEntries.get(customType) ?? [];
    return entries.map((entry) => entry.data);
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entryId = generateSessionEntryId();
    this.ensureSessionFileHeader();
    appendFileSync(this.descriptor.sessionFile, `${JSON.stringify({
      type: "custom",
      customType,
      data,
      id: entryId,
      parentId: this.lastSessionEntryId,
      timestamp: this.now()
    })}\n`, "utf8");

    const existing = this.customEntries.get(customType) ?? [];
    existing.push({ id: entryId, data });
    this.customEntries.set(customType, existing);
    this.lastSessionEntryId = entryId;
    return entryId;
  }

  private async dispatchPrompt(message: RuntimeUserMessage): Promise<void> {
    if (this.status === "terminated") {
      this.promptDispatchPending = false;
      this.currentTurnReplayMessage = undefined;
      return;
    }

    const token = ++this.nextPromptToken;
    const active: ActivePromptState = {
      token,
      message,
      cancelled: this.stoppedPendingDispatch,
      visibleOutputEmitted: false,
      usageRecorded: false
    };
    this.stoppedPendingDispatch = false;
    this.activePrompt = active;
    this.promptDispatchPending = true;
    this.currentTurnReplayMessage = cloneRuntimeUserMessage(message);

    const preparedPayload = this.prepareSendPayload(message);
    let attemptIndex = 0;
    let promptInjectionCommitted = false;

    try {
      await this.updateStatus("streaming");
      if (this.shouldAbortPromptBeforeSend(active, token)) {
        return;
      }

      await this.emitPromptSessionEvents(active, this.eventMapper.beginPrompt());
      if (this.shouldAbortPromptBeforeSend(active, token)) {
        return;
      }

      this.promptDispatchPending = false;
      while (attemptIndex <= MAX_PRE_OUTPUT_CURSOR_AUTH_RETRIES) {
        const backgroundScope = createCursorSdkBackgroundScope({
          agentId: this.descriptor.agentId,
          promptToken: token,
          startedAt: this.now(),
          sdkAgentId: this.sdkAgent.agentId,
          logDebug: (scopeMessage, details) => this.logDebug(scopeMessage, details)
        });
        active.backgroundScope = backgroundScope;

        try {
          if (this.shouldAbortPromptBeforeSend(active, token)) {
            return;
          }

          const run = await backgroundScope.runWithAttribution(() => this.raceContainedBackgroundFailure(
            backgroundScope,
            this.sdkAgent.send(preparedPayload.payload, {
              model: this.model,
              mcpServers: this.mcpServers,
              onDelta: ({ update }) => {
                try {
                  this.captureCursorUsageDelta(token, update);
                } catch (error) {
                  this.logDebug("cursor_usage:on_delta_capture:error", {
                    message: error instanceof Error ? error.message : String(error)
                  });
                }
              }
            })
          ));
          active.run = run;
          backgroundScope.update({ sdkAgentId: run.agentId ?? this.sdkAgent.agentId, runId: run.id });
          if (preparedPayload.consumesPromptInjection && !promptInjectionCommitted) {
            this.needsPromptInjection = false;
            promptInjectionCommitted = true;
          }
          if (this.shouldAbortPromptBeforeSend(active, token)) {
            await run.cancel().catch(() => undefined);
            return;
          }

          await backgroundScope.runWithAttribution(() => this.raceContainedBackgroundFailure(
            backgroundScope,
            this.streamCursorRun(active, token, run)
          ));
          this.captureCursorRunStatuses(active);

          if (!active.cancelled) {
            const waitResult = await backgroundScope.runWithAttribution(() => this.raceContainedBackgroundFailure(backgroundScope, run.wait()));
            active.waitStatus = readStatus(waitResult) ?? null;
            this.captureCursorRunStatuses(active);
            assertCursorRunSucceeded(run, waitResult, active.terminalStatus ?? undefined);
            freezeCursorUsageOutcome(active);
            await backgroundScope.runWithAttribution(() => this.raceContainedBackgroundFailure(
              backgroundScope,
              this.emitPromptSessionEvents(active, this.eventMapper.completePrompt())
            ));
            backgroundScope.markCompleted();
          }
          break;
        } catch (error) {
          this.captureCursorRunStatuses(active);
          await this.cancelActiveRun(active);
          if (this.shouldRetryPreOutputCursorAuthFailure(error, active, attemptIndex)) {
            this.logDebug("cursor_sdk:background_error_retrying", {
              agentId: this.descriptor.agentId,
              promptToken: token,
              runId: active.run?.id,
              sdkAgentId: active.run?.agentId ?? this.sdkAgent.agentId,
              errorName: extractCursorSdkErrorDetails(error)?.errorName,
              errorCode: extractCursorSdkErrorDetails(error)?.errorCode,
              source: extractCursorSdkErrorDetails(error)?.source,
              preOutput: true,
              attempt: `${attemptIndex + 1}/${MAX_PRE_OUTPUT_CURSOR_AUTH_RETRIES}`
            });
            attemptIndex += 1;
            this.resetRetryablePromptAttempt(active);
            continue;
          }

          freezeCursorUsageOutcome(active, active.cancelled ? undefined : "error");
          if (!active.cancelled) {
            await this.safeEmitRuntimeError(error, active);
          }
          break;
        } finally {
          backgroundScope.close();
          if (active.backgroundScope === backgroundScope) {
            active.backgroundScope = undefined;
          }
        }
      }
    } finally {
      this.captureCursorRunStatuses(active);
      freezeCursorUsageOutcome(active, active.outcome);
      this.persistCapturedCursorUsage(active);
      if (this.activePrompt?.token === token) {
        this.activePrompt = undefined;
      }
      this.promptDispatchPending = false;
      this.currentTurnReplayMessage = undefined;
      if (!this.isTerminated()) {
        await this.updateStatus("idle");
        await this.dispatchQueuedPrompts();
      }
    }
  }

  private shouldAbortPromptBeforeSend(active: ActivePromptState, token: number): boolean {
    return active.cancelled || this.activePrompt?.token !== token || this.isTerminated();
  }

  private captureCursorUsageDelta(token: number, update: unknown): void {
    const active = this.activePrompt;
    if (!active || active.token !== token) {
      return;
    }

    const usage = extractCursorSdkUsageFromDelta(update);
    if (!usage) {
      return;
    }

    if (active.cursorUsage) {
      this.logDebug("cursor_usage:on_delta_capture:duplicate", { updateType: "turn-ended", token });
      return;
    }

    active.cursorUsage = usage;
  }

  private captureCursorRunStatuses(active: ActivePromptState): void {
    active.terminalStatus = this.eventMapper.getTerminalStatus() ?? active.terminalStatus ?? null;
    active.providerStatus = active.terminalStatus ?? active.providerStatus ?? null;
    active.runStatus = readStatus(active.run) ?? active.runStatus ?? null;
  }

  private persistCapturedCursorUsage(active: ActivePromptState): void {
    if (!active.cursorUsage || active.usageRecorded) {
      return;
    }

    active.usageRecorded = true;
    const record: CursorSdkUsageRecordV1 = {
      version: 1,
      source: CURSOR_SDK_USAGE_SOURCE,
      provider: CURSOR_SDK_PROVIDER_ID,
      modelId: this.model.id,
      reasoningLevel: resolveCursorReasoningLevelSent(this.model),
      usage: { ...active.cursorUsage },
      sdkRunId: active.run?.id ?? null,
      sdkAgentId: active.run?.agentId ?? this.sdkAgent.agentId ?? null,
      providerStatus: active.providerStatus ?? null,
      runStatus: active.runStatus ?? null,
      waitStatus: active.waitStatus ?? null,
      terminalStatus: active.terminalStatus ?? null,
      outcome: active.outcome ?? deriveCursorUsageOutcome(active),
      capturedAt: this.now()
    };

    try {
      this.appendCustomEntry(CURSOR_SDK_USAGE_ENTRY_TYPE, record);
    } catch (error) {
      this.logDebug("cursor_usage:persist:error", {
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private prepareSendPayload(message: RuntimeUserMessage): PreparedSendPayload {
    const consumesPromptInjection = this.needsPromptInjection;
    const text = consumesPromptInjection ? wrapWithForgeSystemContext(this.systemPrompt, message.text) : message.text;
    const images = (message.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType }));
    return {
      payload: images.length > 0 ? { text, images } : text,
      consumesPromptInjection
    };
  }

  private async streamCursorRun(active: ActivePromptState, token: number, run: CursorSdkRun): Promise<void> {
    for await (const sdkMessage of run.stream()) {
      if (active.cancelled || this.activePrompt?.token !== token) {
        break;
      }
      await this.emitPromptSessionEvents(active, this.eventMapper.mapSdkMessage(sdkMessage));
    }
  }

  private async cancelActiveRun(active: ActivePromptState): Promise<void> {
    if (!active.run) {
      return;
    }
    await active.run.cancel().catch(() => undefined);
  }

  private resetRetryablePromptAttempt(active: ActivePromptState): void {
    active.run = undefined;
    active.cursorUsage = undefined;
    active.usageRecorded = false;
    active.providerStatus = undefined;
    active.runStatus = undefined;
    active.waitStatus = undefined;
    active.terminalStatus = undefined;
    active.outcome = undefined;
    active.visibleOutputEmitted = false;
    this.eventMapper.reset();
  }

  private shouldRetryPreOutputCursorAuthFailure(error: unknown, active: ActivePromptState, attemptIndex: number): boolean {
    return attemptIndex < MAX_PRE_OUTPUT_CURSOR_AUTH_RETRIES
      && !active.cancelled
      && !this.isTerminated()
      && !active.visibleOutputEmitted
      && isCursorSdkTransientAuthConnectError(error);
  }

  private async raceContainedBackgroundFailure<T>(scope: CursorSdkBackgroundScope, task: Promise<T>): Promise<T> {
    const taskOutcome = task.then(
      (value) => ({ type: "value" as const, value }),
      (error) => ({ type: "error" as const, error })
    );
    const outcome = await Promise.race([
      taskOutcome,
      scope.waitForContainedFailure().then((error) => ({ type: "background" as const, error }))
    ]);

    if (outcome.type === "value") {
      return outcome.value;
    }
    throw outcome.error;
  }

  private async emitRuntimeError(error: unknown, active?: ActivePromptState): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    await this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
      phase: "prompt_dispatch",
      message: normalized.message,
      stack: normalized.stack,
      details: extractCursorSdkErrorDetails(error, active, this.sdkAgent.agentId)
    });
  }

  private async safeEmitRuntimeError(error: unknown, active?: ActivePromptState): Promise<void> {
    try {
      await this.emitRuntimeError(error, active);
    } catch (callbackError) {
      this.logDebug("runtime_error_callback_failed", {
        originalMessage: error instanceof Error ? error.message : String(error),
        callbackMessage: callbackError instanceof Error ? callbackError.message : String(callbackError)
      });
    }
  }

  private async dispatchQueuedPrompts(): Promise<void> {
    if (this.activePrompt || this.promptDispatchPending || this.queuedPrompts.length === 0 || this.status === "terminated") {
      return;
    }
    const next = this.queuedPrompts.shift();
    if (!next) return;
    this.promptDispatchPending = true;
    this.currentTurnReplayMessage = cloneRuntimeUserMessage(next.message);
    this.schedulePromptDispatch(next.message);
  }

  private schedulePromptDispatch(message: RuntimeUserMessage): void {
    void this.dispatchPrompt(message).catch(async (error) => {
      await this.safeEmitRuntimeError(error);
      if (this.activePrompt === undefined) {
        this.promptDispatchPending = false;
        this.currentTurnReplayMessage = undefined;
        if (this.status !== "terminated") {
          await this.updateStatus("idle").catch(() => undefined);
          await this.dispatchQueuedPrompts().catch(() => undefined);
        }
      }
    });
  }

  private persistRuntimeState(): void {
    this.appendCustomEntry(CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE, {
      version: 1,
      sdkAgentId: this.sdkAgent.agentId,
      model: {
        provider: "cursor-sdk",
        modelId: this.descriptor.model.modelId,
        thinkingLevel: this.descriptor.model.thinkingLevel
      },
      cwd: this.descriptor.cwd,
      stateRoot: this.stateRoot,
      ...(this.promptHash ? { promptHash: this.promptHash } : {}),
      savedAt: this.now()
    } satisfies CursorSdkRuntimeState);
  }

  private async emitPromptSessionEvents(active: ActivePromptState, events: RuntimeSessionEvent[]): Promise<void> {
    for (const event of events) {
      if (isVisibleCursorPromptEvent(event)) {
        active.visibleOutputEmitted = true;
      }
      await this.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
      if (event.type === "agent_end") {
        await this.callbacks.onAgentEnd?.(this.descriptor.agentId);
      }
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    this.status = transitionAgentStatus(this.status, status);
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(this.descriptor.agentId, this.status, this.getPendingCount(), this.getContextUsage());
  }

  private ensureSessionFileHeader(): void {
    if (hasValidSessionHeader(this.descriptor.sessionFile)) {
      return;
    }

    writeFileSync(this.descriptor.sessionFile, `${JSON.stringify({
      type: "session",
      version: SESSION_HEADER_VERSION,
      id: generateSessionEntryId(),
      timestamp: this.now(),
      cwd: this.descriptor.cwd
    })}\n`, "utf8");
    this.lastSessionEntryId = null;
  }

  private assertIdleForReplacementShutdown(): void {
    if (this.status !== "idle" || this.promptDispatchPending || this.activePrompt || this.queuedPrompts.length > 0) {
      throw new Error(`Agent ${this.descriptor.agentId} runtime is not idle and cannot be recycled`);
    }
  }

  private ensureNotTerminated(): void {
    if (this.isTerminated()) {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private isTerminated(): boolean {
    return this.status === "terminated";
  }

  private logDebug(message: string, details?: unknown): void {
    if (process.env.FORGE_DEBUG === "true") {
      console.debug(`[cursor-sdk:${this.descriptor.agentId}] ${message}`, details ?? "");
    }
  }
}

function extractCursorSdkErrorDetails(
  error: unknown,
  active?: ActivePromptState,
  fallbackSdkAgentId?: string
): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const details: Record<string, unknown> = {
    source: error instanceof CursorSdkContainedBackgroundError ? "cursor_sdk_background" : "cursor_sdk_awaited"
  };

  if (error instanceof CursorSdkContainedBackgroundError) {
    if (error.errorName) {
      details.errorName = error.errorName;
    }
    if (error.errorCode !== undefined) {
      details.errorCode = error.errorCode;
    }
    if (error.runId ?? active?.run?.id) {
      details.runId = error.runId ?? active?.run?.id;
    }
    if (error.sdkAgentId ?? active?.run?.agentId ?? fallbackSdkAgentId) {
      details.sdkAgentId = error.sdkAgentId ?? active?.run?.agentId ?? fallbackSdkAgentId;
    }
    return details;
  }

  if (error instanceof Error) {
    const errorName = error.name && error.name !== "Error" ? error.name : error.constructor.name;
    if (errorName && errorName !== "Error") {
      details.errorName = errorName;
    }
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.trim().length > 0) {
    details.errorCode = code.trim();
  } else if (typeof code === "number" && Number.isFinite(code)) {
    details.errorCode = code;
  }

  if (active?.run?.id) {
    details.runId = active.run.id;
  }
  if (active?.run?.agentId ?? fallbackSdkAgentId) {
    details.sdkAgentId = active?.run?.agentId ?? fallbackSdkAgentId;
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function isVisibleCursorPromptEvent(event: RuntimeSessionEvent): boolean {
  return event.type === "message_start"
    || event.type === "message_update"
    || event.type === "message_end"
    || event.type === "tool_execution_start"
    || event.type === "tool_execution_end";
}

function resolveCursorReasoningLevelSent(model: CursorSdkModelSelection): string | null {
  const thinking = model.params?.find((param) => param.id === "thinking")?.value;
  return typeof thinking === "string" && thinking.trim().length > 0 ? thinking.trim() : null;
}

function freezeCursorUsageOutcome(active: ActivePromptState, fallback: CursorSdkUsageOutcome = "unknown"): CursorSdkUsageOutcome {
  if (active.outcome && active.outcome !== "unknown") {
    return active.outcome;
  }
  active.outcome = deriveCursorUsageOutcome(active, fallback);
  return active.outcome;
}

function deriveCursorUsageOutcome(active: ActivePromptState, fallback: CursorSdkUsageOutcome = "unknown"): CursorSdkUsageOutcome {
  const statuses = [active.providerStatus, active.runStatus, active.waitStatus, active.terminalStatus]
    .filter((status): status is string => typeof status === "string")
    .map((status) => status.trim().toLowerCase())
    .filter(Boolean);

  if (active.cancelled || statuses.includes("cancelled") || statuses.includes("canceled")) {
    return "cancelled";
  }

  if (statuses.some((status) => ["error", "failed", "failure", "expired"].includes(status))) {
    return "error";
  }

  if (fallback === "error") {
    return "error";
  }

  if (statuses.some((status) => ["finished", "success", "succeeded", "completed"].includes(status))) {
    return "completed";
  }

  return fallback;
}

function assertCursorRunSucceeded(run: CursorSdkRun, waitResult: unknown, terminalStatus: string | undefined): void {
  const terminal = terminalStatus?.trim().toUpperCase();
  if (terminal && terminal !== "FINISHED" && terminal !== "CANCELLED") {
    throw new Error(`Cursor SDK run failed with terminal status ${terminal}.`);
  }

  const waitStatus = readStatus(waitResult)?.trim().toLowerCase();
  if (waitStatus && !["finished", "success", "succeeded", "completed", "cancelled"].includes(waitStatus)) {
    throw new Error(`Cursor SDK run failed with wait status ${waitStatus}.`);
  }

  const runStatus = typeof run.status === "string" ? run.status.trim().toLowerCase() : undefined;
  if (runStatus && !["finished", "running", "cancelled"].includes(runStatus)) {
    throw new Error(`Cursor SDK run failed with status ${runStatus}.`);
  }
}

function readStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function readLatestRuntimeState(sessionFile: string): CursorSdkRuntimeState | undefined {
  const sessionManager = openSessionManagerWithSizeGuard(sessionFile, { context: "cursor-sdk:read-state" });
  const entries = typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === CURSOR_SDK_RUNTIME_STATE_ENTRY_TYPE && isCursorSdkRuntimeState(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

function isCursorSdkRuntimeState(value: unknown): value is CursorSdkRuntimeState {
  return !!value && typeof value === "object" && (value as { version?: unknown }).version === 1 && typeof (value as { sdkAgentId?: unknown }).sdkAgentId === "string";
}

function wrapWithForgeSystemContext(systemPrompt: string, userMessage: string): string {
  return `<forge_system_context>\n${systemPrompt}\n</forge_system_context>\n\n<forge_user_message>\n${userMessage}\n</forge_user_message>`;
}

function cloneRuntimeUserMessage(message: RuntimeUserMessage): RuntimeUserMessage {
  return { text: message.text, images: message.images?.map((image) => ({ ...image })) ?? [] };
}

function generateSessionEntryId(): string {
  return `evt_${randomUUID()}`;
}

function hasValidSessionHeader(sessionFile: string): boolean {
  try {
    const firstLine = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0];
    if (!firstLine) {
      return false;
    }
    const parsed = JSON.parse(firstLine) as { type?: unknown };
    return parsed.type === "session";
  } catch {
    return false;
  }
}

export function getDefaultCursorSdkStateRoot(descriptor: AgentDescriptor): string {
  return join(dirname(descriptor.sessionFile), "cursor-sdk-state", descriptor.agentId);
}
