import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  extractClaudeContextUsage,
  isPlausibleContextUsage,
  normalizeOptionalString,
  readBoolean,
  readFiniteNumber,
  readObject
} from "../../claude-utils.js";
import type {
  ClaudeSdkMessage,
  ClaudeSdkModule,
  ClaudeSdkQueryHandle,
  ClaudeSdkQueryOptions,
  ClaudeSdkUserMessage
} from "../../claude-sdk-loader.js";
import { ClaudeEventMapper } from "../../claude-event-mapper.js";
import { presentClaudeSdkStartupFailure } from "../../claude-startup-errors.js";
import { normalizeRuntimeError, normalizeRuntimeUserMessage } from "../../runtime-utils.js";
import type {
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SwarmRuntimeCallbacks
} from "../../runtime-contracts.js";
import type { AgentContextUsage, AgentStatus, RequestedDeliveryMode, SendMessageReceipt } from "../../types.js";

export type DeliveryMode = RequestedDeliveryMode;

export type ClaudeThinkingConfig =
  | {
      type: "adaptive";
    }
  | {
      type: "enabled";
      budgetTokens?: number;
    }
  | {
      type: "disabled";
    };

export type ClaudeEffort = "low" | "medium" | "high" | "max";

export interface ClaudeQuerySessionCallbacks extends Omit<SwarmRuntimeCallbacks, "onSessionEvent"> {
  agentId: string;
  onSessionEvent: (event: RuntimeSessionEvent) => void | Promise<void>;
  onSessionIdChange?: (sessionId: string) => void | Promise<void>;
}

export interface ClaudeQuerySessionOptions {
  sdk: ClaudeSdkModule;
  config: {
    model: string;
    systemPrompt: string;
    cwd: string;
    contextWindow?: number;
    autoCompactWindow?: number;
    thinking?: ClaudeThinkingConfig;
    effort?: ClaudeEffort;
    env?: Record<string, string>;
  };
  callbacks: ClaudeQuerySessionCallbacks;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  resumeSessionId?: string;
  startupTimeoutMs?: number;
}

type InternalSessionStatus =
  | "starting"
  | "idle"
  | "busy"
  | "interrupting"
  | "stopping"
  | "stopped"
  | "terminated"
  | "error";

type AcceptedDeliveryMode = SendMessageReceipt["acceptedMode"];

type PendingInput = {
  deliveryId: string;
  message: RuntimeUserMessage;
  acceptedMode: Exclude<AcceptedDeliveryMode, "prompt">;
  requestedMode: DeliveryMode;
};

type ActiveTurn = {
  deliveryId: string;
  completion: Deferred<void>;
};

type ClaudeSdkInputContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    };

type ClaudeInputIteratorResult = IteratorResult<ClaudeSdkUserMessage, void>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
};

type EmittedStatusSnapshot = {
  status: AgentStatus;
  pendingCount: number;
  contextUsage?: AgentContextUsage;
  internalStatus: InternalSessionStatus;
};

const MAX_CLAUDE_STDERR_LINES = 20;
const MAX_CLAUDE_STDERR_SUMMARY_LINES = 3;
const DEFAULT_CLAUDE_STARTUP_TIMEOUT_MS = 30_000;
const CLAUDE_SDK_STRIPPED_INHERITED_ENV_KEYS = new Set(["ANTHROPIC_API_KEY"]);
const CLAUDE_SDK_IGNORED_OVERRIDE_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]);

export class ClaudeQuerySession {
  private readonly mapper = new ClaudeEventMapper();
  private readonly startupReady = createDeferred<void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly shutdownComplete = createDeferred<void>();
  private readonly abortController = new AbortController();
  private readonly sessionId: string;

  private internalStatus: InternalSessionStatus = "starting";
  private queryHandle: ClaudeSdkQueryHandle | undefined;
  private consumePromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private interruptPromise: Promise<void> | undefined;
  private inputQueue: ClaudeSdkUserMessage[] = [];
  private inputResolver: ((value: ClaudeInputIteratorResult) => void) | null = null;
  private inputClosed = false;
  private queuedInputs: PendingInput[] = [];
  private queuedSteers: PendingInput[] = [];
  private activeTurn: ActiveTurn | undefined;
  private currentTurnToolResults: unknown[] = [];
  private sdkSessionId: string | undefined;
  private sdkCompactionInProgress = false;
  private lastContextUsage: AgentContextUsage | undefined;
  private sawPlausibleContextUsageThisTurn = false;
  private lastEmittedStatus: EmittedStatusSnapshot | undefined;
  private recentStderrLines: string[] = [];
  private pendingStderr = "";
  private stopRequested = false;
  private terminateRequested = false;
  private disposeRequested = false;
  private fatalError: Error | undefined;
  private fatalErrorHandled = false;
  private shutdownStarted = false;

