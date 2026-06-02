import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_HISTORY,
  isProtectedTranscriptEntry,
  isProtectedWebTranscriptEntry,
  selectBootstrapConversationHistory,
  shouldPersistConversationEntry,
  shouldWriteConversationHistoryCacheEntry,
  trimConversationHistory
} from "../session/history-policy.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function message(id: string, options: Partial<ConversationMessageEvent> = {}): ConversationMessageEvent {
  return {
    type: "conversation_message",
    agentId: "manager-1",
    id,
    role: "assistant",
    text: id,
    timestamp: FIXED_NOW,
    source: "system",
    ...options
  };
}

function log(id: string): ConversationEntryEvent {
  return {
    type: "conversation_log",
    agentId: "manager-1",
    timestamp: FIXED_NOW,
    source: "runtime_log",
    kind: "message_start",
    role: "assistant",
    text: id
  };
}

function tool(id: string, kind: "tool_execution_start" | "tool_execution_update" | "tool_execution_end"): ConversationEntryEvent {
  return {
    type: "agent_tool_call",
    agentId: "manager-1",
    actorAgentId: "worker-1",
    timestamp: FIXED_NOW,
    kind,
    text: id
  };
}

function agentActivity(id: string): ConversationEntryEvent {
  return {
    type: "agent_message",
    agentId: "manager-1",
    timestamp: FIXED_NOW,
    source: "agent_to_agent",
    fromAgentId: "worker-1",
    toAgentId: "manager-1",
    text: id
  };
}

function choice(id: string): ConversationEntryEvent {
  return {
    type: "choice_request",
    agentId: "manager-1",
    choiceId: id,
    questions: [],
    status: "pending",
    timestamp: FIXED_NOW
  };
}

function workPlanCreated(id: string): ConversationEntryEvent {
  return {
    type: "work_plan_created",
    agentId: "manager-1",
    id,
    timestamp: FIXED_NOW,
    planId: `plan-${id}`,
    stateRevision: 1,
    planRevision: 1,
    plan: {
      planId: `plan-${id}`,
      title: `Plan ${id}`,
      status: "active",
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
      revision: 1,
      items: [],
      itemCount: 0,
      itemsTruncated: false,
      warnings: [],
      warningCount: 0,
      warningsTruncated: false
    }
  };
}

function modelCacheObservation(id: string): ConversationEntryEvent {
  return {
    type: "model_cache_observation",
    agentId: "manager-1",
    id,
    timestamp: FIXED_NOW,
    runtimeType: "pi",
    provider: "openai",
    modelId: "gpt-5",
    tokens: {
      promptInputTokens: 2000,
      cachedInputTokens: 1600,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 400,
      outputTokens: 120,
      totalTokens: 2120,
      normalization: "raw_input_tokens_total"
    },
    classification: {
      version: 1,
      status: "hit",
      cachedRatio: 0.8,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8
    }
  };
}

function ids(entries: ConversationEntryEvent[]): string[] {
  return entries.map((entry) => {
    if (entry.type === "conversation_message") {
      return entry.id ?? entry.text;
    }
    if (entry.type === "choice_request") {
      return entry.choiceId;
    }
    if (entry.type === "work_plan_created") {
      return entry.id;
    }
    if (entry.type === "model_cache_observation") {
      return entry.id;
    }
    return entry.text;
  });
}

