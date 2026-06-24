import { describe, expect, it, vi } from "vitest";
import { ManagerAssistantOutputTracker, type AssistantOutputTarget } from "../runtime/manager-assistant-output-tracker.js";
import type { ConversationMessageEvent } from "../types.js";

const WEB_TARGET: AssistantOutputTarget = { kind: "session_transcript", channel: "web" };

function createTracker() {
  const emitted: ConversationMessageEvent[] = [];
  const markSessionActivity = vi.fn();
  const tracker = new ManagerAssistantOutputTracker({
    now: () => "2026-01-01T00:00:00.000Z",
    emitConversationMessage: (event) => emitted.push(event),
    markSessionActivity,
  });
  return { tracker, emitted, markSessionActivity };
}

function assistantMessageEnd(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message_end" as const,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      ...overrides,
    },
  };
}

describe("ManagerAssistantOutputTracker", () => {
  it("buffers and projects eligible direct session transcript assistant final text at turn end", () => {
    const { tracker, emitted, markSessionActivity } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd(" Done. "));
    expect(emitted).toEqual([]);

    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([
      {
        type: "conversation_message",
        agentId: "manager-1",
        role: "assistant",
        text: "Done.",
        timestamp: "2026-01-01T00:00:00.000Z",
        source: "assistant_output",
        sourceContext: { channel: "web" },
      },
    ]);
    expect(markSessionActivity).toHaveBeenCalledWith("manager-1", "2026-01-01T00:00:00.000Z");
  });

  it("does not project peer, external, explicit-tool, or missing target turns", () => {
    const targets: AssistantOutputTarget[] = [
      { kind: "peer_agent", fromAgentId: "agent-2" },
      { kind: "explicit_tool_required", reason: "collaboration_channel" },
      { kind: "external_channel", sourceContext: { channel: "telegram", channelId: "c1" } },
    ];

    for (const target of targets) {
      const { tracker, emitted } = createTracker();
      tracker.activateTurn("manager-1", target);
      tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("hidden"));
      tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });
      expect(emitted).toEqual([]);
    }

    const { tracker, emitted } = createTracker();
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("hidden"));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });
    expect(emitted).toEqual([]);
  });

  it("suppresses duplicates after canonical successful speak_to_user publication", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.markExplicitAssistantOutput("manager-1");
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Duplicate."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("does not suppress duplicates from provider-specific speak_to_user tool result payloads alone", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", {
      type: "tool_execution_end",
      toolName: "speak_to_user",
      toolCallId: "call-1",
      isError: false,
      result: { details: { published: true } },
    });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Final visible fallback."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe("Final visible fallback.");
  });

  it("keeps choices and task-style tool calls from suppressing a later final answer", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", {
      type: "tool_execution_start",
      toolName: "present_choices",
      toolCallId: "choice-1",
      args: {},
    });
    tracker.handleRuntimeEvent("manager-1", {
      type: "tool_execution_end",
      toolName: "present_choices",
      toolCallId: "choice-1",
      isError: false,
      result: { ok: true },
    });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Now that you chose, continue."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].source).toBe("assistant_output");
  });

  it("projects text that accompanies a present_choices tool call", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "present_choices", toolCallId: "choice-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Pick the next step.", source: "assistant_output" });
  });

  it("can emit text that accompanies a pending present_choices card before turn end", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });

    expect(tracker.flushPreservedCandidateForTool("manager-1", "present_choices")).toBe(true);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Pick the next step.", source: "assistant_output" });

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "present_choices", toolCallId: "choice-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
  });

  it("preserves pending present_choices text when the tool start event arrives before message_end", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));

    expect(tracker.flushPreservedCandidateForTool("manager-1", "present_choices")).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Pick the next step.", source: "assistant_output" });
  });

  it("does not emit preserved candidates for the wrong tool", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });

    expect(tracker.flushPreservedCandidateForTool("manager-1", "shell")).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("does not project text that accompanies a failed present_choices tool call", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "present_choices", toolCallId: "choice-1", isError: true });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("rejects empty, error, aborted, open-tool, and non-choice tool-block assistant messages", () => {
    const cases = [
      assistantMessageEnd("   "),
      assistantMessageEnd("failed", { stopReason: "error" }),
      assistantMessageEnd("aborted", { stopReason: "aborted" }),
      assistantMessageEnd("Request was aborted", { errorMessage: "Request was aborted" }),
      assistantMessageEnd("tool", { content: [{ type: "text", text: "checking" }, { type: "toolCall", name: "shell" }] }),
    ];

    for (const event of cases) {
      const { tracker, emitted } = createTracker();
      tracker.activateTurn("manager-1", WEB_TARGET);
      tracker.handleRuntimeEvent("manager-1", event);
      tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });
      expect(emitted).toEqual([]);
    }

    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("premature"));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });
    expect(emitted).toEqual([]);
  });

  it("clears a buffered candidate when a later tool starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Premature."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("projects only the final post-tool assistant text", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Premature."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Final."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe("Final.");
  });

  it("clears turn state on turn end", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("too late"));
    tracker.handleRuntimeEvent("manager-1", { type: "agent_end" });

    expect(emitted).toEqual([]);
  });
});