  constructor(private readonly options: ClaudeQuerySessionOptions) {
    const resumeSessionId = normalizeOptionalString(options.resumeSessionId);
    this.sessionId = resumeSessionId ?? randomUUID();
    this.sdkSessionId = resumeSessionId ?? this.sessionId;
  }

  getStatus(): AgentStatus {
    return mapInternalStatusToAgentStatus(
      this.internalStatus,
      Boolean(this.activeTurn),
      this.sdkCompactionInProgress
    );
  }

  getPendingCount(): number {
    return this.queuedInputs.length + this.queuedSteers.length;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.lastContextUsage;
  }

  async getSdkContextUsage(): Promise<unknown> {
    await this.start();
    return await this.queryHandle?.getContextUsage?.();
  }

  async refreshContextUsageFromSdk(): Promise<AgentContextUsage | undefined> {
    await this.start();

    if (!this.queryHandle?.getContextUsage) {
      return this.lastContextUsage;
    }

    try {
      const response = readObject(await this.queryHandle.getContextUsage());
      const nextUsage = deriveSdkContextUsage(response);
      if (!nextUsage) {
        return this.lastContextUsage;
      }

      if (areContextUsagesEqual(this.lastContextUsage, nextUsage)) {
        return this.lastContextUsage;
      }

      this.lastContextUsage = nextUsage;
      await this.emitStatus();
      return this.lastContextUsage;
    } catch {
      return this.lastContextUsage;
    }
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    await this.start();
    await this.queryHandle?.applyFlagSettings?.(settings);
  }

  getSdkSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  async start(): Promise<void> {
    if (this.startPromise) {
      return await this.startPromise;
    }

    this.startPromise = this.startInternal();
    return await this.startPromise;
  }

  async sendInput(
    input: RuntimeUserMessageInput,
    delivery: DeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    await this.start();
    this.ensureUsable();

    const normalizedMessage = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();
    const normalizedDelivery = normalizeRequestedDelivery(delivery);

    if (this.isTurnActive()) {
      const queued = this.queueInputWhileBusy(deliveryId, normalizedMessage, normalizedDelivery);
      await this.emitStatus();

      if (queued.acceptedMode === "steer") {
        await this.requestInterrupt();
      }

      return {
        targetAgentId: this.options.callbacks.agentId,
        deliveryId,
        acceptedMode: queued.acceptedMode
      };
    }

    if (this.internalStatus === "idle") {
      await this.dispatchInput({
        deliveryId,
        message: normalizedMessage,
        acceptedMode: normalizedDelivery === "followUp" ? "prompt" : "prompt",
        requestedMode: normalizedDelivery
      });

      return {
        targetAgentId: this.options.callbacks.agentId,
        deliveryId,
        acceptedMode: "prompt"
      };
    }

    if (this.internalStatus === "starting") {
      this.queuedInputs.push({
        deliveryId,
        message: normalizedMessage,
        acceptedMode: normalizedDelivery === "steer" ? "steer" : "followUp",
        requestedMode: normalizedDelivery
      });
      await this.emitStatus();
      return {
        targetAgentId: this.options.callbacks.agentId,
        deliveryId,
        acceptedMode: normalizedDelivery === "steer" ? "steer" : "followUp"
      };
    }

    throw new Error(`Claude query session cannot accept input while ${this.internalStatus}.`);
  }

  async interrupt(): Promise<void> {
    this.ensureUsable();

    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      return;
    }

