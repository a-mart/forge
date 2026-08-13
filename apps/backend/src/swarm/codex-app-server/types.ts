import type {
  AgentDescriptor,
  AgentStatus,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent,
  AgentMessageEvent,
  AgentToolCallEvent,
  MessageSourceContext,
} from "../types.js";
import type { CodexDetailCounters, CodexTrackedDetailItem } from "./codex-app-server-event-normalizer.js";
import type { CodexLiveElicitation } from "./codex-elicitation-broker.js";

export const CODEX_SIDECAR_AGENT_ID_SUFFIX = "--codex";
export const CODEX_THREAD_STATE_CUSTOM_TYPE = "swarm_codex_app_server_thread_state";

export const DEFAULT_CODEX_SIDE_CAR_DEVELOPER_INSTRUCTIONS =
  "You are Codex running through the Forge sidecar. Answer concisely and use available apps/tools when helpful.";

export interface CodexSidecarPersistedThreadState {
  threadId: string;
  persisted: true;
}

export interface CodexSidecarHost {
  now(): string;
  logDebug(message: string, details?: unknown): void;
  getDescriptor(agentId: string): AgentDescriptor | undefined;
  upsertDescriptor(descriptor: AgentDescriptor): void;
  saveStore(): Promise<void>;
  ensureSessionFileParentDirectory(sessionFile: string): Promise<void>;
  appendConversationEntry(agentId: string, entry: ConversationEntryEvent): void;
  emitConversationMessage(event: ConversationMessageEvent): void;
  emitConversationLog(event: ConversationLogEvent): void;
  emitAgentMessage(event: AgentMessageEvent): void;
  emitAgentToolCall(event: AgentToolCallEvent): void;
  emitStatus(agentId: string, status: AgentStatus, pendingCount: number): void;
  reportAttentionStatusTransition(input: {
    agentId: string;
    previousStatus: AgentStatus;
    nextStatus: AgentStatus;
    transitionedAt: string;
  }): Promise<void>;
  emitAgentsSnapshot(): void;
  emitProfilesSnapshot(): void;
  listWorkersForSession(sessionAgentId: string): AgentDescriptor[];
  /** Ephemeral only: never persist MCP elicitation request metadata or form values. */
  emitCodexElicitation?(event: CodexLiveElicitation): void;
  dismissCodexElicitation?(elicitationId: string, managerAgentId: string): void;
  readSidecarThreadStateFallback?(sessionFile: string): CodexSidecarPersistedThreadState | undefined;
  writeSidecarThreadStateAudit?(
    sessionFile: string,
    state: CodexSidecarPersistedThreadState,
    cwd: string,
  ): Promise<void>;
  emitParentExternalThreadCard?(params: CodexSidecarParentTurnNotification): void;
  emitParentUserToCodexAgentMessage?(params: {
    managerAgentId: string;
    sidecarAgentId: string;
    text: string;
    sourceContext?: MessageSourceContext;
    attachmentCount?: number;
  }): void;
}

export interface CodexSidecarParentTurnNotification {
  managerAgentId: string;
  sidecarAgentId: string;
  requestId: string;
  turnCorrelationId: string;
  promptPreview?: string;
  resultPreview?: string;
  threadId?: string;
  status: "sent" | "running" | "completed" | "stopped" | "error";
  sourceContext?: MessageSourceContext;
}

export interface CodexSidecarParentTurnContext {
  managerAgentId: string;
  requestId: string;
  turnCorrelationId: string;
  promptPreview?: string;
  emitParentRequestCard: boolean;
  sourceContext?: MessageSourceContext;
  sendAccepted: boolean;
  parentCompletionEmitted: boolean;
}

export interface CodexAppServerClientHandlers {
  onNotification?: (method: string, params?: unknown) => void | Promise<void>;
  onRequest?: (method: string, params?: unknown) => Promise<unknown>;
  onExit?: (error: Error) => void;
  onStderr?: (line: string) => void;
}

export interface CodexAppServerClientPort {
  connect(): Promise<void>;
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  dispose(): void;
  isDisposed(): boolean;
}

export type CodexAppServerClientFactory = (
  handlers: CodexAppServerClientHandlers,
) => CodexAppServerClientPort;

export interface CodexAppServerProbeResult {
  ok: boolean;
  initialized: boolean;
  error?: string;
}

export const DEFAULT_TURN_COMPLETION_GRACE_MS = 500;

export interface CodexSidecarActiveTurn {
  turnId: string;
  correlationId: string;
  userText: string;
  startedAt: string;
  assistantText: string;
  assistantMessageEmitted: boolean;
  suppressed: boolean;
  interruptInProgress?: boolean;
  turnEpoch: number;
  turnCompletedPending?: boolean;
  agentMessageItemCompleted?: boolean;
  agentMessageCompletionSource?: "item_completed" | "turn_completed_summary";
  deferTurnlessCompletionUntilGraceExpires?: boolean;
  guardedTurnlessCompletionText?: string;
  completionSystemMessage?: string;
  completionDescriptorStatus?: "idle" | "error";
  completionParentStatusOverride?: "completed" | "stopped" | "error";
  /** Token issued when this turn entered completion grace; gates turnless item/completed. */
  completionGraceToken?: number;
  graceItemAcceptOpen?: boolean;
  completionGraceTimer?: ReturnType<typeof setTimeout>;
  parentTurnContext?: CodexSidecarParentTurnContext;
  codexItemsById?: Map<string, CodexTrackedDetailItem>;
  codexDetailCounters?: CodexDetailCounters;
}

export interface CodexSidecarRuntimeState {
  activeTurn?: CodexSidecarActiveTurn;
  /** Monotonic sidecar turn generation; increments on each new sendTextTurn. */
  turnEpoch: number;
  /** Grace token for the turn currently in completion grace, if any. */
  openCompletionGraceToken: number;
}

export class CodexSidecarBusyError extends Error {
  /** Sidecar that currently owns the shared-client active turn. */
  readonly sidecarAgentId: string;
  readonly requestedSidecarAgentId?: string;

  constructor(activeSidecarAgentId: string, requestedSidecarAgentId?: string) {
    const sameSidecar =
      !requestedSidecarAgentId || requestedSidecarAgentId === activeSidecarAgentId;
    super(
      sameSidecar
        ? `Codex sidecar ${activeSidecarAgentId} already has an active turn`
        : `Codex shared client busy: ${activeSidecarAgentId} has the active turn (requested ${requestedSidecarAgentId})`,
    );
    this.name = "CodexSidecarBusyError";
    this.sidecarAgentId = activeSidecarAgentId;
    this.requestedSidecarAgentId = requestedSidecarAgentId;
  }
}

export interface CodexAppServerServiceOptions {
  dataDir: string;
  developerInstructions?: string;
  createClient?: CodexAppServerClientFactory;
  defaultRequestTimeoutMs?: number;
  /** Grace period after turn/completed before clearing active turn without item/completed. */
  turnCompletionGraceMs?: number;
  /** Fail-closed expiry for an unanswered MCP elicitation. */
  elicitationTimeoutMs?: number;
}

export interface CodexSendTextTurnOptions {
  correlationId?: string;
  requestId?: string;
  promptPreview?: string;
  parentRouting?: {
    managerAgentId: string;
    emitParentRequestCard: boolean;
    sourceContext?: MessageSourceContext;
  };
}
