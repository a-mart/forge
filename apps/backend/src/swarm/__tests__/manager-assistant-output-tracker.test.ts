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

function assistantMessageUpdate(text: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "message_update" as const,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
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

  it("treats assistant text with no same-turn work as final output, not progress", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Next I'll run the tests."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Next I'll run the tests.", source: "assistant_output" });
  });

  it("does not project peer, external, explicit-tool, or missing target turns", () => {
    const targets: AssistantOutputTarget[] = [
      { kind: "peer_agent", fromAgentId: "agent-2" },
      { kind: "explicit_tool_required", reason: "collaboration_channel" },
      { kind: "external_channel", sourceContext: { channel: "telegram", channelId: "c1" } },
      { kind: "internal_only" },
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

  it("still projects clean final text after canonical successful speak_to_user publication", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.markExplicitAssistantOutput("manager-1");
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Duplicate."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Duplicate.", source: "assistant_output" });
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

  it("clears preserved candidates when a different tool starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "shell-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "shell-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

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

  it("does not recreate present_choices text after the tool already failed", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "present_choices", toolCallId: "choice-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "present_choices", toolCallId: "choice-1", isError: true });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Pick the next step.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "Pick the next step." },
        { type: "toolCall", name: "present_choices", id: "choice-1", arguments: { questions: [] } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("rejects empty, error, aborted, and unstarted non-choice tool-block assistant messages", () => {
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
  });

  it("projects text during an already open tool call as assistant_progress", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("premature"));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "premature", source: "assistant_progress" });
  });

  it("projects a buffered candidate as assistant_progress when a later tool starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Premature."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Premature.", source: "assistant_progress" });
  });

  it("projects dangling continuation text as assistant_progress when same-turn work starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Next I'll run the tests."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "Next I'll run the tests.", source: "assistant_progress" });
  });

  it("projects progress before a tool and final post-tool assistant text", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Premature."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "t1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "t1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Final."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ text: "Premature.", source: "assistant_progress" });
    expect(emitted[1]).toMatchObject({ text: "Final.", source: "assistant_output" });
  });

  it("projects text that accompanies a non-choice tool call only after the tool starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", id: "read-1", arguments: { path: "src/index.ts" } },
      ],
    }));

    expect(emitted).toEqual([]);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
  });

  it("projects text that accompanies a completed non-choice tool call as assistant_progress", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", id: "read-1", arguments: { path: "src/index.ts" } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
  });

  it("does not project text that accompanies a failed completed non-choice tool call", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: true });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", id: "read-1", arguments: { path: "src/index.ts" } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("projects a streamed assistant update as progress when tool work starts later", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageUpdate("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("Done."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
    expect(emitted[1]).toMatchObject({ text: "Done.", source: "assistant_output" });
  });

  it("does not replay the same streamed progress text as final output at message_end", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageUpdate("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
  });

  it("does not replay the same streamed progress text as progress when message_end arrives before tool completion", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageUpdate("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now."));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
  });

  it("does not duplicate already emitted streamed progress when final text includes a closeout suffix", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageUpdate("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now. Done."));
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
    expect(emitted[1]).toMatchObject({ text: "Done.", source: "assistant_output" });
  });

  it("does not project text that accompanies a non-choice tool call when a different tool starts", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", id: "read-1", arguments: { path: "src/index.ts" } },
      ],
    }));

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "shell", toolCallId: "shell-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "shell", toolCallId: "shell-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
  });

  it("matches non-choice tool progress by tool name when the provider omits a call id", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
      ],
    }));

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "runtime-read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "runtime-read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
  });

  it("projects text that accompanies an already-started non-choice tool call as assistant_progress", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", WEB_TARGET);

    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now.", {
      stopReason: "toolUse",
      content: [
        { type: "text", text: "I'll inspect the files now." },
        { type: "toolCall", name: "read", id: "read-1", arguments: { path: "src/index.ts" } },
      ],
    }));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_end", toolName: "read", toolCallId: "read-1", isError: false });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ text: "I'll inspect the files now.", source: "assistant_progress" });
  });

  it("does not project assistant_progress for routed-required targets", () => {
    const { tracker, emitted } = createTracker();
    tracker.activateTurn("manager-1", { kind: "explicit_tool_required", reason: "collaboration_channel" });

    tracker.handleRuntimeEvent("manager-1", assistantMessageEnd("I'll inspect the files now."));
    tracker.handleRuntimeEvent("manager-1", { type: "tool_execution_start", toolName: "read", toolCallId: "read-1", args: {} });
    tracker.handleRuntimeEvent("manager-1", { type: "turn_end", toolResults: [] });

    expect(emitted).toEqual([]);
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