    await this.requestInterrupt();
    await activeTurn.completion.promise;
  }

  async stop(): Promise<void> {
    await this.shutdown("stopped", true);
  }

  async terminate(): Promise<void> {
    await this.shutdown("terminated", true);
  }

  async dispose(): Promise<void> {
    await this.shutdown(this.terminateRequested ? "terminated" : "stopped", false);
  }

  async waitForIdle(): Promise<void> {
    if (this.isIdleNow()) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  private async startInternal(): Promise<void> {
    if (this.queryHandle) {
      return await this.startupReady.promise;
    }

    await this.emitStatus(true);

    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_CLAUDE_STARTUP_TIMEOUT_MS;

    try {
      const queryOptions = this.buildQueryOptions();
      const queryHandle = this.options.sdk.query({
        prompt: this.createInputStream(),
        options: queryOptions
      });

      this.queryHandle = queryHandle;
      this.consumePromise = this.consumeEvents(queryHandle);

      const initializationReady = queryHandle.initializationResult?.();
      const startupSignals: Array<Promise<void>> = [this.startupReady.promise];

      if (initializationReady) {
        startupSignals.push(
          Promise.resolve(initializationReady).then(async () => {
            if (!this.startupReady.settled) {
              if (this.internalStatus === "starting" && !this.activeTurn) {
                await this.setInternalStatus("idle");
              }

              this.startupReady.resolve();
            }
          })
        );
      }

      await withTimeout(Promise.race(startupSignals), startupTimeoutMs, "claude_startup");
      await this.maybeDispatchQueuedInput();
      await this.startupReady.promise;
    } catch (error) {
      const enrichedError = this.enrichError(error);
      const presentation = presentClaudeSdkStartupFailure({
        error: enrichedError,
        stderrLines: this.getRecentStderr(),
        timeoutMs: startupTimeoutMs
      });
      const reportedError = presentation.userFacingMessage
        ? new Error(presentation.userFacingMessage)
        : enrichedError;

      await this.handleFatalError("startup", reportedError, {
        model: this.options.config.model,
        cwd: path.resolve(this.options.config.cwd),
        technicalMessage: presentation.technicalMessage,
        ...(presentation.userFacingMessage ? { userFacingMessage: presentation.userFacingMessage } : {}),
        ...(presentation.isAuthFailure ? { claudeSdkAuthRequired: true } : {}),
        ...(presentation.isStartupTimeout ? { claudeSdkStartupTimeoutMs: startupTimeoutMs } : {})
      });
      throw reportedError;
    }
  }

  private buildQueryOptions(): ClaudeSdkQueryOptions {
    const queryOptions: ClaudeSdkQueryOptions = {
      cwd: path.resolve(this.options.config.cwd),
      model: this.options.config.model,
      systemPrompt: this.options.config.systemPrompt,
      sessionId: this.sessionId,
      persistSession: true,
      includePartialMessages: true,
      permissionMode: "acceptEdits",
      allowDangerouslySkipPermissions: true,
      settingSources: []
    };

    if (this.options.resumeSessionId) {
      queryOptions.resume = this.options.resumeSessionId;
    }

    if (this.options.config.thinking) {
      queryOptions.thinking = this.options.config.thinking;
    }

    if (this.options.config.effort) {
      queryOptions.effort = this.options.config.effort;
    }

    if (
      typeof this.options.config.autoCompactWindow === "number"
      && Number.isFinite(this.options.config.autoCompactWindow)
      && this.options.config.autoCompactWindow > 0
    ) {
      queryOptions.settings = {
        autoCompactWindow: Math.floor(this.options.config.autoCompactWindow)
      };
    }

    if (this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0) {
      queryOptions.mcpServers = this.options.mcpServers;
    }

    // Treat runtime env as overrides, not a full replacement, so Claude keeps the
    // inherited PATH/HOME/TMPDIR/ELECTRON_RUN_AS_NODE needed to launch cli.js.
    // Strip inherited ANTHROPIC_API_KEY so the SDK can follow Claude Code's native
    // OAuth resolution path, and ignore runtime attempts to override
    // CLAUDE_CONFIG_DIR so existing Claude Code auth storage remains discoverable.
    queryOptions.env = buildClaudeSdkEnv(this.options.config.env);

    if (this.options.allowedTools && this.options.allowedTools.length > 0) {
      queryOptions.allowedTools = this.options.allowedTools;
    }

    if (this.options.sdk.pathToClaudeCodeExecutable) {
      queryOptions.pathToClaudeCodeExecutable = this.options.sdk.pathToClaudeCodeExecutable;
    }

    if (this.options.sdk.jsRuntimeExecutable) {
      queryOptions.executable = this.options.sdk.jsRuntimeExecutable;
    }

    queryOptions.abortController = this.abortController;
    queryOptions.stderr = (data: string) => {
      this.captureStderr(data);
    };

    return queryOptions;
  }

  private async consumeEvents(queryHandle: ClaudeSdkQueryHandle): Promise<void> {
    try {
      for await (const event of queryHandle) {
        await this.captureSessionId(event);
        await this.captureContextUsage(event);
        await this.captureRawCompactionStatus(event);

        if (isClaudeInitEvent(event)) {
          if (this.internalStatus === "starting" && !this.activeTurn) {
            await this.setInternalStatus("idle");
          }

          if (!this.startupReady.settled) {
            this.startupReady.resolve();
          }
        }

        const mappedEvents = this.mapper.mapEvent(event, {
          agentId: this.options.callbacks.agentId,
          turnId: this.activeTurn?.deliveryId,
          status: this.getStatus()
        });

        for (const mappedEvent of mappedEvents) {
          await this.forwardMappedEvent(mappedEvent);
        }

        if (this.activeTurn && isPlausibleContextUsage(this.mapper.getContextUsage())) {
          this.sawPlausibleContextUsageThisTurn = true;
        }

        if (isClaudeCompactBoundaryEvent(event)) {
          const refreshedUsage = await this.refreshContextUsageFromSdk();
          if (isPlausibleContextUsage(refreshedUsage)) {
            this.sawPlausibleContextUsageThisTurn = true;
          }
        }

        if (isClaudeResultEvent(event)) {
          if (!this.sawPlausibleContextUsageThisTurn || !isPlausibleContextUsage(this.getContextUsage())) {
            await this.refreshContextUsageFromSdk();
          }
          await this.handleTurnCompleted();
        }
      }

      if (!this.stopRequested && !this.terminateRequested && !this.disposeRequested) {
        throw new Error("Claude query stream ended unexpectedly.");
      }
    } catch (error) {
      if (this.stopRequested || this.terminateRequested || this.disposeRequested) {
        return;
      }

      const enrichedError = this.enrichError(error);
      await this.handleFatalError("runtime_exit", enrichedError, {
        activeTurnId: this.activeTurn?.deliveryId,
        model: this.options.config.model
      });
    }
  }

  private async forwardMappedEvent(event: RuntimeSessionEvent): Promise<void> {
    await this.updateCompactionStateForEvent(event);

    switch (event.type) {
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
        return;

      case "tool_execution_end":
        this.currentTurnToolResults.push({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError
        });
        await this.emitSessionEvent(event);
        return;

      default:
        await this.emitSessionEvent(event);
    }
  }

  private async handleTurnCompleted(): Promise<void> {
    const completedTurn = this.activeTurn;
    if (!completedTurn) {
      return;
    }

    this.activeTurn = undefined;
    this.sawPlausibleContextUsageThisTurn = false;
    completedTurn.completion.resolve();

    const toolResults = [...this.currentTurnToolResults];
    this.currentTurnToolResults = [];

    await this.emitSessionEvent({
      type: "turn_end",
      toolResults
    });
    await this.emitSessionEvent({ type: "agent_end" });

    if (this.stopRequested || this.terminateRequested || this.disposeRequested) {
      this.settleWaitersIfIdle();
      return;
    }

    const nextPending = this.dequeueNextPendingInput();
    if (nextPending) {
      await this.dispatchInput(nextPending);
      return;
    }

    await this.setInternalStatus("idle");
    await this.notifyAgentEnd();
  }

  private async dispatchInput(input: {
    deliveryId: string;
    message: RuntimeUserMessage;
    acceptedMode: AcceptedDeliveryMode;
    requestedMode: DeliveryMode;
  }): Promise<void> {
    this.ensureUsable();

    if (input.acceptedMode !== "prompt" && input.acceptedMode !== "followUp" && input.acceptedMode !== "steer") {
      throw new Error(`Unsupported Claude delivery mode: ${input.acceptedMode}`);
    }

    try {
      this.currentTurnToolResults = [];
      this.sawPlausibleContextUsageThisTurn = false;
      this.activeTurn = {
        deliveryId: input.deliveryId,
        completion: createDeferred<void>()
      };

      await this.emitSessionEvent({ type: "agent_start" });
      await this.emitSessionEvent({ type: "turn_start" });
      await this.setInternalStatus("busy");
      this.pushInput(toClaudeUserMessage(input.message, this.sdkSessionId));
    } catch (error) {
      const normalized = normalizeRuntimeError(this.enrichError(error));
      if (this.activeTurn) {
        this.activeTurn.completion.reject(normalized.message);
        this.activeTurn = undefined;
      }
      this.currentTurnToolResults = [];
      await this.handleFatalError("prompt_dispatch", new Error(normalized.message), {
        deliveryId: input.deliveryId,
        requestedMode: input.requestedMode,
        textLength: input.message.text.length,
        imageCount: input.message.images?.length ?? 0
      });
      throw new Error(normalized.message);
    }
  }

  private queueInputWhileBusy(
    deliveryId: string,
    message: RuntimeUserMessage,
    delivery: DeliveryMode
  ): PendingInput {
    const queued: PendingInput = {
      deliveryId,
      message,
      acceptedMode: delivery === "steer" ? "steer" : "followUp",
      requestedMode: delivery
    };

    if (queued.acceptedMode === "steer") {
      this.queuedSteers.push(queued);
      return queued;
    }

    this.queuedInputs.push(queued);
    return queued;
  }

  private dequeueNextPendingInput(): PendingInput | undefined {
    if (this.queuedSteers.length > 0) {
      return this.queuedSteers.shift();
    }

    return this.queuedInputs.shift();
  }

  private async maybeDispatchQueuedInput(): Promise<void> {
    if (this.internalStatus !== "idle" || this.activeTurn) {
      return;
    }

    const nextPending = this.dequeueNextPendingInput();
    if (!nextPending) {
      this.settleWaitersIfIdle();
      return;
    }

    await this.dispatchInput(nextPending);
  }

  private createInputStream(): AsyncIterable<ClaudeSdkUserMessage> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<ClaudeInputIteratorResult> => {
          if (this.inputQueue.length > 0) {
            const next = this.inputQueue.shift();
            if (!next) {
              return createDoneIteratorResult();
            }

            return {
              value: next,
              done: false
            };
          }

          if (this.inputClosed) {
            return createDoneIteratorResult();
          }

          return await new Promise<ClaudeInputIteratorResult>((resolve) => {
            this.inputResolver = resolve;
          });
        },
        return: async (): Promise<ClaudeInputIteratorResult> => {
          this.finishInput();
          return createDoneIteratorResult();
        }
      })
    };
  }

  private pushInput(message: ClaudeSdkUserMessage): void {
    if (this.inputClosed) {
      throw new Error("Claude query input stream is already closed.");
    }

    if (this.inputResolver) {
      const resolve = this.inputResolver;
      this.inputResolver = null;
      resolve({
        value: message,
        done: false
      });
      return;
    }

    this.inputQueue.push(message);
  }

  private finishInput(): void {
    if (this.inputClosed) {
      return;
    }

    this.inputClosed = true;

    if (!this.inputResolver) {
      return;
    }

    const resolve = this.inputResolver;
    this.inputResolver = null;
    resolve(createDoneIteratorResult());
  }

  private async requestInterrupt(): Promise<void> {
    if (!this.queryHandle || !this.activeTurn) {
      return;
    }

    if (this.interruptPromise) {
      await this.interruptPromise;
      return;
    }

    this.interruptPromise = (async () => {
      await this.setInternalStatus("interrupting");
      await this.queryHandle?.interrupt();
    })()
      .catch(async (error) => {
        const enrichedError = this.enrichError(error);
        await this.handleFatalError("interrupt", enrichedError, {
          activeTurnId: this.activeTurn?.deliveryId
        });
        throw enrichedError;
      })
      .finally(() => {
        this.interruptPromise = undefined;
      });

    await this.interruptPromise;
  }

  private async shutdown(target: "stopped" | "terminated", emitFinalStatus: boolean): Promise<void> {
    if (this.shutdownStarted) {
      await this.shutdownComplete.promise;
      return;
    }

    this.shutdownStarted = true;
    this.stopRequested = target === "stopped";
    this.terminateRequested = target === "terminated";
    this.disposeRequested = !emitFinalStatus;

    this.queuedInputs = [];
    this.queuedSteers = [];
    this.internalStatus = "stopping";
    await this.emitStatus(true);

    try {
      if (this.activeTurn) {
        try {
          await this.queryHandle?.interrupt();
        } catch {
          // Best-effort interruption during shutdown.
        }
      }

      this.finishInput();

      try {
        await this.queryHandle?.return?.();
      } catch {
        // Best-effort iterator teardown.
      }

      this.abortController.abort();
      this.queryHandle?.close?.();

      await this.consumePromise?.catch(() => {
        // Ignore stream teardown errors during shutdown.
      });
    } finally {
      if (this.activeTurn) {
        this.activeTurn.completion.resolve();
        this.activeTurn = undefined;
      }

      this.currentTurnToolResults = [];
      this.sdkCompactionInProgress = false;

      if (emitFinalStatus) {
        await this.setInternalStatus(target);
      } else {
        this.settleWaitersIfIdle();
      }

      this.shutdownComplete.resolve();
    }
  }

  private ensureUsable(): void {
    if (this.stopRequested || this.internalStatus === "stopped") {
      throw new Error("Claude query session is stopped.");
    }

    if (this.terminateRequested || this.internalStatus === "terminated") {
      throw new Error("Claude query session is terminated.");
    }

    if (this.internalStatus === "error") {
      throw this.fatalError ?? new Error("Claude query session is in an error state.");
    }
  }

  private isTurnActive(): boolean {
    return (
      Boolean(this.activeTurn)
      || this.internalStatus === "busy"
      || this.internalStatus === "interrupting"
      || this.sdkCompactionInProgress
    );
  }

  private isIdleNow(): boolean {
    return (
      !this.activeTurn &&
      !this.sdkCompactionInProgress &&
      this.getPendingCount() === 0 &&
      (this.internalStatus === "idle" ||
        this.internalStatus === "stopped" ||
        this.internalStatus === "terminated" ||
        this.internalStatus === "error")
    );
  }

  private async setInternalStatus(nextStatus: InternalSessionStatus): Promise<void> {
    this.internalStatus = nextStatus;
    await this.emitStatus(true);
    this.settleWaitersIfIdle();
  }

  private async emitStatus(force = false): Promise<void> {
    const nextSnapshot: EmittedStatusSnapshot = {
      status: this.getStatus(),
      pendingCount: this.getPendingCount(),
      contextUsage: this.lastContextUsage,
      internalStatus: this.internalStatus
    };

    if (!force && areStatusSnapshotsEqual(this.lastEmittedStatus, nextSnapshot)) {
      return;
    }

    this.lastEmittedStatus = cloneStatusSnapshot(nextSnapshot);
    await this.options.callbacks.onStatusChange(
      this.options.callbacks.agentId,
      nextSnapshot.status,
      nextSnapshot.pendingCount,
      nextSnapshot.contextUsage
    );
  }

  private settleWaitersIfIdle(): void {
    if (!this.isIdleNow()) {
      return;
    }

    for (const resolve of this.idleWaiters) {
      resolve();
    }

    this.idleWaiters.clear();
  }

  private async emitSessionEvent(event: RuntimeSessionEvent): Promise<void> {
    await this.options.callbacks.onSessionEvent(event);
  }

  private async updateCompactionStateForEvent(event: RuntimeSessionEvent): Promise<void> {
    if (event.type === "auto_compaction_start") {
      if (this.sdkCompactionInProgress) {
        return;
      }

      this.sdkCompactionInProgress = true;
      await this.emitStatus();
      return;
    }

    if (event.type === "auto_compaction_end") {
      if (!this.sdkCompactionInProgress) {
        return;
      }

      this.sdkCompactionInProgress = false;
      await this.emitStatus();
    }
  }

  private async notifyAgentEnd(): Promise<void> {
    if (!this.options.callbacks.onAgentEnd) {
      return;
    }

    try {
      await this.options.callbacks.onAgentEnd(this.options.callbacks.agentId);
    } catch (error) {
      await this.reportRuntimeError({
        phase: "runtime_exit",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        details: {
          callback: "onAgentEnd"
        }
      });
    }
  }

  private async handleFatalError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): Promise<void> {
    if (this.fatalErrorHandled) {
      return;
    }

    this.fatalErrorHandled = true;
    const normalized = normalizeRuntimeError(error);
    const enrichedError = this.enrichError(error);
    const hadActiveTurn = Boolean(this.activeTurn);
    const toolResults = [...this.currentTurnToolResults];
    this.fatalError = enrichedError;

    if (!this.startupReady.settled) {
      this.startupReady.reject(enrichedError);
    }

    if (this.activeTurn) {
      this.activeTurn.completion.resolve();
      this.activeTurn = undefined;
    }

    this.queuedInputs = [];
    this.queuedSteers = [];
    this.currentTurnToolResults = [];
    this.sdkCompactionInProgress = false;
    this.finishInput();
    this.abortController.abort();
    this.queryHandle?.close?.();

    await this.reportRuntimeError({
      phase,
      message: normalized.message,
      stack: normalized.stack,
      details
    });

    if (hadActiveTurn) {
      await this.emitSessionEvent({
        type: "turn_end",
        toolResults
      });
      await this.emitSessionEvent({ type: "agent_end" });
      await this.notifyAgentEnd();
    }

    await this.setInternalStatus("error");
    this.settleWaitersIfIdle();
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.options.callbacks.onRuntimeError) {
      return;
    }

    await this.options.callbacks.onRuntimeError(this.options.callbacks.agentId, error);
  }

  private async captureSessionId(event: ClaudeSdkMessage): Promise<void> {
    const sessionId = extractClaudeSessionId(event);
    if (!sessionId) {
      return;
    }

    const changed = sessionId !== this.sdkSessionId;
    this.sdkSessionId = sessionId;

    if (changed) {
      await this.options.callbacks.onSessionIdChange?.(sessionId);
    }
  }

  private async captureContextUsage(event: ClaudeSdkMessage): Promise<void> {
    const nextUsage = extractClaudeContextUsage(
      event,
      this.options.config.model,
      this.options.config.contextWindow
    );
    if (!nextUsage || areContextUsagesEqual(this.lastContextUsage, nextUsage)) {
      return;
    }

    this.lastContextUsage = nextUsage;
    await this.emitStatus();
  }

  private async captureRawCompactionStatus(event: ClaudeSdkMessage): Promise<void> {
    if (
      normalizeOptionalString((event as { type?: unknown }).type) !== "system"
      || normalizeOptionalString((event as { subtype?: unknown }).subtype) !== "status"
      || !Object.prototype.hasOwnProperty.call(event, "status")
      || (event as { status?: unknown }).status !== null
      || !this.sdkCompactionInProgress
    ) {
      return;
    }

    this.sdkCompactionInProgress = false;
    await this.emitStatus();
  }

  private captureStderr(data: string): void {
    if (!data) {
      return;
    }

    const combined = `${this.pendingStderr}${data}`;
    const lines = combined.split(/\r?\n/u);
    this.pendingStderr = lines.pop() ?? "";

    for (const line of lines) {
      const normalizedLine = line.trim();
      if (!normalizedLine) {
        continue;
      }

      this.recentStderrLines.push(normalizedLine);
      if (this.recentStderrLines.length > MAX_CLAUDE_STDERR_LINES) {
        this.recentStderrLines.shift();
      }
    }
  }

  private enrichError(error: unknown): Error {
    return enrichClaudeError(error, this.getRecentStderr());
  }

  private getRecentStderr(): string[] {
    if (this.pendingStderr.trim()) {
      this.recentStderrLines.push(this.pendingStderr.trim());
      this.pendingStderr = "";
      if (this.recentStderrLines.length > MAX_CLAUDE_STDERR_LINES) {
        this.recentStderrLines.splice(0, this.recentStderrLines.length - MAX_CLAUDE_STDERR_LINES);
      }
    }

    return [...this.recentStderrLines];
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  void promise.catch(() => {
    // Suppress unhandled rejections; owners await or probe deferred state later.
  });

  const deferred: Deferred<T> = {
    promise,
    resolve(value: T) {
      if (deferred.settled) {
        return;
      }

      deferred.settled = true;
      resolvePromise(value);
    },
    reject(error: unknown) {
      if (deferred.settled) {
        return;
      }

      deferred.settled = true;
      rejectPromise(error);
    },
    settled: false
  };

  return deferred;
}

