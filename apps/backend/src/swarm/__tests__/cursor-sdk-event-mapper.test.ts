import { describe, expect, it } from "vitest";
import { CursorSdkEventMapper } from "../runtime/cursor-sdk/cursor-sdk-event-mapper.js";

describe("cursor-sdk-event-mapper", () => {
  it("streams assistant text with one message_end at prompt completion", () => {
    const mapper = new CursorSdkEventMapper();

    expect(mapper.beginPrompt()).toEqual([{ type: "agent_start" }, { type: "turn_start" }]);
    expect(mapper.mapSdkMessage({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hel" }] }
    })).toEqual([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hel" }] } }
    ]);
    expect(mapper.mapDelta({ type: "text-delta", text: "lo" })).toEqual([
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }
    ]);
    expect(mapper.completePrompt()).toEqual([
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
      { type: "turn_end", toolResults: [] },
      { type: "agent_end" }
    ]);
  });

  it("attaches provider metadata to turn_end at prompt completion", () => {
    const mapper = new CursorSdkEventMapper();
    mapper.beginPrompt();

    expect(mapper.completePrompt({
      provider: "cursor-sdk",
      modelId: "composer-2.5",
      usage: { input: 10, output: 4, total: 14 },
      providerRequestId: "run-1",
      stopReason: "FINISHED",
    })).toEqual([
      {
        type: "turn_end",
        toolResults: [],
        meta: {
          provider: "cursor-sdk",
          modelId: "composer-2.5",
          usage: { input: 10, output: 4, total: 14 },
          providerRequestId: "run-1",
          stopReason: "FINISHED",
        }
      },
      { type: "agent_end" }
    ]);
  });

  it("maps and dedupes tool calls from stream messages", () => {
    const mapper = new CursorSdkEventMapper();
    mapper.beginPrompt();

    expect(mapper.mapSdkMessage({
      type: "tool_call",
      call_id: "call-1",
      name: "shell",
      status: "running",
      args: { command: "pwd" }
    })).toEqual([
      { type: "tool_execution_start", toolName: "execute", toolCallId: "call-1", args: { command: "pwd" } }
    ]);
    expect(mapper.mapSdkMessage({
      type: "tool_call",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      result: { stdout: "/tmp" }
    })).toEqual([
      { type: "tool_execution_end", toolName: "execute", toolCallId: "call-1", result: { stdout: "/tmp" }, isError: false }
    ]);
    expect(mapper.mapSdkMessage({
      type: "tool_call",
      call_id: "call-1",
      name: "shell",
      status: "completed",
      result: { stdout: "/tmp" }
    })).toEqual([]);
    expect(mapper.completePrompt()).toEqual([
      { type: "turn_end", toolResults: [{ stdout: "/tmp" }] },
      { type: "agent_end" }
    ]);
  });

  it("maps assistant tool_use blocks as tool execution starts", () => {
    const mapper = new CursorSdkEventMapper();
    mapper.beginPrompt();

    expect(mapper.mapSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll inspect it." },
          { type: "tool_use", id: "toolu-1", name: "read", input: { path: "README.md" } }
        ]
      }
    })).toEqual([
      { type: "message_start", message: { role: "assistant", content: "" } },
      { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "I'll inspect it." }] } },
      { type: "tool_execution_start", toolName: "read_file", toolCallId: "toolu-1", args: { path: "README.md" } }
    ]);
  });

  it("maps delta tool calls and error result shapes", () => {
    const mapper = new CursorSdkEventMapper();
    mapper.beginPrompt();

    expect(mapper.mapDelta({
      type: "tool-call-completed",
      callId: "call-2",
      toolCall: { name: "write", args: { path: "a" }, result: { status: "error" }, status: "error" }
    })).toEqual([
      { type: "tool_execution_start", toolName: "write", toolCallId: "call-2", args: { path: "a" } },
      { type: "tool_execution_end", toolName: "write", toolCallId: "call-2", result: { status: "error" }, isError: true }
    ]);
    expect(mapper.mapDelta({
      type: "tool-call-completed",
      callId: "call-3",
      toolCall: { name: "write", result: { success: false }, status: "completed" }
    })).toEqual([
      { type: "tool_execution_start", toolName: "write", toolCallId: "call-3", args: {} },
      { type: "tool_execution_end", toolName: "write", toolCallId: "call-3", result: { success: false }, isError: true }
    ]);
    expect(mapper.mapSdkMessage({ type: "status", status: "CANCELLED" })).toEqual([]);
    expect(mapper.getTerminalStatus()).toBe("CANCELLED");
  });
});
