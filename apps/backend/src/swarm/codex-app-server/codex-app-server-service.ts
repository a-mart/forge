import { randomUUID } from "node:crypto";
import { getWorkerSessionFilePath } from "../data-paths.js";
import {
  CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL,
  isExternalThreadDescriptor,
  validateCodexExternalThreadModelInvariant,
} from "../external-threads.js";
import { createCodexAppServerClient } from "./codex-app-server-client.js";
import { dispatchCodexAppServerNotification } from "./codex-app-server-events.js";
import {
  buildCodexSidecarAgentId,
  parseThreadIdFromThreadResult,
  parseTurnIdFromTurnResult,
} from "./codex-sidecar-ids.js";
import { truncateCodexPreview } from "./codex-sidecar-parent-cards.js";
import type {
  CodexAppServerClientPort,
  CodexAppServerProbeResult,
  CodexAppServerServiceOptions,
  CodexSendTextTurnOptions,
  CodexSidecarHost,
  CodexSidecarPersistedThreadState,
  CodexSidecarRuntimeState,
  CodexSidecarActiveTurn,
} from "./types.js";
import {
  CodexSidecarBusyError,
  CODEX_THREAD_STATE_CUSTOM_TYPE,
  DEFAULT_CODEX_SIDE_CAR_DEVELOPER_INSTRUCTIONS,
  DEFAULT_TURN_COMPLETION_GRACE_MS,
} from "./types.js";
import type { AgentDescriptor } from "../types.js";

export class CodexAppServerService {
  private sharedClient: CodexAppServerClientPort | undefined;
  private clientStartPromise: Promise<CodexAppServerClientPort> | undefined;
  private readonly sidecarRuntimeByAgentId = new Map<string, CodexSidecarRuntimeState>();
  private readonly developerInstructions: string;
  private readonly turnCompletionGraceMs: number;

  constructor(
    private readonly host: CodexSidecarHost,
    private readonly options: CodexAppServerServiceOptions,
  ) {
    this.developerInstructions =
      options.developerInstructions ?? DEFAULT_CODEX_SIDE_CAR_DEVELOPER_INSTRUCTIONS;
    this.turnCompletionGraceMs = options.turnCompletionGraceMs ?? DEFAULT_TURN_COMPLETION_GRACE_MS;
  }