function normalizeRequestedDelivery(delivery: DeliveryMode): DeliveryMode {
  switch (delivery) {
    case "followUp":
    case "steer":
      return delivery;
    case "auto":
    default:
      return "auto";
  }
}

function mapInternalStatusToAgentStatus(
  status: InternalSessionStatus,
  hasActiveTurn: boolean,
  sdkCompactionInProgress: boolean
): AgentStatus {
  if (sdkCompactionInProgress) {
    return "streaming";
  }

  switch (status) {
    case "busy":
    case "interrupting":
      return "streaming";
    case "terminated":
      return "terminated";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    case "starting":
    case "stopping":
      return hasActiveTurn ? "streaming" : "idle";
    case "idle":
    default:
      return "idle";
  }
}

function toClaudeUserMessage(message: RuntimeUserMessage, sessionId?: string): ClaudeSdkUserMessage {
  const blocks: ClaudeSdkInputContent[] = [];
  const normalizedText = typeof message.text === "string" ? message.text : "";
  const normalizedImages = message.images ?? [];

  if (normalizedText.length > 0 || normalizedImages.length === 0) {
    blocks.push({
      type: "text",
      text: normalizedText
    });
  }

  for (const image of normalizedImages) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data
      }
    });
  }

  const content = blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks;

  return {
    type: "user",
    ...(sessionId ? { session_id: sessionId } : {}),
    parent_tool_use_id: null,
    message: {
      role: "user",
      content
    }
  };
}

