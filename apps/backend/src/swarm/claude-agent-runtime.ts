import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ClaudeAuthResolver } from "./claude-auth-resolver.js";
import { claudeSessionDir, claudeWorkerDir } from "./claude-data-paths.js";
import { isEnoentError, normalizeOptionalString } from "./claude-utils.js";
import { getSessionFilePath, getWorkerSessionFilePath } from "./data-paths.js";
import { ClaudeQuerySession, type ClaudeEffort, type ClaudeThinkingConfig } from "./claude-query-session.js";
import { loadClaudeSdkModule } from "./claude-sdk-loader.js";
import { resizeImageIfNeeded } from "./image-utils.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { extractMessageText, extractRole } from "./message-utils.js";
import { buildRuntimeMessageKey, normalizeRuntimeUserMessage } from "./runtime-utils.js";
import { openSessionManagerWithSizeGuard } from "./session-file-guard.js";
import type {
  RuntimeShutdownOptions,
  RuntimeUserMessage,
  RuntimeUserMessageInput,
  SmartCompactResult,
  SpecialistFallbackReplaySnapshot,
  SwarmAgentRuntime,
  SwarmRuntimeCallbacks
} from "./runtime-types.js";
import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

export interface ClaudeAgentRuntimeOptions {
  descriptor: AgentDescriptor;
  systemPrompt: string;
  callbacks: SwarmRuntimeCallbacks;
  dataDir: string;
  profileId: string;
  sessionId: string;
  workerId?: string;
  authResolver?: ClaudeAuthResolver;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  runtimeEnv?: Record<string, string>;
  modelContextWindow?: number;
}

interface RuntimeCustomEntry {
  id: string;
  data: unknown;
}

interface ClaudeRuntimeStateEntry {
  claudeSessionId: string | null;
  generationId: number;
  lastCheckpointAt: string;
}

interface ClaudeCompactionSummaryEntry {
  generationId: number;
  summary: string;
  compactedAt: string;
}

interface HiddenTurnCapture {
  kind: "compaction_summary";
  assistantText: string;
  runtimeError: Error | undefined;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
export const CLAUDE_RUNTIME_STATE_ENTRY_TYPE = "swarm_claude_session_state";
const CLAUDE_COMPACTION_SUMMARY_ENTRY_TYPE = "swarm_claude_compaction_summary";
const CLAUDE_CONVERSATION_ENTRY_TYPE = "swarm_conversation_entry";
const CLAUDE_SMART_COMPACT_THRESHOLD_PERCENT = 80;
const SESSION_HEADER_VERSION = 3;

export class ClaudeAgentRuntime implements SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;
  readonly runtimeType = "claude" as const;

  private readonly callbacks: SwarmRuntimeCallbacks;
  private readonly dataDir: string;
  private readonly baseSystemPrompt: string;
  private readonly authResolver: ClaudeAuthResolver;
  private readonly sessionDataDir: string;
  private readonly sessionFilePath: string;
  private readonly mcpServers: Record<string, unknown>;
  private readonly allowedTools: string[];
  private readonly runtimeEnvOverrides: Record<string, string>;
  private readonly modelContextWindow: number | undefined;
  private readonly customEntries = new Map<string, RuntimeCustomEntry[]>();

  private persistedRuntimeState: ClaudeRuntimeStateEntry | undefined;
  private persistedCompactionSummary: ClaudeCompactionSummaryEntry | undefined;
  private lastSessionEntryId: string | null = null;

  private activeSystemPrompt: string;
  private activeSession: ClaudeQuerySession | undefined;
  private activeSessionToken = 0;
  private startupPromise: Promise<ClaudeQuerySession> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();
  private status: AgentStatus;
  private pendingCount = 0;
  private contextUsage: AgentContextUsage | undefined;
  private contextRecoveryInProgress = false;
  private generation = 0;
  private readonly liveReplayMessages: RuntimeUserMessage[] = [];
  private hiddenTurnCapture: HiddenTurnCapture | undefined;

