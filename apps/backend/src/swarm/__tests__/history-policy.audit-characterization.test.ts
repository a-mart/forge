import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_HISTORY,
  selectBootstrapConversationHistory,
  trimConversationHistory
} from "../session/history-policy.js";
import type { ConversationEntryEvent, ConversationMessageEvent } from "../types.js";

/**
 * Phase 0 characterization tests for bootstrap/projector replay semantics.
 * Skipped until QF-3/QF-4 land. Unskip in Phase 1.
 */
describe("audit replay history policy characterization (Phase 0 → Phase 1)", () => {
  const FIXED_NOW = "2026-01-01T00:00:00.000Z";
  const MANAGER_ID = "manager-1";
  const ANCESTOR_MANAGER_ID = "ancestor-manager";

  function message(id: string, options: Partial<ConversationMessageEvent> = {}): ConversationMessageEvent {
    return {
      type: "conversation_message",
      agentId: MANAGER_ID,
      id,
      role: "assistant",
      text: id,
      timestamp: FIXED_NOW,
      source: "user_input",
      ...options
    };
  }

  function managerSpawn(agentId: string, text: string): ConversationEntryEvent {
    return {
      type: "agent_tool_call",
      agentId,
      actorAgentId: agentId,
      timestamp: FIXED_NOW,
      kind: "tool_execution_start",
      toolName: "spawn_agent",
      toolCallId: `spawn-${text}`,
      text
    };
  }

  function managerSend(agentId: string, text: string): ConversationEntryEvent {
    return {
      type: "agent_tool_call",
      agentId,
      actorAgentId: agentId,
      timestamp: FIXED_NOW,
      kind: "tool_execution_start",
      toolName: "send_message_to_agent",
      toolCallId: `send-${text}`,
      text
    };
  }

  function workerCallback(agentId: string, workerId: string, text: string): ConversationEntryEvent {
    return {
      type: "agent_message",
      agentId,
      timestamp: FIXED_NOW,
      source: "agent_to_agent",
      fromAgentId: workerId,
      toAgentId: agentId,
      text
    };
  }

  function workerInternalTool(agentId: string, workerId: string, text: string): ConversationEntryEvent {
    return {
      type: "agent_tool_call",
      agentId,
      actorAgentId: workerId,
      timestamp: FIXED_NOW,
      kind: "tool_execution_start",
      toolName: "bash",
      toolCallId: `worker-tool-${text}`,
      text
    };
  }

  function runtimeLog(text: string): ConversationEntryEvent {
    return {
      type: "conversation_log",
      agentId: MANAGER_ID,
      timestamp: FIXED_NOW,
      source: "runtime_log",
      kind: "message_start",
      role: "assistant",
      text
    };
  }

  function ids(entries: ConversationEntryEvent[]): string[] {
    return entries.map((entry) => {
      if (entry.type === "conversation_message") {
        return entry.id ?? entry.text;
      }
      return entry.text;
    });
  }

  describe("D1. projector cap preserves manager-context rows over 2000 entries", () => {
    it("preserves early manager spawn/send/callback rows when trimming overflow", () => {
      const protectedRows: ConversationEntryEvent[] = [
        message("ancestor-turn", {
          agentId: ANCESTOR_MANAGER_ID,
          source: "user_input",
          role: "user"
        }),
        managerSpawn(ANCESTOR_MANAGER_ID, "early-spawn"),
        managerSend(ANCESTOR_MANAGER_ID, "early-send"),
        workerCallback(ANCESTOR_MANAGER_ID, "worker-ancestor", "early-callback")
      ];
      const filler = Array.from(
        { length: MAX_CONVERSATION_HISTORY },
        (_, index) => workerInternalTool(MANAGER_ID, `worker-${index}`, `filler-${index}`)
      );
      const entries = [...protectedRows, ...filler];

      expect(entries.length).toBeGreaterThan(MAX_CONVERSATION_HISTORY);
      trimConversationHistory(entries, MANAGER_ID);

      expect(entries.length).toBe(MAX_CONVERSATION_HISTORY);
      expect(ids(entries)).toEqual(
        expect.arrayContaining(["early-spawn", "early-send", "early-callback", "ancestor-turn"])
      );
      expect(ids(entries).filter((id) => id.startsWith("filler-"))).toHaveLength(
        MAX_CONVERSATION_HISTORY - protectedRows.length
      );
      expect(ids(entries)).not.toContain("filler-0");
      expect(ids(entries)).not.toContain("filler-1");
      expect(ids(entries)).not.toContain("filler-2");
      expect(ids(entries)).not.toContain("filler-3");
    });

    it("does not protect worker internal tool rows during overflow trim", () => {
      const earlyWorkerTool = workerInternalTool(MANAGER_ID, "worker-early", "early-worker-tool");
      const filler = Array.from(
        { length: MAX_CONVERSATION_HISTORY },
        (_, index) => message(`tail-${index}`)
      );
      const entries = [earlyWorkerTool, ...filler];

      trimConversationHistory(entries, MANAGER_ID);

      expect(entries.length).toBe(MAX_CONVERSATION_HISTORY);
      expect(ids(entries)).not.toContain("early-worker-tool");
    });
  });

  describe("D2. bootstrap selection protects manager-context activity under budget pressure", () => {
    it("keeps early manager spawn/send rows ahead of tail worker internals", () => {
      const history: ConversationEntryEvent[] = [
        managerSpawn(MANAGER_ID, "bootstrap-spawn"),
        managerSend(MANAGER_ID, "bootstrap-send"),
        workerCallback(MANAGER_ID, "worker-1", "bootstrap-callback"),
        ...Array.from({ length: 20 }, (_, index) =>
          workerInternalTool(MANAGER_ID, `worker-${index}`, `tail-worker-${index}`)
        ),
        message("message-tail")
      ];

      const selection = selectBootstrapConversationHistory({
        fullHistory: history,
        managerId: MANAGER_ID,
        isWithinBudget: (messages) => messages.length <= 5
      });

      expect(ids(selection.history)).toEqual(
        expect.arrayContaining(["bootstrap-spawn", "bootstrap-send", "bootstrap-callback"])
      );
      expect(ids(selection.history)).not.toEqual(
        expect.arrayContaining(["tail-worker-0", "tail-worker-1"])
      );
    });

    it("does not protect descriptorless agentId === actorAgentId rows without manager-alias evidence", () => {
      const history: ConversationEntryEvent[] = [
        managerSpawn("unknown-manager", "unknown-spawn"),
        message("message-1"),
        workerInternalTool(MANAGER_ID, "worker-1", "worker-tail")
      ];

      const selection = selectBootstrapConversationHistory({
        fullHistory: history,
        managerId: MANAGER_ID,
        isWithinBudget: (messages) => messages.length <= 2
      });

      expect(ids(selection.history)).not.toContain("unknown-spawn");
    });

    it("preserves visible transcript ahead of hidden runtime logs under tight budget", () => {
      const history: ConversationEntryEvent[] = [
        message("visible-user", { role: "user", source: "user_input" }),
        message("visible-assistant", { role: "assistant", source: "speak_to_user" }),
        runtimeLog("hidden-log-0"),
        runtimeLog("hidden-log-1"),
        runtimeLog("hidden-log-2")
      ];

      const selection = selectBootstrapConversationHistory({
        fullHistory: history,
        managerId: MANAGER_ID,
        isWithinBudget: (messages) => messages.length <= 2
      });

      expect(ids(selection.history)).toEqual(["visible-user", "visible-assistant"]);
      expect(ids(selection.history)).not.toEqual(expect.arrayContaining(["hidden-log-0", "hidden-log-1", "hidden-log-2"]));
    });

    it("trims protected activity before visible transcript when conversation fits alone", () => {
      const history: ConversationEntryEvent[] = [
        message("message-1"),
        message("message-2"),
        message("message-3"),
        managerSpawn(MANAGER_ID, "bootstrap-spawn"),
        managerSend(MANAGER_ID, "bootstrap-send"),
        workerCallback(MANAGER_ID, "worker-1", "bootstrap-callback")
      ];
      const budget = 5;

      const selection = selectBootstrapConversationHistory({
        fullHistory: history,
        managerId: MANAGER_ID,
        isWithinBudget: (messages) => messages.length <= budget
      });

      expect(selection.history.length).toBeLessThanOrEqual(budget);
      expect(selection.history.length).toBe(budget);
      expect(ids(selection.history)).toEqual([
        "message-1",
        "message-2",
        "message-3",
        "bootstrap-send",
        "bootstrap-callback"
      ]);
      expect(ids(selection.history)).not.toContain("bootstrap-spawn");
    });

    it("keeps transcript and only leftover protected activity when protected activity exceeds bootstrap budget", () => {
      const history: ConversationEntryEvent[] = [
        message("message-1"),
        managerSpawn(MANAGER_ID, "spawn-0"),
        managerSend(MANAGER_ID, "send-0"),
        managerSpawn(MANAGER_ID, "spawn-1"),
        managerSend(MANAGER_ID, "send-1"),
        managerSpawn(MANAGER_ID, "spawn-2")
      ];
      const budget = 2;

      const selection = selectBootstrapConversationHistory({
        fullHistory: history,
        managerId: MANAGER_ID,
        isWithinBudget: (messages) => messages.length <= budget
      });

      expect(selection.history.length).toBeLessThanOrEqual(budget);
      expect(ids(selection.history)).toEqual(["message-1", "spawn-2"]);
    });
  });
});