function createDoneIteratorResult(): ClaudeInputIteratorResult {
  return {
    value: undefined,
    done: true
  };
}

function extractClaudeSessionId(event: ClaudeSdkMessage): string | undefined {
  const directSessionId = normalizeOptionalString((event as { session_id?: unknown }).session_id);
  if (directSessionId) {
    return directSessionId;
  }

  const camelSessionId = normalizeOptionalString((event as { sessionId?: unknown }).sessionId);
  if (camelSessionId) {
    return camelSessionId;
  }

  const sessionObject = readObject((event as { session?: unknown }).session);
  return normalizeOptionalString(sessionObject?.id);
}

function isClaudeInitEvent(event: ClaudeSdkMessage): boolean {
  const type = normalizeOptionalString((event as { type?: unknown }).type);
  const subtype = normalizeOptionalString((event as { subtype?: unknown }).subtype);
  return type === "system:init" || (type === "system" && subtype === "init") || type === "init";
}

function isClaudeResultEvent(event: ClaudeSdkMessage): boolean {
  const type = normalizeOptionalString((event as { type?: unknown }).type);
  const subtype = normalizeOptionalString((event as { subtype?: unknown }).subtype);
  return type === "result" || (type === "system" && subtype === "result");
}

function isClaudeCompactBoundaryEvent(event: ClaudeSdkMessage): boolean {
  const type = normalizeOptionalString((event as { type?: unknown }).type);
  const subtype = normalizeOptionalString((event as { subtype?: unknown }).subtype);
  return type === "system" && subtype === "compact_boundary";
}