  async probe(timeoutMs = 5_000): Promise<CodexAppServerProbeResult> {
    try {
      const client = await this.ensureSharedClient();
      await client.request("plugin/list", {}, timeoutMs);
      return { ok: true, initialized: true };
    } catch (error) {
      return {
        ok: false,
        initialized: Boolean(this.sharedClient),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  findSidecarForManager(managerAgentId: string): AgentDescriptor | undefined {
    const sidecarAgentId = buildCodexSidecarAgentId(managerAgentId);
    const direct = this.host.getDescriptor(sidecarAgentId);
    if (direct && isExternalThreadDescriptor(direct)) {
      return direct;
    }

    return this.host
      .listWorkersForSession(managerAgentId)
      .find((worker) => worker.agentId === sidecarAgentId && isExternalThreadDescriptor(worker));
  }

  async getOrCreateSidecarDescriptor(manager: AgentDescriptor): Promise<AgentDescriptor> {
    if (manager.role !== "manager") {
      throw new Error(`Expected manager descriptor, got ${manager.agentId}`);
    }

    const existing = this.findSidecarForManager(manager.agentId);
    if (existing) {
      if (existing.status === "terminated" || existing.status === "stopped") {
        throw new Error(
          `Codex sidecar ${existing.agentId} is ${existing.status} and cannot be reused. Recreate the sidecar before sending another Codex message.`,
        );
      }
      return existing;
    }

    const profileId = manager.profileId ?? "default";
    const sidecarAgentId = buildCodexSidecarAgentId(manager.agentId);
    const sessionFile = getWorkerSessionFilePath(
      this.options.dataDir,
      profileId,
      manager.agentId,
      sidecarAgentId,
    );

    await this.host.ensureSessionFileParentDirectory(sessionFile);

    const now = this.host.now();
    const descriptor: AgentDescriptor = {
      agentId: sidecarAgentId,
      managerId: manager.agentId,
      role: "worker",
      displayName: "Codex",
      status: "idle",
      createdAt: now,
      updatedAt: now,
      cwd: manager.cwd,
      model: { ...CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL },
      sessionFile,
      profileId,
      externalThread: {
        type: "codex_app_server",
        persisted: true,
        createdByMention: true,
      },
    };

    const modelError = validateCodexExternalThreadModelInvariant(descriptor.model);
    if (modelError) {
      throw new Error(modelError);
    }

    this.host.upsertDescriptor(descriptor);
    await this.host.saveStore();
    this.host.emitAgentsSnapshot();
    this.host.emitProfilesSnapshot();

    return descriptor;
  }

  async reconcileSidecarThreadId(descriptor: AgentDescriptor): Promise<string | undefined> {
    if (!isExternalThreadDescriptor(descriptor)) {
      throw new Error(`Expected Codex external-thread descriptor: ${descriptor.agentId}`);
    }

    const fromDescriptor = parseThreadIdFromThreadResult({
      thread: { id: descriptor.externalThread.threadId },
    });
    if (fromDescriptor) {
      return fromDescriptor;
    }

    const fallback = this.host.readSidecarThreadStateFallback?.(descriptor.sessionFile);
    if (!fallback?.threadId) {
      return undefined;
    }

    descriptor.externalThread = {
      ...descriptor.externalThread,
      threadId: fallback.threadId,
    };
    descriptor.updatedAt = this.host.now();
    this.host.upsertDescriptor(descriptor);
    await this.host.saveStore();

    return fallback.threadId;
  }

  async createOrResumeThread(sidecarAgentId: string): Promise<string> {
    const descriptor = this.requireSidecarDescriptor(sidecarAgentId);
    const existingThreadId = await this.reconcileSidecarThreadId(descriptor);
    const client = await this.ensureSharedClient();

    if (existingThreadId) {
      try {
        const resumed = await client.request("thread/resume", {
          threadId: existingThreadId,
          cwd: descriptor.cwd,
          developerInstructions: this.developerInstructions,
        });
        const resumedThreadId = parseThreadIdFromThreadResult(resumed);
        if (resumedThreadId) {
          await this.persistThreadId(descriptor, resumedThreadId);
          return resumedThreadId;
        }
      } catch (error) {
        this.host.logDebug("Codex thread resume failed; starting new thread", {
          sidecarAgentId,
          threadId: existingThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const started = await client.request("thread/start", {
      cwd: descriptor.cwd,
      ephemeral: false,
      developerInstructions: this.developerInstructions,
    });

    const startedThreadId = parseThreadIdFromThreadResult(started);
    if (!startedThreadId) {
      throw new Error("Codex app-server did not return a thread id");
    }

    await this.persistThreadId(descriptor, startedThreadId);
    return startedThreadId;
  }

  async sendTextTurn(
    sidecarAgentId: string,
    text: string,
    options: CodexSendTextTurnOptions = {},
  ): Promise<{ turnId: string; correlationId: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Codex turn text must not be empty");
    }

    this.assertSidecarAvailable(sidecarAgentId);

    const descriptor = this.requireSidecarDescriptor(sidecarAgentId);
    const runtime = this.getOrCreateRuntime(sidecarAgentId);
    runtime.turnEpoch += 1;

    const correlationId = options.correlationId ?? randomUUID();
    const requestId = options.requestId ?? randomUUID();
    const promptPreview = options.promptPreview ?? truncateCodexPreview(trimmed);

    runtime.activeTurn = {
      turnId: "",
      correlationId,
      userText: trimmed,
      startedAt: this.host.now(),
      assistantText: "",
      assistantMessageEmitted: false,
      suppressed: false,
      turnEpoch: runtime.turnEpoch,
      graceItemAcceptOpen: false,
      parentTurnContext: options.parentRouting
        ? {
            managerAgentId: options.parentRouting.managerAgentId,
            requestId,
            turnCorrelationId: correlationId,
            promptPreview,
            emitParentRequestCard: options.parentRouting.emitParentRequestCard,
            sourceContext: options.parentRouting.sourceContext,
            sendAccepted: false,
            parentCompletionEmitted: false,
          }
        : undefined,
    };

    try {
      const threadId = await this.createOrResumeThread(sidecarAgentId);

      this.host.appendConversationEntry(sidecarAgentId, {
        type: "conversation_message",
        agentId: sidecarAgentId,
        role: "user",
        text: trimmed,
        timestamp: this.host.now(),
        source: "user_input",
      });

      descriptor.status = "streaming";
      descriptor.updatedAt = this.host.now();
      this.host.upsertDescriptor(descriptor);
      this.host.emitStatus(sidecarAgentId, "streaming", 0);
      this.host.emitAgentsSnapshot();

      const client = await this.ensureSharedClient();
      const response = await client.request("turn/start", {
        threadId,
        cwd: descriptor.cwd,
        input: [{ type: "text", text: trimmed, text_elements: [] }],
      });

      const turnId = parseTurnIdFromTurnResult(response);
      if (!turnId || !runtime.activeTurn) {
        throw new Error("Codex app-server did not return a turn id");
      }

      runtime.activeTurn.turnId = turnId;
      descriptor.externalThread = {
        ...descriptor.externalThread!,
        threadId,
        lastTurnId: turnId,
      };
      descriptor.updatedAt = this.host.now();
      this.host.upsertDescriptor(descriptor);
      await this.host.saveStore();

      if (runtime.activeTurn) {
        this.emitParentTurnAcceptedArtifacts(sidecarAgentId, runtime.activeTurn, trimmed);
      }

      return { turnId, correlationId };
    } catch (error) {
      this.handleSendTextTurnFailure(sidecarAgentId, error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async interruptTurn(sidecarAgentId: string): Promise<void> {
    const descriptor = this.requireSidecarDescriptor(sidecarAgentId);
    const runtime = this.getOrCreateRuntime(sidecarAgentId);
    const activeTurn = runtime.activeTurn;

    if (!activeTurn) {
      descriptor.status = "idle";
      descriptor.updatedAt = this.host.now();
      this.host.upsertDescriptor(descriptor);
      this.host.emitStatus(sidecarAgentId, "idle", 0);
      return;
    }

    if (activeTurn.interruptInProgress) {
      return;
    }

    activeTurn.interruptInProgress = true;
    activeTurn.suppressed = true;
    activeTurn.graceItemAcceptOpen = false;
    activeTurn.completionGraceToken = undefined;
    this.cancelCompletionGrace(activeTurn);

    const threadId = descriptor.externalThread?.threadId;
    try {
      if (threadId && activeTurn.turnId) {
        try {
          const client = await this.ensureSharedClient();
          await client.request(
            "turn/interrupt",
            {
              threadId,
              turnId: activeTurn.turnId,
            },
            5_000,
          );
        } catch (error) {
          this.host.logDebug("Codex turn interrupt failed", {
            sidecarAgentId,
            threadId,
            turnId: activeTurn.turnId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.clearActiveTurn(sidecarAgentId, "Codex turn stopped.");
    }
  }

  dispose(): void {
    for (const runtime of this.sidecarRuntimeByAgentId.values()) {
      if (runtime.activeTurn) {
        this.cancelCompletionGrace(runtime.activeTurn);
      }
    }

    this.sharedClient?.dispose();
    this.sharedClient = undefined;
    this.clientStartPromise = undefined;
    this.sidecarRuntimeByAgentId.clear();
  }

  getSharedClientForTest(): CodexAppServerClientPort | undefined {
    return this.sharedClient;
  }

  getRuntimeStateForTest(sidecarAgentId: string): CodexSidecarRuntimeState | undefined {
    return this.sidecarRuntimeByAgentId.get(sidecarAgentId);
  }

  private requireSidecarDescriptor(sidecarAgentId: string): AgentDescriptor {
    const descriptor = this.host.getDescriptor(sidecarAgentId);
    if (!descriptor || !isExternalThreadDescriptor(descriptor)) {
      throw new Error(`Codex sidecar descriptor not found: ${sidecarAgentId}`);
    }

    return descriptor;
  }

  private assertSidecarAvailable(requestedSidecarAgentId: string): void {
    const activeSidecarAgentId = this.getGlobalActiveSidecarAgentId();
    if (!activeSidecarAgentId) {
      return;
    }

    throw new CodexSidecarBusyError(activeSidecarAgentId, requestedSidecarAgentId);
  }

  private getGlobalActiveSidecarAgentId(): string | undefined {
    for (const [sidecarAgentId, runtime] of this.sidecarRuntimeByAgentId.entries()) {
      if (runtime.activeTurn) {
        return sidecarAgentId;
      }
    }

    return undefined;
  }

  private getOrCreateRuntime(sidecarAgentId: string): CodexSidecarRuntimeState {
    const existing = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    if (existing) {
      return existing;
    }

    const created: CodexSidecarRuntimeState = {
      turnEpoch: 0,
      openCompletionGraceToken: 0,
      turnlessItemCompletedBurned: false,
    };
    this.sidecarRuntimeByAgentId.set(sidecarAgentId, created);
    return created;
  }

  private async ensureSharedClient(): Promise<CodexAppServerClientPort> {
    if (this.sharedClient && !this.sharedClient.isDisposed()) {
      return this.sharedClient;
    }

    if (this.clientStartPromise) {
      return this.clientStartPromise;
    }

    this.clientStartPromise = this.startSharedClient();
    try {
      return await this.clientStartPromise;
    } finally {
      this.clientStartPromise = undefined;
    }
  }

  private async startSharedClient(): Promise<CodexAppServerClientPort> {
    const factory = this.options.createClient ?? createCodexAppServerClient;
    const client = factory({
      onNotification: (method, params) => this.handleSharedNotification(method, params),
      onExit: (error) => this.handleSharedClientExit(error),
      onStderr: (line) => {
        this.host.logDebug("Codex app-server stderr", { line });
      },
    });

    try {
      await client.connect();
    } catch (error) {
      client.dispose();
      this.sharedClient = undefined;
      throw error instanceof Error ? error : new Error(String(error));
    }

    this.sharedClient = client;
    return client;
  }

  private resetSharedClient(): void {
    this.sharedClient?.dispose();
    this.sharedClient = undefined;
    this.clientStartPromise = undefined;
  }

  private isTransportFailure(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes("json-rpc") ||
      message.includes("disposed") ||
      message.includes("exited") ||
      message.includes("timed out") ||
      message.includes("not writable") ||
      message.includes("connect failed")
    );
  }

  private handleSendTextTurnFailure(sidecarAgentId: string, error: unknown): void {
    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;
    if (!activeTurn || activeTurn.interruptInProgress) {
      return;
    }

    if (this.isTransportFailure(error)) {
      this.resetSharedClient();
    }

    const message = error instanceof Error ? error.message : String(error);
    this.clearActiveTurn(sidecarAgentId, `Codex turn failed: ${message}`, "error");
  }

  private async handleSharedNotification(method: string, params?: unknown): Promise<void> {
    const sidecarAgentId = this.getGlobalActiveSidecarAgentId();
    if (!sidecarAgentId) {
      this.host.logDebug("Ignored Codex app-server notification with no active turn", { method });
      return;
    }

    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;
    if (!activeTurn || activeTurn.suppressed) {
      return;
    }

    const descriptor = this.host.getDescriptor(sidecarAgentId);
    if (!descriptor || !isExternalThreadDescriptor(descriptor)) {
      return;
    }

    await dispatchCodexAppServerNotification(
      method,
      params,
      {
        sidecarAgentId,
        managerAgentId: descriptor.managerId,
        activeTurn,
        openCompletionGraceToken: runtime?.openCompletionGraceToken ?? 0,
        turnlessItemCompletedBurned: runtime?.turnlessItemCompletedBurned ?? false,
      },
      {
        onTurnStarted: (turnId) => {
          activeTurn.turnId = turnId;
        },
        onTurnCompleted: () => {
          this.scheduleActiveTurnFinalization(sidecarAgentId);
        },
        onAgentMessageDelta: (delta) => {
          activeTurn.assistantText += delta;
        },
        onAgentMessageCompleted: (text) => {
          activeTurn.agentMessageItemCompleted = true;
          activeTurn.assistantText = text;
          if (activeTurn.turnCompletedPending) {
            this.cancelCompletionGrace(activeTurn);
            this.finalizeActiveTurn(sidecarAgentId);
          }
        },
      },
    );
  }

  private handleSharedClientExit(error: Error): void {
    this.host.logDebug("Codex app-server process exited", {
      error: error.message,
    });

    const activeSidecarAgentId = this.getGlobalActiveSidecarAgentId();
    if (activeSidecarAgentId) {
      this.clearActiveTurn(
        activeSidecarAgentId,
        `Codex app-server exited: ${error.message}`,
        "error",
      );
    }

    this.resetSharedClient();
  }

  private scheduleActiveTurnFinalization(sidecarAgentId: string): void {
    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;
    if (!activeTurn || activeTurn.suppressed) {
      return;
    }

    activeTurn.turnCompletedPending = true;
    activeTurn.graceItemAcceptOpen = true;
    activeTurn.completionGraceToken = activeTurn.turnEpoch;
    runtime.openCompletionGraceToken = activeTurn.turnEpoch;

    if (activeTurn.agentMessageItemCompleted) {
      this.finalizeActiveTurn(sidecarAgentId);
      return;
    }

    if (activeTurn.completionGraceTimer) {
      return;
    }

    activeTurn.completionGraceTimer = setTimeout(() => {
      activeTurn.completionGraceTimer = undefined;
      this.finalizeActiveTurn(sidecarAgentId);
    }, this.turnCompletionGraceMs);
  }

  private cancelCompletionGrace(activeTurn: CodexSidecarActiveTurn): void {
    if (!activeTurn.completionGraceTimer) {
      return;
    }

    clearTimeout(activeTurn.completionGraceTimer);
    activeTurn.completionGraceTimer = undefined;
  }

  private finalizeActiveTurn(sidecarAgentId: string): void {
    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;
    if (!activeTurn || activeTurn.suppressed || !activeTurn.turnCompletedPending) {
      return;
    }

    this.cancelCompletionGrace(activeTurn);

    if (!activeTurn.agentMessageItemCompleted && runtime) {
      runtime.turnlessItemCompletedBurned = true;
    }

    if (activeTurn.assistantText) {
      this.emitAssistantMessageIfNeeded(sidecarAgentId, activeTurn.assistantText);
    }

    this.clearActiveTurn(sidecarAgentId);
  }

  private emitAssistantMessageIfNeeded(sidecarAgentId: string, text: string): void {
    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;
    if (!activeTurn || activeTurn.assistantMessageEmitted) {
      return;
    }

    activeTurn.assistantMessageEmitted = true;
    this.host.emitConversationMessage({
      type: "conversation_message",
      agentId: sidecarAgentId,
      role: "assistant",
      text,
      timestamp: this.host.now(),
      source: "speak_to_user",
    });
  }

  private clearActiveTurn(
    sidecarAgentId: string,
    systemMessage?: string,
    descriptorStatus: "idle" | "error" = "idle",
  ): void {
    const descriptor = this.host.getDescriptor(sidecarAgentId);
    const runtime = this.sidecarRuntimeByAgentId.get(sidecarAgentId);
    const activeTurn = runtime?.activeTurn;

    this.emitParentTurnCompletionIfNeeded(
      sidecarAgentId,
      activeTurn,
      descriptor,
      systemMessage,
      descriptorStatus,
    );

    if (systemMessage) {
      this.host.appendConversationEntry(sidecarAgentId, {
        type: "conversation_message",
        agentId: sidecarAgentId,
        role: "system",
        text: systemMessage,
        timestamp: this.host.now(),
        source: "system",
      });
    }

    if (runtime?.activeTurn) {
      this.cancelCompletionGrace(runtime.activeTurn);
      runtime.openCompletionGraceToken = 0;
      runtime.activeTurn.graceItemAcceptOpen = false;
      runtime.activeTurn.completionGraceToken = undefined;
      runtime.activeTurn = undefined;
    }

    if (descriptor && isExternalThreadDescriptor(descriptor)) {
      descriptor.status = descriptorStatus;
      descriptor.updatedAt = this.host.now();
      this.host.upsertDescriptor(descriptor);
      this.host.emitStatus(sidecarAgentId, descriptorStatus, 0);
      this.host.emitAgentsSnapshot();
    }
  }

  private async persistThreadId(descriptor: AgentDescriptor, threadId: string): Promise<void> {
    if (!isExternalThreadDescriptor(descriptor)) {
      throw new Error(`Expected Codex external-thread descriptor: ${descriptor.agentId}`);
    }

    descriptor.externalThread = {
      ...descriptor.externalThread,
      threadId,
    };
    descriptor.updatedAt = this.host.now();
    this.host.upsertDescriptor(descriptor);
    await this.host.saveStore();

    const auditState: CodexSidecarPersistedThreadState = {
      threadId,
      persisted: true,
    };

    if (this.host.writeSidecarThreadStateAudit) {
      await this.host.writeSidecarThreadStateAudit(descriptor.sessionFile, auditState, descriptor.cwd);
      this.host.logDebug("Persisted Codex sidecar thread audit entry", {
        customType: CODEX_THREAD_STATE_CUSTOM_TYPE,
        sidecarAgentId: descriptor.agentId,
        threadId,
      });
    }
  }

  private emitParentTurnAcceptedArtifacts(
    sidecarAgentId: string,
    activeTurn: CodexSidecarActiveTurn,
    text: string,
  ): void {
    const parentTurnContext = activeTurn.parentTurnContext;
    if (!parentTurnContext || parentTurnContext.sendAccepted) {
      return;
    }

    parentTurnContext.sendAccepted = true;

    if (parentTurnContext.emitParentRequestCard) {
      this.host.emitParentExternalThreadCard?.({
        managerAgentId: parentTurnContext.managerAgentId,
        sidecarAgentId,
        requestId: parentTurnContext.requestId,
        turnCorrelationId: parentTurnContext.turnCorrelationId,
        promptPreview: parentTurnContext.promptPreview,
        status: "sent",
        sourceContext: parentTurnContext.sourceContext,
      });
    }

    this.host.emitParentUserToCodexAgentMessage?.({
      managerAgentId: parentTurnContext.managerAgentId,
      sidecarAgentId,
      text,
      sourceContext: parentTurnContext.sourceContext,
    });
  }

  private emitParentTurnCompletionIfNeeded(
    sidecarAgentId: string,
    activeTurn: CodexSidecarActiveTurn | undefined,
    descriptor: AgentDescriptor | undefined,
    systemMessage: string | undefined,
    descriptorStatus: "idle" | "error",
  ): void {
    const parentTurnContext = activeTurn?.parentTurnContext;
    if (!parentTurnContext || !parentTurnContext.sendAccepted || parentTurnContext.parentCompletionEmitted) {
      return;
    }

    parentTurnContext.parentCompletionEmitted = true;

    let status: "completed" | "stopped" | "error" = "completed";
    if (descriptorStatus === "error") {
      status = "error";
    } else if (systemMessage?.includes("stopped")) {
      status = "stopped";
    }

    const resultPreview =
      status === "completed"
        ? activeTurn?.assistantText || systemMessage
        : systemMessage ?? activeTurn?.assistantText;

    this.host.emitParentExternalThreadCard?.({
      managerAgentId: parentTurnContext.managerAgentId,
      sidecarAgentId,
      requestId: parentTurnContext.requestId,
      turnCorrelationId: parentTurnContext.turnCorrelationId,
      promptPreview: parentTurnContext.promptPreview,
      resultPreview: resultPreview ? truncateCodexPreview(resultPreview) : undefined,
      threadId: descriptor?.externalThread?.threadId,
      status,
      sourceContext: parentTurnContext.sourceContext,
    });
  }
}
