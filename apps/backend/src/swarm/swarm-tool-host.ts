import type {
  AgentDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  MessageSourceContext,
  MessageTargetContext,
  RequestedDeliveryMode,
  SendMessageReceipt,
  SpawnAgentInput
} from "./types.js";
import type { CodexCatalogSnapshot, CodexMcpToolCallResult } from "./codex-app-server/codex-mcp-catalog.js";
import type {
  CodexPluginExportFormat,
  CodexPluginScopedExportResult,
  CodexPluginScopeRuntimeView,
} from "./codex-app-server/codex-plugin-scope-service.js";
import type { TaskToolInput, TaskToolResult } from "./coordination/task-tool.js";

export interface SwarmToolSideEffectEvent {
  toolName: string;
  toolCallId: string;
  phase: "before" | "after" | "side_effect";
  input?: unknown;
  output?: unknown;
  isError?: boolean;
  userVisible?: boolean;
  metadata?: Record<string, unknown>;
}

export interface SwarmToolHost {
  listAgents(): AgentDescriptor[];
  getWorkerActivity(agentId: string): {
    currentTool: string | null;
    currentToolElapsedSec: number;
    toolCalls: number;
    errors: number;
    turns: number;
    idleSec: number;
  } | undefined;
  spawnAgent(callerAgentId: string, input: SpawnAgentInput): Promise<AgentDescriptor>;
  killAgent(callerAgentId: string, targetAgentId: string): Promise<void>;
  sendMessage(
    fromAgentId: string,
    targetAgentId: string,
    message: string,
    delivery?: RequestedDeliveryMode,
    options?: {
      observabilityParentTool?: {
        agentId: string;
        runtimeToken?: number;
        toolCallId: string;
        toolName?: string;
      };
    }
  ): Promise<SendMessageReceipt>;
  createSessionFromAgent(
    creatorAgentId: string,
    params: {
      sessionName: string;
      cwd?: string;
      model?: unknown;
      reasoningLevel?: unknown;
      systemPrompt?: string;
      initialMessage?: string;
    }
  ): Promise<{ sessionAgentId: string; sessionLabel: string; profileId: string }>;
  createAndPromoteProjectAgent?(
    creatorAgentId: string,
    params: {
      sessionName: string;
      handle?: string;
      whenToUse: string;
      systemPrompt: string;
    }
  ): Promise<{ agentId: string; handle: string }>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext }>;
  requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]>;
  runTaskTool(
    callerAgentId: string,
    toolCallId: string,
    input: TaskToolInput,
  ): Promise<TaskToolResult>;
  recordToolSideEffect?(callerAgentId: string, event: SwarmToolSideEffectEvent): void;
  isWorkPlansEnabled?(): boolean;
  listCodexMcpTools?(managerAgentId: string): Promise<CodexCatalogSnapshot>;
  callCodexMcpTool?(
    managerAgentId: string,
    params: { selector: string; args?: Record<string, unknown> },
  ): Promise<CodexMcpToolCallResult>;
  getCodexPluginScopeForWorker?(workerAgentId: string): CodexPluginScopeRuntimeView | undefined;
  callCodexPluginScopedTool?(
    workerAgentId: string,
    scopedToolName: string,
    args?: Record<string, unknown>,
  ): Promise<CodexMcpToolCallResult>;
  exportCodexPluginScopedToolResult?(
    workerAgentId: string,
    input: {
      scopedToolName: string;
      args?: Record<string, unknown>;
      fileName?: string;
      format: CodexPluginExportFormat;
      includePreview: boolean;
    },
  ): Promise<CodexPluginScopedExportResult>;
  retryCodexPluginWorker?(
    managerAgentId: string,
    input: { initialMessage: string; retryContextId?: string },
  ): Promise<AgentDescriptor>;
}
