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
import type { UpdatePlanInput, UpdatePlanResult } from "./planning/update-plan-tool.js";
import type {
  AcceptWorkGraphNodeInput,
  AcceptWorkGraphNodeResult,
} from "./planning/accept-work-graph-node-tool.js";
import type { UpdateWorkGraphResult } from "./planning/update-work-graph-tool.js";
import type { UpdateWorkGraphInput } from "./planning/work-graph-state.js";
import type { CreateGoalInput, UpdateGoalInput } from "./goals/goal-tools.js";
import type {
  BrowserAutomationInputByOperation,
  BrowserAutomationOperation,
  RequestSecureSshHostTrustRequest,
  SessionGoalSnapshot,
} from "@forge/protocol";
import type { BrowserAutomationInvocationResult } from "./browser-automation/browser-automation-service.js";
import type {
  KnowledgeEntry,
  KnowledgeEntryScope,
  KnowledgeEntryType,
  KnowledgeSearchResult,
} from "./knowledge-service.js";
import type {
  RequestSecureSecretAccessToolInput,
  SecureSessionAgentView,
} from "./secure-sessions/secure-session-tools.js";
import type {
  GetSecureRuntimeBinding,
} from "./secure-sessions/runtime/secure-runtime-binding.js";

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
      planStep?: string;
      requiresSecureRuntime?: boolean;
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
      placement?: import("@forge/protocol").ProjectAgentPlacement;
    }
  ): Promise<{ agentId: string; handle: string }>;
  publishToUser(
    agentId: string,
    text: string,
    source?: "speak_to_user" | "system",
    targetContext?: MessageTargetContext
  ): Promise<{ targetContext: MessageSourceContext; published?: boolean; reason?: "superseded_by_user_input" }>;
  requestUserChoice(
    agentId: string,
    questions: ChoiceQuestion[],
  ): Promise<ChoiceAnswer[]>;
  invokeBrowserAutomation<Operation extends BrowserAutomationOperation>(
    callerAgentId: string,
    operation: Operation,
    input: BrowserAutomationInputByOperation[Operation],
  ): Promise<BrowserAutomationInvocationResult<Operation>>;
  updatePlan(
    callerAgentId: string,
    toolCallId: string,
    input: UpdatePlanInput,
  ): Promise<UpdatePlanResult>;
  updateWorkGraph(
    callerAgentId: string,
    toolCallId: string,
    input: UpdateWorkGraphInput,
  ): Promise<UpdateWorkGraphResult>;
  acceptWorkGraphNode(
    callerAgentId: string,
    toolCallId: string,
    input: AcceptWorkGraphNodeInput,
  ): Promise<AcceptWorkGraphNodeResult>;
  createGoal(
    callerAgentId: string,
    toolCallId: string,
    input: CreateGoalInput,
  ): Promise<SessionGoalSnapshot>;
  getGoal(callerAgentId: string): Promise<SessionGoalSnapshot>;
  updateGoal(
    callerAgentId: string,
    toolCallId: string,
    input: UpdateGoalInput,
  ): Promise<SessionGoalSnapshot>;
  searchKnowledge?(
    callerAgentId: string,
    input: { query?: string; scope?: "global" | "profile" | "all"; limit?: number },
  ): Promise<KnowledgeSearchResult[]>;
  readKnowledgeEntry?(callerAgentId: string, id: string): Promise<KnowledgeEntry>;
  saveLearning?(
    callerAgentId: string,
    input: {
      type: KnowledgeEntryType;
      scope: KnowledgeEntryScope;
      title: string;
      body: string;
      evidence: "user-stated" | "observed";
    },
  ): Promise<KnowledgeEntry>;
  getSecureSessionAgentView?(
    callerAgentId: string,
  ): SecureSessionAgentView | Promise<SecureSessionAgentView>;
  requestSecureSecretAccess?(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSecretAccessToolInput,
  ): Promise<"requested" | "already_requested" | "already_granted">;
  requestSecureSshHostTrust?(
    callerAgentId: string,
    toolCallId: string,
    input: RequestSecureSshHostTrustRequest,
  ): Promise<"trusted" | "requested">;
  getSecureRuntimeBinding?: GetSecureRuntimeBinding;
  recordToolSideEffect?(callerAgentId: string, event: SwarmToolSideEffectEvent): void;
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