  constructor(options: ClaudeAgentRuntimeOptions) {
    this.descriptor = options.descriptor;
    this.callbacks = options.callbacks;
    this.dataDir = resolve(options.dataDir);
    this.baseSystemPrompt = options.systemPrompt;
    this.activeSystemPrompt = options.systemPrompt;
    this.status = options.descriptor.status;
    this.authResolver = options.authResolver ?? new ClaudeAuthResolver(this.dataDir);
    this.sessionDataDir = resolve(
      options.workerId
        ? claudeWorkerDir(this.dataDir, options.profileId, options.sessionId, options.workerId)
        : claudeSessionDir(this.dataDir, options.profileId, options.sessionId)
    );
    const sessionFilePath = resolve(
      options.workerId
        ? getWorkerSessionFilePath(this.dataDir, options.profileId, options.sessionId, options.workerId)
        : getSessionFilePath(this.dataDir, options.profileId, options.sessionId)
    );
    const sessionManager = openSessionManagerWithSizeGuard(sessionFilePath, {
      context: `runtime:create:claude:${options.descriptor.agentId}`,
      rotateOversizedFile: true
    });
    if (!sessionManager) {
      throw new Error(`Unable to open session file for agent ${options.descriptor.agentId}: ${sessionFilePath}`);
    }

    this.sessionFilePath = sessionFilePath;
    for (const entry of sessionManager.getEntries()) {
      this.lastSessionEntryId = entry.id;
      if (entry.type !== "custom") {
        continue;
      }

      const existing = this.customEntries.get(entry.customType) ?? [];
      existing.push({ id: entry.id, data: entry.data });
      this.customEntries.set(entry.customType, existing);
    }

    this.mcpServers = { ...(options.mcpServers ?? {}) };
    this.allowedTools = [...(options.allowedTools ?? [])];
    this.runtimeEnvOverrides = { ...(options.runtimeEnv ?? {}) };
    this.modelContextWindow =
      options.modelContextWindow ?? modelCatalogService.getEffectiveContextWindow(options.descriptor.model.modelId);
    this.persistedRuntimeState = this.readPersistedRuntimeState();
    this.persistedCompactionSummary = this.readPersistedCompactionSummary();
    this.generation = this.persistedRuntimeState?.generationId ?? 0;
    this.activeSystemPrompt = this.buildActiveSystemPrompt(this.persistedCompactionSummary?.summary);
  }

  getStatus(): AgentStatus {
    return this.activeSession?.getStatus() ?? this.status;
  }

  getPendingCount(): number {
    return this.activeSession?.getPendingCount() ?? this.pendingCount;
  }

  getContextUsage(): AgentContextUsage | undefined {
    return this.activeSession?.getContextUsage() ?? this.contextUsage;
  }

  getSystemPrompt(): string {
    return this.activeSystemPrompt;
  }

  isContextRecoveryInProgress(): boolean {
    return this.contextRecoveryInProgress;
  }