function enrichClaudeError(error: unknown, stderrLines: readonly string[]): Error {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const stderrSummary = summarizeClaudeStderr(stderrLines);
  if (!stderrSummary || normalized.message.includes(stderrSummary)) {
    return normalized;
  }

  const enrichedError = new Error(`${normalized.message}. Claude stderr: ${stderrSummary}`);
  enrichedError.name = normalized.name;
  if (normalized.stack) {
    enrichedError.stack = normalized.stack;
  }
  return enrichedError;
}

function summarizeClaudeStderr(stderrLines: readonly string[]): string | undefined {
  if (stderrLines.length === 0) {
    return undefined;
  }

  return stderrLines.slice(-MAX_CLAUDE_STDERR_SUMMARY_LINES).join(" | ");
}

function buildClaudeSdkEnv(overrides: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (CLAUDE_SDK_STRIPPED_INHERITED_ENV_KEYS.has(name) || typeof value !== "string") {
      continue;
    }

    env[name] = value;
  }

  if (!overrides) {
    return env;
  }

  for (const [name, value] of Object.entries(overrides)) {
    if (CLAUDE_SDK_IGNORED_OVERRIDE_ENV_KEYS.has(name)) {
      continue;
    }

    env[name] = value;
  }

  return env;
}

function areContextUsagesEqual(
  left: AgentContextUsage | undefined,
  right: AgentContextUsage | undefined
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return left.tokens === right.tokens && left.contextWindow === right.contextWindow && left.percent === right.percent;
}

