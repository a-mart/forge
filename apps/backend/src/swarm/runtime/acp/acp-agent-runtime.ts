import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { StdioJsonRpcClient, type JsonRpcNotificationMessage, type JsonRpcRequestMessage } from "../../stdio-jsonrpc-client.js";
import { openSessionManagerWithSizeGuard } from "../../session-file-guard.js";
import { transitionAgentStatus } from "../../agent-state-machine.js";
import {
  normalizeRuntimeError,
  normalizeRuntimeUserMessage,
  previewForLog
} from "../../runtime-utils.js";
import type {
  RuntimeErrorEvent,
  RuntimeSessionEvent,
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
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
import { AcpEventMapper } from "./acp-event-mapper.js";

const ACP_RUNTIME_STATE_ENTRY_TYPE = "swarm_acp_runtime_state";
const ACP_MODE_ID = "agent";
const ACP_CLIENT_INFO = {
  name: "forge-acp-runtime",
  version: "0.1.0"
};
const SESSION_HEADER_VERSION = 3;
const ACP_DISABLED_MESSAGE = "ACP runtime is disabled (FORGE_ACP_ENABLED=false)";
const ACP_CLI_NOT_FOUND_MESSAGE = "Cursor Agent CLI not found on PATH. Install from cursor.com/docs/cli/installation";
const ACP_AUTH_REQUIRED_MESSAGE = "Run `agent login` to authenticate before using ACP specialists";

export interface AcpMcpDescriptor {
  type: "http";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

interface AcpRuntimeState {
  sessionId: string;
  modeId: string;
  savedAt: string;
}

interface QueuedPrompt {
  deliveryId: string;
  message: RuntimeUserMessage;
}

interface ActivePromptState {
  token: number;
  message: RuntimeUserMessage;
  promise: Promise<unknown>;
  cancelled: boolean;
}

type AcpPromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export class AcpAgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType = "acp" as const;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly now: () => string;
  private readonly systemPrompt: string;
  private readonly rpc: StdioJsonRpcClient;
  private readonly eventMapper: AcpEventMapper;
  private readonly customEntries = new Map<string, Array<{ id: string; data: unknown }>>();
  private readonly queuedPrompts: QueuedPrompt[] = [];
  private readonly ignoredPromptTokens = new Set<number>();
  private readonly mcpServers: AcpMcpDescriptor[];
  private readonly onUnexpectedExit: (() => Promise<void> | void) | undefined;

  private status: AgentStatus;
  private sessionId: string | undefined;
  private modeId: string = ACP_MODE_ID;
  private activePrompt: ActivePromptState | undefined;
  private promptDispatchPending = false;
  private suppressProcessExitHandling = false;
  private suppressSessionUpdatesUntilIdle = false;
  private systemPromptInjected = false;
  private nextPromptToken = 0;
  private currentTurnReplayMessage: RuntimeUserMessage | undefined;
  private persistedRuntimeState: AcpRuntimeState | undefined;
  private lastSessionEntryId: string | null = null;

  private constructor(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    command: string;
    mcpServers?: AcpMcpDescriptor[];
    runtimeEnv?: Record<string, string | undefined>;
    onSessionFileRotated?: (sessionFile: string) => Promise<void> | void;
    onUnexpectedExit?: () => Promise<void> | void;
  }) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.now = options.now ?? (() => new Date().toISOString());
    this.systemPrompt = options.systemPrompt;
    this.status = options.descriptor.status;
    this.mcpServers = [...(options.mcpServers ?? [])];
    this.onUnexpectedExit = options.onUnexpectedExit;

    const sessionManager = openSessionManagerWithSizeGuard(options.descriptor.sessionFile, {
      context: `runtime:create:acp:${options.descriptor.agentId}`,
      rotateOversizedFile: true,
      logWarning: (message) => {
        if (message === "session:file:oversized:rotated") {
          Promise.resolve(options.onSessionFileRotated?.(options.descriptor.sessionFile)).catch(() => {
            // Best-effort hook only.
          });
        }
      }
    });
    if (!sessionManager) {
      throw new Error(
        `Unable to open session file for agent ${options.descriptor.agentId}: ${options.descriptor.sessionFile}`
      );
    }

    for (const entry of sessionManager.getEntries()) {
      this.lastSessionEntryId = entry.id;
      if (entry.type !== "custom") {
        continue;
      }

      const existing = this.customEntries.get(entry.customType) ?? [];
      existing.push({ id: entry.id, data: entry.data });
      this.customEntries.set(entry.customType, existing);
    }

    this.persistedRuntimeState = this.readPersistedRuntimeState();
    this.eventMapper = new AcpEventMapper({
      debug: process.env.FORGE_DEBUG === "true",
      logDebug: (message, details) => this.logDebug(`event_mapper:${message}`, details)
    });

    this.rpc = new StdioJsonRpcClient({
      command: options.command,
      args: ["acp"],
      processLabel: "Cursor ACP",
      spawnOptions: {
        cwd: options.descriptor.cwd,
        env: buildRuntimeEnv(options.runtimeEnv)
      },
      onNotification: async (notification) => {
        await this.handleNotification(notification);
      },
      onRequest: async (request) => {
        return await this.handleServerRequest(request);
      },
      onExit: (error) => {
        void this.handleProcessExit(error);
      },
      onStderr: () => {
        // Cursor Agent emits logs on stderr.
      }
    });
  }

  static async create(options: {
    descriptor: AgentDescriptor;
    callbacks: SwarmRuntimeCallbacks;
    now?: () => string;
    systemPrompt: string;
    mcpServers?: AcpMcpDescriptor[];
    runtimeEnv?: Record<string, string | undefined>;
    onSessionFileRotated?: (sessionFile: string) => Promise<void> | void;
    onUnexpectedExit?: () => Promise<void> | void;
  }): Promise<AcpAgentRuntime> {
    assertAcpRuntimeEnabled();

    const command = resolveAcpCommand(process.platform);
    assertAcpCliAvailable(command, options.descriptor.cwd, buildRuntimeEnv(options.runtimeEnv));

    const runtime = new AcpAgentRuntime({
      ...options,
      command
    });

    try {
      await runtime.initialize();
      return runtime;
    } catch (error) {
      runtime.disposeRpcResources();

      const normalized = normalizeAcpStartupError(error);
      runtime.logRuntimeError("startup", normalized, {
        action: "initialize"
      });
      throw normalized;
    }
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

    if (replayMessages.length === 0) {
      return undefined;
    }

    return {
      messages: replayMessages
    };
  }

  async restorePreparedSpecialistFallbackReplay(): Promise<void> {
    // ACP replay snapshot generation is non-destructive.
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    _requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    this.ensureNotTerminated();

    const message = normalizeRuntimeUserMessage(input);
    const deliveryId = randomUUID();

    if (this.activePrompt || this.promptDispatchPending) {
      this.queuedPrompts.push({
        deliveryId,
        message
      });
      await this.emitStatus();

      return {
        targetAgentId: this.descriptor.agentId,
        deliveryId,
        acceptedMode: "steer"
      };
    }

    try {
      await this.dispatchPrompt(message);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    return {
      targetAgentId: this.descriptor.agentId,
      deliveryId,
      acceptedMode: "prompt"
    };
  }

  async compact(): Promise<unknown> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support manual compaction`);
  }

  async smartCompact(_customInstructions?: string): Promise<SmartCompactResult> {
    this.ensureNotTerminated();
    throw new Error(`Agent ${this.descriptor.agentId} does not support smart compaction`);
  }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      await this.cancelActivePrompt();
    }

    this.queuedPrompts.length = 0;
    this.currentTurnReplayMessage = undefined;
    await this.updateStatus("idle");
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    const shouldAbort = options?.abort ?? true;
    if (shouldAbort) {
      await this.cancelActivePrompt();
    }

    this.disposeRpcResources();
    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  async shutdownForReplacement(): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.assertIdleForReplacementShutdown();
    this.disposeRpcResources();
  }

  async recycle(): Promise<void> {
    if (this.status === "terminated") {
      return;
    }

    this.assertIdleForReplacementShutdown();
    this.disposeRpcResources();
  }

  getCustomEntries(customType: string): unknown[] {
    const entries = this.customEntries.get(customType) ?? [];
    return entries.map((entry) => entry.data);
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entryId = generateSessionEntryId();
    const existing = this.customEntries.get(customType) ?? [];
    existing.push({ id: entryId, data });
    this.customEntries.set(customType, existing);

    this.ensureSessionFileHeader();
    this.appendCustomEntryToSessionFile({
      type: "custom",
      customType,
      data,
      id: entryId,
      parentId: this.lastSessionEntryId,
      timestamp: this.now()
    });
    this.lastSessionEntryId = entryId;
    return entryId;
  }

  private async initialize(): Promise<void> {
    await this.rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: false,
          writeTextFile: false
        },
        terminal: false
      },
      clientInfo: ACP_CLIENT_INFO
    });

    await this.bootstrapSession();
  }

  private async bootstrapSession(): Promise<void> {
    const persisted = this.readPersistedRuntimeState();
    if (persisted?.sessionId) {
      try {
        const loaded = await this.rpc.request<unknown>("session/load", {
          cwd: this.descriptor.cwd,
          mcpServers: this.mcpServers,
          sessionId: persisted.sessionId
        });

        this.sessionId = parseAcpSessionId(loaded) ?? persisted.sessionId;
        this.modeId = persisted.modeId || ACP_MODE_ID;
        this.systemPromptInjected = false;
      } catch (error) {
        if (isAcpAuthError(error)) {
          throw error;
        }

        this.logDebug("session_load:failed", {
          agentId: this.descriptor.agentId,
          sessionId: persisted.sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (!this.sessionId) {
      const created = await this.rpc.request<unknown>("session/new", {
        cwd: this.descriptor.cwd,
        mcpServers: this.mcpServers
      });

      const sessionId = parseAcpSessionId(created);
      if (!sessionId) {
        throw new Error("ACP runtime did not return a session id");
      }

      this.sessionId = sessionId;
      this.modeId = ACP_MODE_ID;
      this.systemPromptInjected = false;
    }

    await this.rpc.request("session/set_mode", {
      sessionId: this.sessionId,
      modeId: ACP_MODE_ID
    });

    this.modeId = ACP_MODE_ID;
    this.persistRuntimeState();
  }

  private async dispatchPrompt(message: RuntimeUserMessage): Promise<void> {
    this.ensureNotTerminated();

    if (!this.sessionId) {
      throw new Error("ACP runtime session is not initialized");
    }

    this.promptDispatchPending = true;
    this.suppressSessionUpdatesUntilIdle = false;
    this.currentTurnReplayMessage = cloneRuntimeUserMessage(message);

    const token = ++this.nextPromptToken;

    try {
      await this.emitMappedEvents(this.eventMapper.beginPrompt());
      await this.updateStatus("streaming");

      // ACP prompts can run for minutes (tool execution, permission handling, etc.)
      // Use 0 timeout to disable the JSON-RPC request timeout for prompt calls
      const promptPromise = this.rpc.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: toAcpPrompt({
          systemPrompt: this.systemPrompt,
          message,
          includeSystemPrompt: !this.systemPromptInjected
        })
      }, 0);
      this.systemPromptInjected = true;

      this.activePrompt = {
        token,
        message: cloneRuntimeUserMessage(message),
        promise: promptPromise,
        cancelled: false
      };

      void promptPromise
        .then(
          () => this.handlePromptCompleted(token),
          (error) => this.handlePromptFailed(token, error)
        )
        .catch((finalError) => {
          void this.handlePromptFinalizationFailure(token, finalError);
        });
    } catch (error) {
      this.currentTurnReplayMessage = undefined;
      this.eventMapper.reset();
      await this.handlePromptDispatchFailure(error, message);
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      this.promptDispatchPending = false;
    }
  }

  private async handlePromptDispatchFailure(error: unknown, message: RuntimeUserMessage): Promise<void> {
    const normalized = normalizeRuntimeError(error);
    this.logRuntimeError("prompt_start", error, {
      textPreview: previewForLog(message.text),
      imageCount: message.images?.length ?? 0,
      stage: "dispatch_prompt"
    });

    await this.reportRuntimeError({
      phase: "prompt_start",
      message: normalized.message,
      stack: normalized.stack,
      details: {
        textPreview: previewForLog(message.text),
        imageCount: message.images?.length ?? 0
      }
    });

    await this.emitMappedEvents(this.eventMapper.completePrompt());
    await this.updateStatus("idle");
    await this.invokeOnAgentEnd();
  }

  private async handlePromptCompleted(token: number): Promise<void> {
    const activePrompt = this.activePrompt;
    if (!activePrompt || activePrompt.token !== token) {
      return;
    }

    this.activePrompt = undefined;
    this.currentTurnReplayMessage = undefined;

    if (this.ignoredPromptTokens.delete(token)) {
      this.eventMapper.reset();
      return;
    }

    const wasCancelled = activePrompt.cancelled;
    if (!wasCancelled) {
      await this.emitMappedEvents(this.eventMapper.completePrompt());
    } else {
      this.eventMapper.reset();
    }

    if (this.status === "terminated") {
      return;
    }

    if (this.queuedPrompts.length > 0) {
      await this.startNextQueuedPrompt();
      return;
    }

    await this.updateStatus("idle");
    if (!wasCancelled) {
      await this.invokeOnAgentEnd();
    }
  }

  private async handlePromptFailed(token: number, error: unknown): Promise<void> {
    const activePrompt = this.activePrompt;
    if (!activePrompt || activePrompt.token !== token) {
      return;
    }

    this.activePrompt = undefined;
    this.currentTurnReplayMessage = undefined;

    if (this.ignoredPromptTokens.delete(token)) {
      this.eventMapper.reset();
      return;
    }

    if (activePrompt.cancelled) {
      this.eventMapper.reset();
      if (this.status === "terminated") {
        return;
      }

      if (this.queuedPrompts.length > 0) {
        await this.startNextQueuedPrompt();
        return;
      }

      await this.updateStatus("idle");
      return;
    }

    const normalized = normalizeRuntimeError(error);
    this.logRuntimeError("prompt_start", error, {
      textPreview: previewForLog(activePrompt.message.text),
      imageCount: activePrompt.message.images?.length ?? 0,
      stage: "prompt_promise"
    });

    await this.reportRuntimeError({
      phase: "prompt_start",
      message: normalized.message,
      stack: normalized.stack,
      details: {
        textPreview: previewForLog(activePrompt.message.text),
        imageCount: activePrompt.message.images?.length ?? 0
      }
    });

    await this.emitMappedEvents(this.eventMapper.completePrompt());

    if (this.status === "terminated") {
      return;
    }

    if (this.queuedPrompts.length > 0) {
      await this.startNextQueuedPrompt();
      return;
    }

    await this.updateStatus("idle");
    await this.invokeOnAgentEnd();
  }

  private async startNextQueuedPrompt(): Promise<void> {
    if (this.status === "terminated" || this.promptDispatchPending || this.activePrompt || this.queuedPrompts.length === 0) {
      return;
    }

    const next = this.queuedPrompts.shift()!;
    await this.emitStatus();

    try {
      await this.dispatchPrompt(next.message);
    } catch {
      if (this.queuedPrompts.length > 0) {
        await this.startNextQueuedPrompt();
      }
    }
  }

  private async cancelActivePrompt(): Promise<void> {
    const activePrompt = this.activePrompt;
    if (!activePrompt || !this.sessionId) {
      return;
    }

    activePrompt.cancelled = true;
    this.suppressSessionUpdatesUntilIdle = true;
    this.activePrompt = undefined;
    this.currentTurnReplayMessage = undefined;
    this.eventMapper.reset();

    try {
      this.rpc.notify("session/cancel", {
        sessionId: this.sessionId
      });
    } catch (error) {
      this.logRuntimeError("interrupt", error, {
        sessionId: this.sessionId
      });
    }
  }

  private async handleNotification(notification: JsonRpcNotificationMessage): Promise<void> {
    if (notification.method === "cursor/update_todos") {
      return;
    }

    if (notification.method !== "session/update") {
      this.logDebug("notification:ignored", notification);
      return;
    }

    const params = readObject(notification.params);
    if (!params) {
      return;
    }

    const sessionId = readString(params.sessionId);
    if (sessionId && this.sessionId && sessionId !== this.sessionId) {
      return;
    }

    if (this.suppressSessionUpdatesUntilIdle) {
      return;
    }

    const events = this.eventMapper.mapSessionUpdate(params.update);
    await this.emitMappedEvents(events);
  }

  private async handleServerRequest(request: JsonRpcRequestMessage): Promise<unknown> {
    switch (request.method) {
      case "session/request_permission":
        return {
          outcome: {
            outcome: "selected",
            optionId: "allow-once"
          }
        };

      case "cursor/ask_question":
        return {
          outcome: {
            outcome: "skipped"
          }
        };

      case "cursor/create_plan":
        return {
          outcome: {
            outcome: "accepted"
          }
        };

      case "cursor/task":
        return {
          outcome: {
            outcome: "completed"
          }
        };

      default:
        this.logDebug("server_request:unsupported", {
          method: request.method,
          params: request.params
        });
        throw new Error(`Unsupported server request: ${request.method}`);
    }
  }

  private async handleProcessExit(error: Error): Promise<void> {
    if (this.suppressProcessExitHandling || this.status === "terminated") {
      return;
    }

    const pendingCount = this.queuedPrompts.length;

    if (this.activePrompt) {
      this.ignoredPromptTokens.add(this.activePrompt.token);
    }

    this.activePrompt = undefined;
    this.promptDispatchPending = false;
    this.currentTurnReplayMessage = undefined;
    this.queuedPrompts.length = 0;
    this.eventMapper.reset();

    await this.runUnexpectedExitCleanup();

    this.logRuntimeError("runtime_exit", error, {
      pendingCount
    });
    await this.reportRuntimeError({
      phase: "runtime_exit",
      message: error.message,
      stack: error.stack,
      details: {
        pendingCount
      }
    });

    this.status = transitionAgentStatus(this.status, "terminated");
    this.descriptor.status = this.status;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  private readPersistedRuntimeState(): AcpRuntimeState | undefined {
    const entries = this.getCustomEntries(ACP_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const parsed = parseAcpRuntimeState(entries[index]);
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private persistRuntimeState(): void {
    const sessionId = this.sessionId;
    if (!sessionId) {
      return;
    }

    const nextState: AcpRuntimeState = {
      sessionId,
      modeId: this.modeId || ACP_MODE_ID,
      savedAt: this.now()
    };

    const previous = this.persistedRuntimeState;
    if (previous && previous.sessionId === nextState.sessionId && previous.modeId === nextState.modeId) {
      return;
    }

    this.appendCustomEntry(ACP_RUNTIME_STATE_ENTRY_TYPE, nextState);
    this.persistedRuntimeState = nextState;
  }

  private appendCustomEntryToSessionFile(entry: {
    type: "custom";
    customType: string;
    data?: unknown;
    id: string;
    parentId: string | null;
    timestamp: string;
  }): void {
    appendFileSync(this.descriptor.sessionFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private ensureSessionFileHeader(): void {
    if (hasValidSessionHeader(this.descriptor.sessionFile)) {
      return;
    }

    const headerLine = `${JSON.stringify({
      type: "session",
      version: SESSION_HEADER_VERSION,
      id: generateSessionEntryId(),
      timestamp: this.now(),
      cwd: this.descriptor.cwd
    })}\n`;

    writeFileSync(this.descriptor.sessionFile, headerLine, "utf8");
    this.lastSessionEntryId = null;
  }

  private disposeRpcResources(): void {
    this.suppressProcessExitHandling = true;

    if (this.activePrompt) {
      this.ignoredPromptTokens.add(this.activePrompt.token);
    }

    this.rpc.dispose();
    this.activePrompt = undefined;
    this.promptDispatchPending = false;
    this.sessionId = undefined;
    this.systemPromptInjected = false;
    this.currentTurnReplayMessage = undefined;
    this.queuedPrompts.length = 0;
    this.eventMapper.reset();
  }

  private assertIdleForReplacementShutdown(): void {
    if (
      this.status !== "idle"
      || this.promptDispatchPending
      || this.activePrompt
      || this.queuedPrompts.length > 0
    ) {
      throw new Error(`Agent ${this.descriptor.agentId} runtime is not idle and cannot be recycled`);
    }
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async updateStatus(status: AgentStatus): Promise<void> {
    if (this.status === status) {
      await this.emitStatus();
      return;
    }

    const nextStatus = transitionAgentStatus(this.status, status);
    this.status = nextStatus;
    this.descriptor.status = nextStatus;
    this.descriptor.updatedAt = this.now();
    await this.emitStatus();
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.queuedPrompts.length,
      this.getContextUsage()
    );
  }

  private async emitMappedEvents(events: RuntimeSessionEvent[]): Promise<void> {
    if (!events.length || !this.callbacks.onSessionEvent) {
      return;
    }

    for (const event of events) {
      await this.callbacks.onSessionEvent(this.descriptor.agentId, event);
    }
  }

  private async invokeOnAgentEnd(): Promise<void> {
    if (!this.callbacks.onAgentEnd) {
      return;
    }

    try {
      await this.callbacks.onAgentEnd(this.descriptor.agentId);
    } catch (error) {
      this.logRuntimeError("prompt_start", error, {
        callback: "onAgentEnd"
      });
    }
  }

  private async handlePromptFinalizationFailure(token: number, error: unknown): Promise<void> {
    this.logRuntimeError("prompt_start", error, {
      stage: "prompt_finalization",
      token
    });

    if (this.ignoredPromptTokens.delete(token)) {
      this.eventMapper.reset();
      return;
    }

    if (this.activePrompt?.token === token) {
      this.activePrompt = undefined;
    }

    this.currentTurnReplayMessage = undefined;
    this.eventMapper.reset();

    if (this.status === "terminated") {
      return;
    }

    if (!this.activePrompt && !this.promptDispatchPending && this.queuedPrompts.length > 0) {
      try {
        await this.startNextQueuedPrompt();
        return;
      } catch (nextError) {
        this.logRuntimeError("prompt_start", nextError, {
          stage: "prompt_finalization_recovery",
          token
        });
      }
    }

    if (this.status !== "idle") {
      const nextStatus = transitionAgentStatus(this.status, "idle");
      this.status = nextStatus;
      this.descriptor.status = nextStatus;
      this.descriptor.updatedAt = this.now();
    }

    try {
      await this.emitStatus();
    } catch (statusError) {
      this.logRuntimeError("prompt_start", statusError, {
        stage: "prompt_finalization_emit_status",
        token
      });
    }
  }

  private async reportRuntimeError(error: RuntimeErrorEvent): Promise<void> {
    if (!this.callbacks.onRuntimeError) {
      return;
    }

    try {
      await this.callbacks.onRuntimeError(this.descriptor.agentId, error);
    } catch (callbackError) {
      this.logRuntimeError(error.phase, callbackError, {
        callback: "onRuntimeError"
      });
    }
  }

  private async runUnexpectedExitCleanup(): Promise<void> {
    if (!this.onUnexpectedExit) {
      return;
    }

    try {
      await this.onUnexpectedExit();
    } catch (error) {
      this.logRuntimeError("runtime_exit", error, {
        stage: "unexpected_exit_cleanup"
      });
    }
  }

  private logRuntimeError(
    phase: RuntimeErrorEvent["phase"],
    error: unknown,
    details?: Record<string, unknown>
  ): void {
    const normalized = normalizeRuntimeError(error);
    console.error(`[swarm][${this.now()}] runtime:error`, {
      runtime: "cursor-acp",
      agentId: this.descriptor.agentId,
      phase,
      message: normalized.message,
      stack: normalized.stack,
      ...details
    });
  }

  private logDebug(message: string, details?: unknown): void {
    if (process.env.FORGE_DEBUG !== "true") {
      return;
    }

    const normalizedDetails = details && typeof details === "object" ? details : { details };
    console.log(`[swarm][${this.now()}] acp_runtime:${message}`, {
      agentId: this.descriptor.agentId,
      ...normalizedDetails
    });
  }
}

function assertAcpRuntimeEnabled(): void {
  const normalized = process.env.FORGE_ACP_ENABLED?.trim().toLowerCase();
  // Explicitly disabled
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    throw new Error(ACP_DISABLED_MESSAGE);
  }
  // Explicitly enabled or unset (default: enabled when CLI is available)
}

function resolveAcpCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agent.cmd" : "agent";
}

function assertAcpCliAvailable(command: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, ["--version"], {
    cwd,
    env,
    stdio: "ignore"
  });

  if (isSpawnEnoentError(result.error)) {
    throw new Error(ACP_CLI_NOT_FOUND_MESSAGE);
  }
}

function buildRuntimeEnv(runtimeEnv: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env
  };

  for (const [name, value] of Object.entries(runtimeEnv ?? {})) {
    if (typeof value === "string" && value.trim().length > 0) {
      env[name] = value;
    } else {
      delete env[name];
    }
  }

  return env;
}

function normalizeAcpStartupError(error: unknown): Error {
  if (error instanceof Error && error.message === ACP_DISABLED_MESSAGE) {
    return error;
  }

  if (isSpawnEnoentError(error)) {
    return new Error(ACP_CLI_NOT_FOUND_MESSAGE);
  }

  if (isAcpAuthError(error)) {
    return new Error(ACP_AUTH_REQUIRED_MESSAGE);
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isSpawnEnoentError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: string }).code === "ENOENT"
  );
}

function isAcpAuthError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  if (!message) {
    return false;
  }

  return /agent login|not authenticated|authentication required|unauthorized|cursor login|login required|\b401\b|auth/i.test(message);
}

function extractErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    const extraData = "data" in error ? ` ${safeJson((error as Error & { data?: unknown }).data)}` : "";
    return `${error.message}${extraData}`.trim();
  }

  return typeof error === "string" ? error : undefined;
}

function parseAcpSessionId(value: unknown): string | undefined {
  const direct = readString((value as { sessionId?: unknown } | undefined)?.sessionId);
  if (direct) {
    return direct;
  }

  const nested = readObject((value as { session?: unknown } | undefined)?.session);
  return readString(nested?.sessionId) ?? readString(nested?.id);
}

function parseAcpRuntimeState(value: unknown): AcpRuntimeState | undefined {
  const entry = readObject(value);
  const sessionId = readString(entry?.sessionId);
  if (!sessionId) {
    return undefined;
  }

  return {
    sessionId,
    modeId: readString(entry?.modeId) ?? ACP_MODE_ID,
    savedAt: readString(entry?.savedAt) ?? new Date().toISOString()
  };
}

function buildAcpPromptText(options: {
  systemPrompt: string;
  userMessage: string;
  includeSystemPrompt: boolean;
}): string {
  if (!options.includeSystemPrompt || options.systemPrompt.trim().length === 0) {
    return options.userMessage;
  }

  return `<system_context>\n${options.systemPrompt}\n</system_context>\n\n${options.userMessage}`;
}

function toAcpPrompt(options: {
  systemPrompt: string;
  message: RuntimeUserMessage;
  includeSystemPrompt: boolean;
}): AcpPromptContentPart[] {
  const prompt: AcpPromptContentPart[] = [];
  const messageText = options.message.text ?? "";
  const normalizedImages = options.message.images?.filter((image) => image.mimeType && image.data) ?? [];

  if (options.includeSystemPrompt && options.systemPrompt.trim().length > 0) {
    prompt.push({
      type: "text",
      text: buildAcpPromptText({
        systemPrompt: options.systemPrompt,
        userMessage: "",
        includeSystemPrompt: true
      }).trimEnd()
    });
  }

  if (messageText.length > 0 || (prompt.length === 0 && normalizedImages.length === 0)) {
    prompt.push({
      type: "text",
      text: messageText
    });
  }

  for (const image of normalizedImages) {
    prompt.push({
      type: "image",
      mimeType: image.mimeType,
      data: image.data
    });
  }

  if (prompt.length === 0) {
    prompt.push({
      type: "text",
      text: ""
    });
  }

  return prompt;
}

function cloneRuntimeUserMessage(message: RuntimeUserMessage): RuntimeUserMessage {
  return {
    text: message.text,
    images: message.images?.map((image) => ({ ...image })) ?? []
  };
}

function hasValidSessionHeader(sessionFilePath: string): boolean {
  try {
    const content = readFileSync(sessionFilePath, "utf8");
    const firstLine = content.split(/\r?\n/u, 1)[0]?.trim();
    if (!firstLine) {
      return false;
    }

    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
    return (
      parsed.type === "session"
      && typeof parsed.id === "string"
      && parsed.id.trim().length > 0
      && typeof parsed.cwd === "string"
    );
  } catch {
    return false;
  }
}

function generateSessionEntryId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
