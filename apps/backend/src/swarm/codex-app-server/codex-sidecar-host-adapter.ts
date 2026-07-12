import { SessionManager } from "@earendil-works/pi-coding-agent";
import { appendImmediateCustomEntryViaTimeline } from "../session/conversation-timeline.js";
import type {
  AgentDescriptor,
  AgentMessageEvent,
  AgentStatus,
  AgentToolCallEvent,
  ConversationEntryEvent,
  ConversationLogEvent,
  ConversationMessageEvent,
  MessageSourceContext,
} from "../types.js";
import {
  buildCodexParentExternalThreadCard,
  truncateCodexPreview,
} from "./codex-sidecar-parent-cards.js";
import type { CodexSidecarHost, CodexSidecarPersistedThreadState, CodexSidecarParentTurnNotification } from "./types.js";
import { CODEX_THREAD_STATE_CUSTOM_TYPE } from "./types.js";

export interface CodexSidecarHostAdapterDeps {
  now: () => string;
  logDebug: (message: string, details?: unknown) => void;
  getDescriptor: (agentId: string) => AgentDescriptor | undefined;
  upsertDescriptor: (descriptor: AgentDescriptor) => void;
  saveStore: () => Promise<void>;
  ensureSessionFileParentDirectory: (sessionFile: string) => Promise<void>;
  appendConversationEntry: (agentId: string, entry: ConversationEntryEvent) => void;
  emitConversationMessage: (event: ConversationMessageEvent) => void;
  emitConversationLog: (event: ConversationLogEvent) => void;
  emitAgentMessage: (event: AgentMessageEvent) => void;
  emitAgentToolCall: (event: AgentToolCallEvent) => void;
  emitStatus: (agentId: string, status: AgentStatus, pendingCount: number) => void;
  emitAgentsSnapshot: () => void;
  emitProfilesSnapshot: () => void;
  listWorkersForSession: (sessionAgentId: string) => AgentDescriptor[];
}

export interface CodexSidecarHostAdapter extends CodexSidecarHost {
  emitParentExternalThreadCard(params: CodexSidecarParentTurnNotification): void;
  emitParentUserToCodexAgentMessage(params: {
    managerAgentId: string;
    sidecarAgentId: string;
    text: string;
    sourceContext?: MessageSourceContext;
    attachmentCount?: number;
  }): void;
}

export function createCodexSidecarHostAdapter(
  deps: CodexSidecarHostAdapterDeps,
): CodexSidecarHostAdapter {
  return {
    now: deps.now,
    logDebug: deps.logDebug,
    getDescriptor: deps.getDescriptor,
    upsertDescriptor: deps.upsertDescriptor,
    saveStore: deps.saveStore,
    ensureSessionFileParentDirectory: deps.ensureSessionFileParentDirectory,
    appendConversationEntry: deps.appendConversationEntry,
    emitConversationMessage: deps.emitConversationMessage,
    emitConversationLog: deps.emitConversationLog,
    emitAgentMessage: deps.emitAgentMessage,
    emitAgentToolCall: deps.emitAgentToolCall,
    emitStatus: deps.emitStatus,
    emitAgentsSnapshot: deps.emitAgentsSnapshot,
    emitProfilesSnapshot: deps.emitProfilesSnapshot,
    listWorkersForSession: deps.listWorkersForSession,
    readSidecarThreadStateFallback: readSidecarThreadStateFallback,
    writeSidecarThreadStateAudit: writeSidecarThreadStateAudit,
    emitParentExternalThreadCard(params) {
      deps.emitConversationMessage(
        buildCodexParentExternalThreadCard({
          managerAgentId: params.managerAgentId,
          sidecarAgentId: params.sidecarAgentId,
          requestId: params.requestId,
          turnCorrelationId: params.turnCorrelationId,
          status: params.status,
          timestamp: deps.now(),
          promptPreview: params.promptPreview,
          resultPreview: params.resultPreview
            ? truncateCodexPreview(params.resultPreview)
            : undefined,
          threadId: params.threadId,
        }),
      );
    },
    emitParentUserToCodexAgentMessage(params) {
      deps.emitAgentMessage({
        type: "agent_message",
        agentId: params.managerAgentId,
        timestamp: deps.now(),
        source: "user_to_agent",
        toAgentId: params.sidecarAgentId,
        text: params.text,
        sourceContext: params.sourceContext,
        attachmentCount: params.attachmentCount,
      });
    },
  };
}

function readSidecarThreadStateFallback(
  sessionFile: string,
): CodexSidecarPersistedThreadState | undefined {
  try {
    const sessionManager = SessionManager.open(sessionFile);
    const entries = sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type !== "custom" || entry.customType !== CODEX_THREAD_STATE_CUSTOM_TYPE) {
        continue;
      }

      const data = entry.data as { threadId?: unknown; persisted?: unknown } | undefined;
      if (typeof data?.threadId !== "string" || data.threadId.trim().length === 0) {
        continue;
      }

      return {
        threadId: data.threadId.trim(),
        persisted: true,
      };
    }
  } catch (_error) {
    return undefined;
  }

  return undefined;
}

async function writeSidecarThreadStateAudit(
  sessionFile: string,
  state: CodexSidecarPersistedThreadState,
  cwd: string,
): Promise<void> {
  await appendImmediateCustomEntryViaTimeline({
    sessionFile,
    customType: CODEX_THREAD_STATE_CUSTOM_TYPE,
    data: state,
    cwd,
  });
}