function deriveSdkContextUsage(response: Record<string, unknown> | undefined): AgentContextUsage | undefined {
  if (!response) {
    return undefined;
  }

  const maxTokens = readFiniteNumber(response.maxTokens);
  if (maxTokens === undefined || maxTokens <= 0) {
    return undefined;
  }

  const totalTokens = readFiniteNumber(response.totalTokens);
  const percent = readFiniteNumber(response.percentage);
  const normalizedPercent = Math.max(0, Math.min(100, percent ?? 0));
  const candidates: AgentContextUsage[] = [];

  if (totalTokens !== undefined) {
    candidates.push({
      tokens: Math.max(0, totalTokens),
      contextWindow: maxTokens,
      percent: Math.max(0, Math.min(100, percent ?? (Math.max(0, totalTokens) / maxTokens) * 100))
    });
  }

  const nonDeferredCategoryTokens = sumNonDeferredCategoryTokens(response.categories);
  if (nonDeferredCategoryTokens !== undefined) {
    candidates.push({
      tokens: nonDeferredCategoryTokens,
      contextWindow: maxTokens,
      percent: percent !== undefined ? normalizedPercent : (nonDeferredCategoryTokens / maxTokens) * 100
    });
  }

  if (percent !== undefined) {
    candidates.push({
      tokens: (normalizedPercent / 100) * maxTokens,
      contextWindow: maxTokens,
      percent: normalizedPercent
    });
  }

  return candidates.find((candidate) => isPlausibleContextUsage(candidate));
}