  async sendMessage(
    input: RuntimeUserMessageInput,
    requestedMode: RequestedDeliveryMode = "auto"
  ): Promise<SendMessageReceipt> {
    return await this.runExclusive(async () => {
      this.ensureNotTerminated();

      const session = await this.ensureSessionStarted();
      const normalizedInput = await this.normalizeAndResizeMessage(input);

      try {
        const receipt = await session.sendInput(normalizedInput, requestedMode);
        this.liveReplayMessages.push(cloneRuntimeUserMessage(normalizedInput));
        return receipt;
      } catch (error) {
        if (isUnusableClaudeSessionStatus(session.getStatus())) {
          this.clearActiveSessionReference(session);
        }

        throw error;
      }
    });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return await this.runExclusive(async () => {
      this.ensureNotTerminated();
      if (this.contextRecoveryInProgress) {
        throw new Error(`Claude runtime for agent ${this.descriptor.agentId} is already compacting.`);
      }

      const session = await this.ensureSessionStarted();
      if (session.getPendingCount() > 0) {
        throw new Error(`Claude runtime compaction requires agent ${this.descriptor.agentId} to be idle.`);
      }

      if (session.getStatus() !== "idle") {
        await session.waitForIdle();
      }

      if (session.getStatus() !== "idle" || session.getPendingCount() > 0) {
        throw new Error(`Claude runtime compaction requires agent ${this.descriptor.agentId} to be idle.`);
      }

      this.contextRecoveryInProgress = true;

      try {
        const summary = await this.captureCompactionSummary(session, customInstructions);
        const detachedSession = this.detachActiveSession();
        await this.stopDetachedSession(detachedSession, {
          abort: true,
          shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS
        });

        this.liveReplayMessages.length = 0;
        this.generation += 1;
        this.persistCompactionSummary(summary);
        this.activeSystemPrompt = this.buildActiveSystemPrompt(summary);
        this.persistRuntimeState({ claudeSessionId: null, generationId: this.generation });
        await this.resetToIdleState();
        await this.ensureSessionStarted();

        return {
          generationId: this.generation,
          mode: "summary_rollover",
          summary
        };
      } catch (error) {
        await this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
          phase: "compaction",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {})
        });
        throw error;
      } finally {
        this.contextRecoveryInProgress = false;
        await this.emitStatus();
      }
    });
  }

  async smartCompact(customInstructions?: string): Promise<SmartCompactResult> {
    this.ensureNotTerminated();

    const usage = this.getContextUsage();
    if (!usage) {
      return {
        compactionSucceeded: false,
        compactionFailureReason: "claude_runtime_context_usage_unknown"
      };
    }

    if (usage.percent < CLAUDE_SMART_COMPACT_THRESHOLD_PERCENT) {
      return {
        compactionSucceeded: false,
        compactionFailureReason: "claude_runtime_below_compaction_threshold"
      };
    }

    try {
      await this.compact(customInstructions);
      return {
        compactionSucceeded: true
      };
    } catch (error) {
      return {
        compactionSucceeded: false,
        compactionFailureReason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async stopInFlight(options?: RuntimeShutdownOptions): Promise<void> {
    await this.runExclusive(async () => {
      if (this.status === "terminated") {
        return;
      }

      const session = this.detachActiveSession();
      await this.stopDetachedSession(session, options);
      await this.resetToIdleState();
    });
  }

  async terminate(options?: RuntimeShutdownOptions): Promise<void> {
    await this.runExclusive(async () => {
      if (this.status === "terminated") {
        return;
      }

      const session = this.detachActiveSession();
      await this.terminateDetachedSession(session, options);

      this.liveReplayMessages.length = 0;
      this.pendingCount = 0;
      this.contextUsage = undefined;
      this.contextRecoveryInProgress = false;
      this.status = "terminated";
      this.descriptor.status = "terminated";
      this.descriptor.contextUsage = undefined;
      this.descriptor.updatedAt = nowIso();
      await this.emitStatus();
    });
  }

  async recycle(): Promise<void> {
    await this.runExclusive(async () => {
      this.ensureNotTerminated();

      this.resetPersistedStateIfSessionFileWasExternallyCleared();

      const session = this.detachActiveSession();
      await this.stopDetachedSession(session, {
        abort: true,
        shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS
      });

      this.liveReplayMessages.length = 0;
      this.activeSystemPrompt = this.buildActiveSystemPrompt(this.persistedCompactionSummary?.summary);
      await this.resetToIdleState();
      this.generation += 1;
      this.persistRuntimeState({ claudeSessionId: null, generationId: this.generation });
      await this.ensureSessionStarted();
    });
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

    // Intentionally bypass SessionManager.appendCustomEntry() here: SessionManager defers
    // persisting entries until it has seen an assistant message on that manager instance.
    // Claude runtime state and replay metadata must hit disk immediately, even before any
    // assistant transcript entries have been projected, so recycle/resume can recover them.
    this.ensureSessionFileHeader();
    this.appendCustomEntryToSessionFile({
      type: "custom",
      customType,
      data,
      id: entryId,
      parentId: this.lastSessionEntryId,
      timestamp: nowIso()
    });
    this.lastSessionEntryId = entryId;
    return entryId;
  }

  async prepareForSpecialistFallbackReplay(): Promise<SpecialistFallbackReplaySnapshot | undefined> {
    const persistedMessages = this.loadPersistedReplayMessages();
    const replayMessages = appendLiveReplaySuffix(persistedMessages, this.liveReplayMessages);

    if (replayMessages.length === 0) {
      return undefined;
    }

    return {
      messages: replayMessages
    };
  }

  async restorePreparedSpecialistFallbackReplay(): Promise<void> {
    // Phase 5 will restore preserved replay snapshots.
  }

  private async ensureSessionStarted(): Promise<ClaudeQuerySession> {
    const activeSession = this.activeSession;
    if (activeSession && !isUnusableClaudeSessionStatus(activeSession.getStatus())) {
      return activeSession;
    }

    if (activeSession) {
      this.clearActiveSessionReference(activeSession);
    }

    if (!this.startupPromise) {
      this.startupPromise = this.createAndStartSession().finally(() => {
        this.startupPromise = undefined;
      });
    }

    return await this.startupPromise;
  }

  private async createAndStartSession(): Promise<ClaudeQuerySession> {
    const sdk = await loadClaudeSdkModule();
    const runtimeEnv = await this.initializeRuntimeEnv();
    const thinkingConfig = buildClaudeReasoningConfig(this.descriptor.model.thinkingLevel);
    const resumeSessionId = this.persistedRuntimeState?.claudeSessionId ?? undefined;

    if (!resumeSessionId) {
      return await this.startQuerySession({ sdk, runtimeEnv, thinkingConfig });
    }

    try {
      return await this.startQuerySession({ sdk, runtimeEnv, thinkingConfig, resumeSessionId });
    } catch (error) {
      await this.callbacks.onRuntimeError?.(this.descriptor.agentId, {
        phase: "thread_resume",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        details: {
          claudeSessionId: resumeSessionId
        }
      });

      this.generation += 1;
      this.persistRuntimeState({ claudeSessionId: null, generationId: this.generation });
      return await this.startQuerySession({ sdk, runtimeEnv, thinkingConfig });
    }
  }

  private async startQuerySession(options: {
    sdk: Awaited<ReturnType<typeof loadClaudeSdkModule>>;
    runtimeEnv: Record<string, string>;
    thinkingConfig: ReturnType<typeof buildClaudeReasoningConfig>;
    resumeSessionId?: string;
  }): Promise<ClaudeQuerySession> {
    const sessionToken = this.activeSessionToken + 1;
    const querySession = new ClaudeQuerySession({
      sdk: options.sdk,
      config: {
        model: this.descriptor.model.modelId,
        systemPrompt: this.activeSystemPrompt,
        cwd: this.descriptor.cwd,
        contextWindow: this.modelContextWindow,
        thinking: options.thinkingConfig.thinking,
        effort: options.thinkingConfig.effort,
        env: options.runtimeEnv
      },
      callbacks: {
        agentId: this.descriptor.agentId,
        onStatusChange: async (agentId, status, pendingCount, contextUsage) => {
          if (sessionToken !== this.activeSessionToken) {
            return;
          }

          this.status = status;
          this.pendingCount = pendingCount;
          this.contextUsage = contextUsage;
          this.descriptor.status = status;
          this.descriptor.contextUsage = contextUsage;
          this.descriptor.updatedAt = nowIso();

          if (this.hiddenTurnCapture) {
            return;
          }

          await this.callbacks.onStatusChange(agentId, status, pendingCount, contextUsage);
        },
        onSessionEvent: async (event) => {
          if (sessionToken !== this.activeSessionToken) {
            return;
          }

          if (this.hiddenTurnCapture) {
            this.captureHiddenTurnEvent(event);
            return;
          }

          await this.callbacks.onSessionEvent?.(this.descriptor.agentId, event);
        },
        onSessionIdChange: async (claudeSessionId) => {
          if (sessionToken !== this.activeSessionToken) {
            return;
          }

          this.persistRuntimeState({ claudeSessionId, generationId: this.generation });
        },
        onAgentEnd: async (agentId) => {
          if (sessionToken !== this.activeSessionToken) {
            return;
          }

          if (this.hiddenTurnCapture) {
            return;
          }

          await this.callbacks.onAgentEnd?.(agentId);
        },
        onRuntimeError: async (agentId, error) => {
          if (sessionToken !== this.activeSessionToken) {
            return;
          }

          if (this.hiddenTurnCapture) {
            this.hiddenTurnCapture.runtimeError = new Error(error.message);
            return;
          }

          await this.callbacks.onRuntimeError?.(agentId, error);
        }
      },
      mcpServers: this.mcpServers,
      allowedTools: this.allowedTools,
      ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {})
    });

    this.activeSession = querySession;
    this.activeSessionToken = sessionToken;

    try {
      await querySession.start();
      this.persistRuntimeState({
        claudeSessionId: querySession.getSdkSessionId() ?? null,
        generationId: this.generation
      });
      return querySession;
    } catch (error) {
      this.clearActiveSessionReference(querySession);
      await this.terminateDetachedSession(querySession, {
        abort: true,
        shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS
      });
      throw error;
    }
  }

  private detachActiveSession(): ClaudeQuerySession | undefined {
    const session = this.activeSession;
    this.activeSession = undefined;
    this.activeSessionToken += 1;
    this.startupPromise = undefined;
    return session;
  }

  private clearActiveSessionReference(session: ClaudeQuerySession): void {
    if (this.activeSession !== session) {
      return;
    }

    this.activeSession = undefined;
    this.activeSessionToken += 1;
    this.startupPromise = undefined;
  }

  private async stopDetachedSession(
    session: ClaudeQuerySession | undefined,
    options?: RuntimeShutdownOptions
  ): Promise<void> {
    if (!session) {
      return;
    }

    const shutdownTimeoutMs = options?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const shouldAbort = options?.abort ?? true;

    try {
      if (shouldAbort) {
        await runWithTimeout(
          (async () => {
            await session.interrupt();
            await session.stop();
          })(),
          shutdownTimeoutMs,
          `claude_stop_in_flight:${this.descriptor.agentId}`
        );
        return;
      }

      await runWithTimeout(session.stop(), shutdownTimeoutMs, `claude_stop:${this.descriptor.agentId}`);
    } catch {
      await this.terminateDetachedSession(session, options);
    }
  }

  private async terminateDetachedSession(
    session: ClaudeQuerySession | undefined,
    options?: RuntimeShutdownOptions
  ): Promise<void> {
    if (!session) {
      return;
    }

    const shutdownTimeoutMs = options?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;

    try {
      await runWithTimeout(session.terminate(), shutdownTimeoutMs, `claude_terminate:${this.descriptor.agentId}`);
    } catch {
      // Best-effort teardown. The detached session callbacks are already ignored.
    }
  }

  private readPersistedRuntimeState(): ClaudeRuntimeStateEntry | undefined {
    const entries = this.getCustomEntries(CLAUDE_RUNTIME_STATE_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const parsed = parseClaudeRuntimeStateEntry(entries[index]);
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private persistRuntimeState(next: {
    claudeSessionId: string | null;
    generationId: number;
  }): void {
    const normalizedSessionId = normalizeOptionalString(next.claudeSessionId) ?? null;
    const previous = this.persistedRuntimeState;

    if (
      previous &&
      previous.claudeSessionId === normalizedSessionId &&
      previous.generationId === next.generationId
    ) {
      return;
    }

    const persisted: ClaudeRuntimeStateEntry = {
      claudeSessionId: normalizedSessionId,
      generationId: next.generationId,
      lastCheckpointAt: nowIso()
    };

    this.appendCustomEntry(CLAUDE_RUNTIME_STATE_ENTRY_TYPE, persisted);
    this.persistedRuntimeState = persisted;
  }

  private appendCustomEntryToSessionFile(entry: {
    type: "custom";
    customType: string;
    data?: unknown;
    id: string;
    parentId: string | null;
    timestamp: string;
  }): void {
    appendFileSync(this.sessionFilePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private ensureSessionFileHeader(): void {
    if (hasValidSessionHeader(this.sessionFilePath)) {
      return;
    }

    const headerLine = `${JSON.stringify({
      type: "session",
      version: SESSION_HEADER_VERSION,
      id: generateSessionEntryId(),
      timestamp: nowIso(),
      cwd: this.descriptor.cwd
    })}\n`;

    writeFileSync(this.sessionFilePath, headerLine, "utf8");
    this.lastSessionEntryId = null;
  }

  private async resetToIdleState(): Promise<void> {
    this.pendingCount = 0;
    this.contextUsage = undefined;
    this.contextRecoveryInProgress = false;
    this.status = "idle";
    this.descriptor.status = "idle";
    this.descriptor.contextUsage = undefined;
    this.descriptor.updatedAt = nowIso();
    await this.emitStatus();
  }

  private async initializeRuntimeEnv(): Promise<Record<string, string>> {
    await mkdir(this.sessionDataDir, { recursive: true });

    return {
      ...this.runtimeEnvOverrides,
      ...(await this.authResolver.buildEnv(this.sessionDataDir))
    };
  }

  private async captureCompactionSummary(
    session: ClaudeQuerySession,
    customInstructions?: string
  ): Promise<string> {
    if (this.hiddenTurnCapture) {
      throw new Error(`Claude runtime for agent ${this.descriptor.agentId} is already capturing a hidden turn.`);
    }

    this.hiddenTurnCapture = {
      kind: "compaction_summary",
      assistantText: "",
      runtimeError: undefined
    };

    try {
      await session.sendInput(buildClaudeCompactionSummaryPrompt(customInstructions), "auto");
      await session.waitForIdle();

      if (this.hiddenTurnCapture.runtimeError instanceof Error) {
        throw this.hiddenTurnCapture.runtimeError;
      }

      const summary = this.hiddenTurnCapture.assistantText.trim();
      if (!summary) {
        throw new Error(`Claude runtime compaction produced an empty summary for agent ${this.descriptor.agentId}.`);
      }

      return summary;
    } finally {
      this.hiddenTurnCapture = undefined;
    }
  }

  private captureHiddenTurnEvent(event: {
    type: string;
    message?: unknown;
  }): void {
    if (!this.hiddenTurnCapture || (event.type !== "message_update" && event.type !== "message_end")) {
      return;
    }

    if (extractRole(event.message) !== "assistant") {
      return;
    }

    const text = extractMessageText(event.message);
    if (text?.trim()) {
      this.hiddenTurnCapture.assistantText = text;
    }
  }

  private readPersistedCompactionSummary(): ClaudeCompactionSummaryEntry | undefined {
    const entries = this.getCustomEntries(CLAUDE_COMPACTION_SUMMARY_ENTRY_TYPE);

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const parsed = parseClaudeCompactionSummaryEntry(entries[index]);
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private persistCompactionSummary(summary: string): void {
    const normalizedSummary = summary.trim();
    if (!normalizedSummary) {
      return;
    }

    const persisted: ClaudeCompactionSummaryEntry = {
      generationId: this.generation,
      summary: normalizedSummary,
      compactedAt: nowIso()
    };

    this.appendCustomEntry(CLAUDE_COMPACTION_SUMMARY_ENTRY_TYPE, persisted);
    this.persistedCompactionSummary = persisted;
  }

  private buildActiveSystemPrompt(summary?: string): string {
    const normalizedSummary = normalizeOptionalString(summary);
    if (!normalizedSummary) {
      return this.baseSystemPrompt;
    }

    return [
      this.baseSystemPrompt,
      "# Compacted Conversation Summary",
      "The prior Claude conversation was rolled over into a fresh generation. Treat the following summary as authoritative prior context for this session:",
      normalizedSummary
    ].join("\n\n");
  }

  private loadPersistedReplayMessages(): RuntimeUserMessage[] {
    const persistedEntries = this.getCustomEntries(CLAUDE_CONVERSATION_ENTRY_TYPE);
    const replayMessages: RuntimeUserMessage[] = [];

    for (const entry of persistedEntries) {
      const message = toReplayMessageFromConversationEntry(entry, this.descriptor.agentId);
      if (message) {
        replayMessages.push(message);
      }
    }

    return replayMessages;
  }

  private resetPersistedStateIfSessionFileWasExternallyCleared(): void {
    if (!isMissingOrEmptySessionFile(this.sessionFilePath)) {
      return;
    }

    this.customEntries.clear();
    this.lastSessionEntryId = null;
    this.persistedRuntimeState = undefined;
    this.persistedCompactionSummary = undefined;
    this.activeSystemPrompt = this.baseSystemPrompt;
  }

  private async normalizeAndResizeMessage(input: RuntimeUserMessageInput): Promise<RuntimeUserMessage> {
    const normalized = normalizeRuntimeUserMessage(input);
    const resizedImages = [];

    for (const image of normalized.images ?? []) {
      resizedImages.push(await resizeImageIfNeeded(image.data, image.mimeType));
    }

    return {
      text: normalized.text,
      images: resizedImages
    };
  }

  private ensureNotTerminated(): void {
    if (this.status === "terminated") {
      throw new Error(`Agent ${this.descriptor.agentId} is terminated`);
    }
  }

  private async emitStatus(): Promise<void> {
    await this.callbacks.onStatusChange(
      this.descriptor.agentId,
      this.status,
      this.pendingCount,
      this.contextUsage
    );
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: (() => void) | undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => {
      // Preserve queue progress even if a prior operation rejected.
    });

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

const CLAUDE_HIGH_THINKING_BUDGET_TOKENS = 4_096;
const CLAUDE_MAX_THINKING_BUDGET_TOKENS = 16_384;

type ClaudeReasoningLevel = "none" | "low" | "medium" | "high" | "xhigh";

function buildClaudeReasoningConfig(reasoningLevel: string | undefined): {
  thinking: ClaudeThinkingConfig | undefined;
  effort: ClaudeEffort | undefined;
} {
  return {
    thinking: mapReasoningToClaudeThinking(reasoningLevel),
    effort: mapReasoningToClaudeEffort(reasoningLevel)
  };
}

export function mapReasoningToClaudeEffort(reasoningLevel: string | undefined): ClaudeEffort | undefined {
  switch (normalizeClaudeReasoningLevel(reasoningLevel)) {
    case "none":
    case "low":
      return "low";

    case "medium":
      return "medium";

    case "high":
      return "high";

    case "xhigh":
      return "max";

    default:
      return undefined;
  }
}

export function mapReasoningToClaudeThinking(reasoningLevel: string | undefined): ClaudeThinkingConfig | undefined {
  switch (normalizeClaudeReasoningLevel(reasoningLevel)) {
    case "none":
    case "low":
      return { type: "disabled" };

    case "medium":
      return { type: "adaptive" };

    case "high":
      return {
        type: "enabled",
        budgetTokens: CLAUDE_HIGH_THINKING_BUDGET_TOKENS
      };

    case "xhigh":
      return {
        type: "enabled",
        budgetTokens: CLAUDE_MAX_THINKING_BUDGET_TOKENS
      };

    default:
      return undefined;
  }
}

function normalizeClaudeReasoningLevel(reasoningLevel: string | undefined): ClaudeReasoningLevel | undefined {
  if (typeof reasoningLevel !== "string") {
    return undefined;
  }

  const normalized = reasoningLevel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "x-high") {
    return "xhigh";
  }

  if (
    normalized === "none"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
  ) {
    return normalized;
  }

  return undefined;
}

function isUnusableClaudeSessionStatus(status: AgentStatus): boolean {
  return status === "error" || status === "stopped" || status === "terminated";
}

function parseClaudeRuntimeStateEntry(value: unknown): ClaudeRuntimeStateEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entry = value as {
    claudeSessionId?: unknown;
    generationId?: unknown;
    lastCheckpointAt?: unknown;
  };
  const claudeSessionId = normalizeOptionalString(entry.claudeSessionId) ?? null;
  const generationId =
    typeof entry.generationId === "number" && Number.isFinite(entry.generationId) && entry.generationId >= 0
      ? Math.floor(entry.generationId)
      : undefined;
  const lastCheckpointAt = normalizeOptionalString(entry.lastCheckpointAt) ?? nowIso();

  if (generationId === undefined) {
    return undefined;
  }

  return {
    claudeSessionId,
    generationId,
    lastCheckpointAt
  };
}

function parseClaudeCompactionSummaryEntry(value: unknown): ClaudeCompactionSummaryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const entry = value as {
    generationId?: unknown;
    summary?: unknown;
    compactedAt?: unknown;
  };
  const generationId =
    typeof entry.generationId === "number" && Number.isFinite(entry.generationId) && entry.generationId >= 0
      ? Math.floor(entry.generationId)
      : undefined;
  const summary = normalizeOptionalString(entry.summary);
  const compactedAt = normalizeOptionalString(entry.compactedAt) ?? nowIso();

  if (generationId === undefined || !summary) {
    return undefined;
  }

  return {
    generationId,
    summary,
    compactedAt
  };
}

function buildClaudeCompactionSummaryPrompt(customInstructions?: string): string {
  const normalizedInstructions = normalizeOptionalString(customInstructions);
  const sections = [
    "INTERNAL COMPACTION TASK: Summarize the conversation so far for a fresh Claude session generation.",
    "Do not continue the user's task.",
    "Do not ask follow-up questions.",
    "Do not use any tools.",
    "Return only a concise markdown summary with these headings:",
    "## Current Objective",
    "## Important Context",
    "## Decisions and Constraints",
    "## Open Work",
    "## Files and Commands (only if important)",
    "Capture anything the next generation must know to continue safely. Keep it compact but specific."
  ];

  if (normalizedInstructions) {
    sections.push("Additional compaction instructions:", normalizedInstructions);
  }

  return sections.join("\n\n");
}

function toReplayMessageFromConversationEntry(entry: unknown, agentId: string): RuntimeUserMessage | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }

  const candidate = entry as {
    type?: unknown;
    role?: unknown;
    text?: unknown;
    toAgentId?: unknown;
  };
  const text = typeof candidate.text === "string" ? candidate.text : "";
  if (!text.trim()) {
    return undefined;
  }

  if (candidate.type === "conversation_message" && candidate.role === "user") {
    return {
      text,
      images: []
    };
  }

  if (candidate.type === "agent_message" && candidate.toAgentId === agentId) {
    return {
      text,
      images: []
    };
  }

  return undefined;
}

function appendLiveReplaySuffix(
  persistedMessages: RuntimeUserMessage[],
  liveMessages: RuntimeUserMessage[]
): RuntimeUserMessage[] {
  const merged = persistedMessages.map((message) => cloneRuntimeUserMessage(message));
  if (liveMessages.length === 0) {
    return merged;
  }

  let overlap = 0;
  const maxOverlap = Math.min(merged.length, liveMessages.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const persistedSuffix = merged.slice(merged.length - size);
    const livePrefix = liveMessages.slice(0, size);
    if (persistedSuffix.every((message, index) => areReplayMessagesEquivalent(message, livePrefix[index]!))) {
      overlap = size;
      break;
    }
  }

  for (const message of liveMessages.slice(overlap)) {
    merged.push(cloneRuntimeUserMessage(message));
  }

  return merged;
}

function areReplayMessagesEquivalent(left: RuntimeUserMessage, right: RuntimeUserMessage): boolean {
  const leftKey = buildRuntimeMessageKey(left);
  const rightKey = buildRuntimeMessageKey(right);
  if (leftKey === rightKey) {
    return true;
  }

  return (
    left.text.trim() === right.text.trim() &&
    ((left.images?.length ?? 0) === 0 || (right.images?.length ?? 0) === 0)
  );
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

    const parsed = JSON.parse(firstLine) as { type?: unknown; version?: unknown; id?: unknown; cwd?: unknown };
    return (
      parsed.type === "session" &&
      typeof parsed.id === "string" &&
      parsed.id.trim().length > 0 &&
      typeof parsed.cwd === "string"
    );
  } catch {
    return false;
  }
}

function isMissingOrEmptySessionFile(sessionFilePath: string): boolean {
  try {
    return statSync(sessionFilePath).size === 0;
  } catch (error) {
    return isEnoentError(error);
  }
}

function generateSessionEntryId(): string {
  return Math.random().toString(16).slice(2, 10);
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
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

function nowIso(): string {
  return new Date().toISOString();
}
