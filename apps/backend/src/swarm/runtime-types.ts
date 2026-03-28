import type {
  AgentContextUsage,
  AgentDescriptor,
  AgentStatus,
  RequestedDeliveryMode,
  SendMessageReceipt
} from "./types.js";

export interface RuntimeImageAttachment {
  mimeType: string;
  data: string;
}

export interface RuntimeUserMessage {
  text: string;
  images?: RuntimeImageAttachment[];
}

export type RuntimeUserMessageInput = string | RuntimeUserMessage;

export interface RuntimeSessionMessage {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export type RuntimeSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end"; toolResults: unknown[] }
  | { type: "message_start"; message: RuntimeSessionMessage }
  | { type: "message_update"; message: RuntimeSessionMessage }
  | { type: "message_end"; message: RuntimeSessionMessage }
  | {
      type: "tool_execution_start";
      toolName: string;
      toolCallId: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolName: string;
      toolCallId: string;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolName: string;
      toolCallId: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "auto_compaction_start";
      reason: "threshold" | "overflow";
    }
  | {
      type: "auto_compaction_end";
      result: unknown;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    };

export interface RuntimeErrorEvent {
  phase:
    | "prompt_dispatch"
    | "prompt_start"
    | "steer_delivery"
    | "compaction"
    | "context_guard"
    | "extension"
    | "interrupt"
    | "thread_resume"
    | "startup"
    | "runtime_exit";
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export interface SwarmRuntimeCallbacks {
  onStatusChange: (
    agentId: string,
    status: AgentStatus,
    pendingCount: number,
    contextUsage?: AgentContextUsage
  ) => void | Promise<void>;
  onSessionEvent?: (agentId: string, event: RuntimeSessionEvent) => void | Promise<void>;
  onAgentEnd?: (agentId: string) => void | Promise<void>;
  onRuntimeError?: (agentId: string, error: RuntimeErrorEvent) => void | Promise<void>;
}

export interface SmartCompactResult {
  /** Whether the compaction step itself succeeded (context was actually reduced). */
  compactionSucceeded: boolean;
  /** If compaction failed, a human-readable reason. */
  compactionFailureReason?: string;
}

export interface RuntimeShutdownOptions {
  abort?: boolean;
  shutdownTimeoutMs?: number;
  drainTimeoutMs?: number;
}

export interface SwarmAgentRuntime {
  readonly descriptor: AgentDescriptor;

  getStatus(): AgentStatus;
  getPendingCount(): number;
  getContextUsage(): AgentContextUsage | undefined;
  getSystemPrompt?(): string;
  isContextRecoveryInProgress?(): boolean;

  sendMessage(
    input: RuntimeUserMessageInput,
    requestedMode?: RequestedDeliveryMode
  ): Promise<SendMessageReceipt>;

  compact(customInstructions?: string): Promise<unknown>;

  smartCompact(customInstructions?: string): Promise<SmartCompactResult>;

  stopInFlight(options?: RuntimeShutdownOptions): Promise<void>;

  terminate(options?: RuntimeShutdownOptions): Promise<void>;

  recycle(): Promise<void>;

  getCustomEntries(customType: string): unknown[];
  appendCustomEntry(customType: string, data?: unknown): string;
}