function sumNonDeferredCategoryTokens(categories: unknown): number | undefined {
  if (!Array.isArray(categories)) {
    return undefined;
  }

  let total = 0;
  let sawCategory = false;

  for (const value of categories) {
    const category = readObject(value);
    if (!category || readBoolean(category.isDeferred) === true) {
      continue;
    }

    const tokens = readFiniteNumber(category.tokens);
    if (tokens === undefined || tokens < 0) {
      continue;
    }

    total += tokens;
    sawCategory = true;
  }

  return sawCategory ? total : undefined;
}

function areStatusSnapshotsEqual(
  left: EmittedStatusSnapshot | undefined,
  right: EmittedStatusSnapshot | undefined
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.status === right.status
    && left.pendingCount === right.pendingCount
    && left.internalStatus === right.internalStatus
    && areContextUsagesEqual(left.contextUsage, right.contextUsage)
  );
}

function cloneStatusSnapshot(snapshot: EmittedStatusSnapshot): EmittedStatusSnapshot {
  return {
    status: snapshot.status,
    pendingCount: snapshot.pendingCount,
    internalStatus: snapshot.internalStatus,
    contextUsage: snapshot.contextUsage
      ? {
          tokens: snapshot.contextUsage.tokens,
          contextWindow: snapshot.contextUsage.contextWindow,
          percent: snapshot.contextUsage.percent
        }
      : undefined
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
