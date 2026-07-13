import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_HISTORY,
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

function managerTool(id: string): ConversationEntryEvent {
  return {
    type: "agent_tool_call",
    agentId: "manager-1",
    actorAgentId: "manager-1",
    timestamp: FIXED_NOW,
    kind: "tool_execution_start",
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

function choice(
  id: string,
  options: Partial<Extract<ConversationEntryEvent, { type: "choice_request" }>> = {}
): Extract<ConversationEntryEvent, { type: "choice_request" }> {
  return {
    type: "choice_request",
    agentId: "manager-1",
    choiceId: id,
    questions: [],
    status: "pending",
    timestamp: FIXED_NOW,
    ...options
  };
}

function planSummary(id: string): ConversationEntryEvent {
  return {
    type: "plan_summary",
    id,
    agentId: "manager-1",
    timestamp: FIXED_NOW,
    revision: 2,
    updatedAt: FIXED_NOW,
    plan: [{ step: "Finish the work", status: "completed" }]
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
    if (entry.type === "model_cache_observation") {
      return entry.id;
    }
    if (entry.type === "plan_summary") {
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
    expect(shouldPersistConversationEntry(planSummary("plan-summary"))).toBe(true);
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
    expect(isProtectedWebTranscriptEntry(message("projected-assistant", { source: "assistant_output" }))).toBe(true);
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

  it("trims visible transcript only as the retention last resort", () => {
    const entries = Array.from(
      { length: MAX_CONVERSATION_HISTORY + 2 },
      (_, index) => message(`protected-${index}`, { source: "user_input" })
    );

    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY);
    expect(ids(entries)[0]).toBe("protected-2");
  });

  it("does not displace visible transcript rows with model_cache_observation under tight bootstrap budget", () => {
    const history = [
      message("message-1"),
      modelCacheObservation("cache-obs-1"),
      message("message-2"),
      agentActivity("activity-1"),
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 2,
    });

    expect(selection.history).toHaveLength(2);
    expect(ids(selection.history)).toEqual(["message-1", "message-2"]);
    expect(ids(selection.history)).not.toContain("cache-obs-1");
  });

  it("includes model_cache_observation only when bootstrap budget has room after transcript", () => {
    const history = [message("message-1"), modelCacheObservation("cache-obs-1")];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 2,
    });

    expect(ids(selection.history)).toEqual(["message-1", "cache-obs-1"]);
  });

  it("excludes model_cache_observation from bootstrap when diagnostics are disabled", () => {
    const history = [message("message-1"), modelCacheObservation("cache-obs-1"), message("message-2")];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      includeDiagnosticEntries: false,
      isWithinBudget: () => true,
    });

    expect(selection.trimmed).toBe(false);
    expect(selection.requestedHistoryLength).toBe(2);
    expect(ids(selection.history)).toEqual(["message-1", "message-2"]);
  });

  it("does not let disabled diagnostics consume requested bootstrap count", () => {
    const history = [message("message-1"), message("message-2"), modelCacheObservation("cache-obs-1")];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      requestedMessageCount: 1,
      includeDiagnosticEntries: false,
      isWithinBudget: () => true,
    });

    expect(selection.requestedHistoryLength).toBe(1);
    expect(ids(selection.history)).toEqual(["message-2"]);
  });

  it("keeps transcript entries first and fills leftover bootstrap budget with tail activity in source order", () => {
    const history = [
      agentActivity("activity-1"),
      message("message-1"),
      tool("activity-2", "tool_execution_start"),
      choice("choice-1"),
      agentActivity("activity-3"),
      message("message-2"),
      tool("activity-4", "tool_execution_end")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 6
    });

    expect(selection.trimmed).toBe(true);
    expect(selection.requestedHistoryLength).toBe(7);
    expect(ids(selection.history)).toEqual([
      "message-1",
      "activity-2",
      "choice-1",
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

  it("keeps completed plan summaries in size-limited transcript bootstrap", () => {
    const history = [
      agentActivity("activity-1"),
      message("message-1"),
      planSummary("plan-summary-1"),
      agentActivity("activity-2")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      isWithinBudget: (messages) => messages.length <= 2
    });

    expect(selection.trimmed).toBe(true);
    expect(ids(selection.history)).toEqual(["message-1", "plan-summary-1"]);
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

  it("does not trim visible transcript to make room for protected manager activity", () => {
    const history = [
      message("message-1", { source: "user_input" }),
      managerTool("protected-activity-1"),
      message("message-2", { source: "speak_to_user" }),
      managerTool("protected-activity-2"),
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      managerId: "manager-1",
      isWithinBudget: (messages) => messages.length <= 2
    });

    expect(selection.trimmed).toBe(true);
    expect(ids(selection.history)).toEqual(["message-1", "message-2"]);
  });

  it("injects and dedupes pending choice requests before bootstrap selection", () => {
    const history = [
      message("message-1"),
      choice("choice-1", { status: "cancelled", questions: [{ id: "old", question: "Old?", options: [] }] }),
      choice("choice-1", { status: "expired", timestamp: "2026-01-01T00:00:00.500Z" }),
      message("message-2")
    ];
    const pendingChoice = choice("choice-1", {
      sessionAgentId: "worker-session-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      questions: [{ id: "new", question: "New?", options: [{ id: "yes", label: "Yes" }] }]
    });

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      pendingChoiceRequests: [pendingChoice],
      isWithinBudget: () => true
    });

    expect(ids(selection.history)).toEqual(["message-1", "choice-1", "message-2"]);
    expect(selection.history[1]).toMatchObject({
      type: "choice_request",
      choiceId: "choice-1",
      status: "pending",
      sessionAgentId: "worker-session-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      questions: [{ id: "new", question: "New?", options: [{ id: "yes", label: "Yes" }] }]
    });
  });

  it("preserves terminal choice rows over stale pending rows during bootstrap selection", () => {
    const history = [
      choice("choice-a", { status: "pending", timestamp: "2026-01-01T00:00:00.000Z" }),
      agentActivity("activity-1"),
      message("visible-message", { source: "user_input" }),
      agentActivity("activity-2"),
      choice("choice-a", {
        status: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["yes"] }],
        timestamp: "2026-01-01T00:00:01.000Z"
      }),
      agentActivity("activity-3")
    ];
    const activePendingChoice = choice("choice-b", {
      sessionAgentId: "worker-session-1",
      questions: [{ id: "q2", question: "Still pending?", options: [{ id: "yes", label: "Yes" }] }]
    });

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      pendingChoiceRequests: [activePendingChoice],
      isWithinBudget: (messages) => messages.length <= 3
    });

    expect(ids(selection.history)).toEqual(["visible-message", "choice-a", "choice-b"]);
    const choiceRows = selection.history.filter(
      (entry): entry is Extract<ConversationEntryEvent, { type: "choice_request" }> => entry.type === "choice_request"
    );
    expect(choiceRows.map((entry) => [entry.choiceId, entry.status])).toEqual([
      ["choice-a", "answered"],
      ["choice-b", "pending"],
    ]);
    expect(choiceRows[0].answers).toEqual([{ questionId: "q1", selectedOptionIds: ["yes"] }]);
    expect(selection.history).toContainEqual(expect.objectContaining({
      type: "conversation_message",
      id: "visible-message"
    }));
  });

  it("preserves non-active choice lifecycle rows while upserting active pending choices", () => {
    const history = [
      choice("choice-a", { status: "pending", timestamp: "2026-01-01T00:00:00.000Z" }),
      choice("choice-a", {
        status: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["yes"] }],
        timestamp: "2026-01-01T00:00:01.000Z"
      }),
      choice("choice-b", { status: "cancelled", timestamp: "2026-01-01T00:00:02.000Z" }),
      message("message-1")
    ];
    const pendingChoiceB = choice("choice-b", {
      sessionAgentId: "worker-session-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      questions: [{ id: "q2", question: "Still pending?", options: [{ id: "yes", label: "Yes" }] }]
    });

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      pendingChoiceRequests: [pendingChoiceB],
      isWithinBudget: () => true
    });

    const choiceRows = selection.history.filter(
      (entry): entry is Extract<ConversationEntryEvent, { type: "choice_request" }> => entry.type === "choice_request"
    );
    expect(choiceRows.map((entry) => [entry.choiceId, entry.status])).toEqual([
      ["choice-a", "pending"],
      ["choice-a", "answered"],
      ["choice-b", "pending"],
    ]);
    expect(choiceRows[1].answers).toEqual([{ questionId: "q1", selectedOptionIds: ["yes"] }]);
    expect(choiceRows[2]).toMatchObject({
      sessionAgentId: "worker-session-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      questions: [{ id: "q2", question: "Still pending?", options: [{ id: "yes", label: "Yes" }] }]
    });
  });

  it("does not let requestedMessageCount exclude active pending choice details", () => {
    const history = [
      choice("choice-1", { status: "cancelled" }),
      message("message-1"),
      message("message-2")
    ];

    const selection = selectBootstrapConversationHistory({
      fullHistory: history,
      requestedMessageCount: 1,
      pendingChoiceRequests: [choice("choice-1", { sessionAgentId: "worker-session-1" })],
      isWithinBudget: () => true
    });

    expect(selection.requestedHistoryLength).toBe(2);
    expect(ids(selection.history)).toEqual(["message-2", "choice-1"]);
    expect(selection.history.at(-1)).toMatchObject({
      type: "choice_request",
      choiceId: "choice-1",
      status: "pending",
      sessionAgentId: "worker-session-1"
    });
  });

  it("retains terminal choice state over stale pending lifecycle rows", () => {
    const entries: ConversationEntryEvent[] = [
      choice("choice-a", { status: "pending", timestamp: "2026-01-01T00:00:00.000Z" }),
      choice("choice-a", {
        status: "answered",
        answers: [{ questionId: "q1", selectedOptionIds: ["yes"] }],
        timestamp: "2026-01-01T00:00:01.000Z"
      }),
      ...Array.from({ length: MAX_CONVERSATION_HISTORY - 1 }, (_, index) =>
        message(`visible-tail-${index}`, { source: "speak_to_user" })
      )
    ];

    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY);
    const choiceRows = entries.filter(
      (entry): entry is Extract<ConversationEntryEvent, { type: "choice_request" }> => entry.type === "choice_request"
    );
    expect(choiceRows.map((entry) => [entry.choiceId, entry.status])).toEqual([["choice-a", "answered"]]);
    expect(choiceRows[0].answers).toEqual([{ questionId: "q1", selectedOptionIds: ["yes"] }]);
  });

  it("retains pending choices and visible transcript while trimming activity first", () => {
    const entries: ConversationEntryEvent[] = [
      choice("pending-choice"),
      message("visible-1", { source: "user_input" }),
      ...Array.from({ length: 6 }, (_, index) => agentActivity(`activity-${index}`)),
      ...Array.from({ length: MAX_CONVERSATION_HISTORY - 2 }, (_, index) =>
        message(`visible-tail-${index}`, { source: "speak_to_user" })
      )
    ];

    trimConversationHistory(entries);

    expect(entries).toHaveLength(MAX_CONVERSATION_HISTORY);
    expect(ids(entries)).toContain("pending-choice");
    expect(ids(entries)).toContain("visible-1");
    expect(ids(entries).filter((id) => id.startsWith("activity-"))).toHaveLength(0);
  });
});