describe("history policy", () => {
  it("applies current persisted-entry rules", () => {
    expect(shouldPersistConversationEntry(log("runtime"))).toBe(false);
    expect(shouldPersistConversationEntry(tool("update", "tool_execution_update"))).toBe(false);
    expect(shouldPersistConversationEntry(tool("start", "tool_execution_start"))).toBe(true);
    expect(shouldPersistConversationEntry(tool("end", "tool_execution_end"))).toBe(true);
    expect(shouldPersistConversationEntry(message("assistant"))).toBe(true);
    expect(shouldPersistConversationEntry(agentActivity("activity"))).toBe(true);
    expect(shouldPersistConversationEntry(choice("choice"))).toBe(true);
    expect(shouldPersistConversationEntry(workPlanCreated("work-plan-1"))).toBe(true);
  });

  it("does not persist Codex stream detail agent_tool_call rows", () => {
    const codexTool = (
      kind: "tool_execution_start" | "tool_execution_end",
      toolName: string,
    ): ConversationEntryEvent => ({
      type: "agent_tool_call",
      agentId: "manager-1",
      actorAgentId: "manager-1--codex",
      timestamp: FIXED_NOW,
      kind,
      toolName,
      toolCallId: "cmd-1",
      text: "{}",
    });

    expect(shouldPersistConversationEntry(codexTool("tool_execution_start", "codex_command"))).toBe(false);
    expect(shouldPersistConversationEntry(codexTool("tool_execution_end", "codex_command"))).toBe(false);
    expect(shouldPersistConversationEntry(codexTool("tool_execution_start", "codex_mcp_tool"))).toBe(false);
  });

  it("does not write Codex stream detail agent_tool_call rows to disk cache", () => {
    const codexTool = (
      kind: "tool_execution_start" | "tool_execution_end",
      toolName: string,
    ): ConversationEntryEvent => ({
      type: "agent_tool_call",
      agentId: "manager-1",
      actorAgentId: "manager-1--codex",
      timestamp: FIXED_NOW,
      kind,
      toolName,
      toolCallId: "cmd-1",
      text: "{}",
    });

    expect(shouldWriteConversationHistoryCacheEntry(log("runtime"))).toBe(true);
    expect(shouldWriteConversationHistoryCacheEntry(tool("start", "tool_execution_start"))).toBe(true);
    expect(shouldWriteConversationHistoryCacheEntry(codexTool("tool_execution_start", "codex_command"))).toBe(false);
    expect(shouldWriteConversationHistoryCacheEntry(codexTool("tool_execution_end", "codex_plan"))).toBe(false);
  });

  it("identifies protected web and CLI transcript entries", () => {
    expect(isProtectedWebTranscriptEntry(message("project", { source: "project_agent_input" }))).toBe(true);
    expect(isProtectedWebTranscriptEntry(message("web-user", { source: "user_input" }))).toBe(true);
    expect(isProtectedWebTranscriptEntry(message("web-assistant", { source: "speak_to_user" }))).toBe(true);
    expect(isProtectedWebTranscriptEntry(message("cli-user", {
      source: "user_input",
      sourceContext: { channel: "cli" }
    }))).toBe(true);
    expect(isProtectedWebTranscriptEntry(message("telegram-user", {
      source: "user_input",
      sourceContext: { channel: "telegram" }
    }))).toBe(false);
    expect(isProtectedWebTranscriptEntry(message("system"))).toBe(false);
    expect(isProtectedWebTranscriptEntry(agentActivity("activity"))).toBe(false);
    expect(isProtectedTranscriptEntry(workPlanCreated("work-plan-protected"))).toBe(true);
  });

  it("preserves work_plan_created receipts ahead of removable activity and system entries during overflow trim", () => {
    const overflow = 3;
    const entries: ConversationEntryEvent[] = [
      workPlanCreated("receipt-1"),
      agentActivity("remove-1"),
      tool("remove-2", "tool_execution_start"),
      message("remove-3", { source: "system" }),
      ...Array.from({ length: MAX_CONVERSATION_HISTORY - 1 }, (_, index) => message(`tail-${index}`, { source: "user_input" }))
    ];

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY + overflow);
    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY);
    expect(ids(entries)[0]).toBe("receipt-1");
    expect(ids(entries)).not.toContain("remove-1");
    expect(ids(entries)).not.toContain("remove-2");
    expect(ids(entries)).not.toContain("remove-3");
  });

  it("trims oldest removable entries while preserving protected web transcript entries", () => {
    const overflow = 3;
    const entries: ConversationEntryEvent[] = [
      message("protected-1", { source: "user_input" }),
      agentActivity("remove-1"),
      message("protected-cli", { source: "user_input", sourceContext: { channel: "cli" } }),
      message("protected-2", { source: "speak_to_user" }),
      tool("remove-2", "tool_execution_start"),
      message("remove-3", { source: "system" }),
      ...Array.from({ length: MAX_CONVERSATION_HISTORY - 3 }, (_, index) => message(`tail-${index}`, { source: "user_input" }))
    ];

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY + overflow);
    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY);
    expect(ids(entries).slice(0, 4)).toEqual(["protected-1", "protected-cli", "protected-2", "tail-0"]);
    expect(ids(entries)).not.toContain("remove-1");
    expect(ids(entries)).not.toContain("remove-2");
    expect(ids(entries)).not.toContain("remove-3");
  });

  it("leaves all-protected overflow intact", () => {
    const entries = Array.from(
      { length: MAX_CONVERSATION_HISTORY + 2 },
      (_, index) => message(`protected-${index}`, { source: "user_input" })
    );

    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY + 2);
  });

  it("includes model_cache_observation in bootstrap transcript selection", () => {
    const history = [
      agentActivity("activity-1"),
      message("message-1"),
      modelCacheObservation("cache-obs-1"),
      tool("activity-2", "tool_execution_start")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 3
    });

    expect(ids(selection.history)).toEqual(["message-1", "cache-obs-1", "activity-2"]);
  });

  it("keeps transcript entries first and fills leftover bootstrap budget with tail activity in source order", () => {
    const history = [
      agentActivity("activity-1"),
      message("message-1"),
      tool("activity-2", "tool_execution_start"),
      choice("choice-1"),
      workPlanCreated("work-plan-created-1"),
      agentActivity("activity-3"),
      message("message-2"),
      tool("activity-4", "tool_execution_end")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 6
    });

    expect(selection.trimmed).toBe(true);
    expect(selection.requestedHistoryLength).toBe(8);
    expect(ids(selection.history)).toEqual([
      "message-1",
      "choice-1",
      "work-plan-created-1",
      "activity-3",
      "message-2",
      "activity-4"
    ]);
  });

  it("returns visible transcript tail when transcript alone exceeds bootstrap budget", () => {
    const history = [
      message("message-1"),
      agentActivity("activity-1"),
      message("message-2"),
      workPlanCreated("work-plan-created-1"),
      choice("choice-1"),
      message("message-3")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 2
    });

    expect(selection.trimmed).toBe(true);
    expect(ids(selection.history)).toEqual(["choice-1", "message-3"]);
  });

  it("applies requested message count before bootstrap budget selection", () => {
    const history = [
      message("message-1"),
      message("message-2"),
      agentActivity("activity-1"),
      message("message-3")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      requestedMessageCount: 2,
      isWithinBudget: () => true
    });

    expect(selection.trimmed).toBe(false);
    expect(selection.requestedHistoryLength).toBe(2);
    expect(ids(selection.history)).toEqual(["activity-1", "message-3"]);
  });
});
