import { describe, expect, it } from "vitest";
import {
  RuntimeConversationEventMapper,
  safeJson
} from "../session/runtime-conversation-event-mapper.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { AgentDescriptor } from "../types.js";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function makeDescriptor(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? "worker",
    displayName: overrides.displayName ?? "Worker",
    role: overrides.role ?? "worker",
    managerId: overrides.managerId ?? "manager",
    status: overrides.status ?? "idle",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    cwd: "/tmp/forge-test",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    sessionFile: "/tmp/forge-test/session.jsonl",
    ...overrides
  };
}

function mapRuntimeEvent(options: {
  agentId?: string;
  event: RuntimeSessionEvent;
  descriptor?: AgentDescriptor;
}) {
  return new RuntimeConversationEventMapper().mapRuntimeEvent({
    agentId: options.agentId ?? options.descriptor?.agentId ?? "worker",
    event: options.event,
    timestamp: FIXED_NOW,
    descriptor: options.descriptor
  });
}

describe("RuntimeConversationEventMapper", () => {
  it("maps worker tool start/update/end to manager-context tool activity before worker-local logs", () => {
    const descriptor = makeDescriptor();

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_start",
          toolName: "read",
          toolCallId: "tool-1",
          args: { path: "README.md" }
        }
      })
    ).toEqual([
      {
        type: "agent_tool_call",
        agentId: "manager",
        actorAgentId: "worker",
        timestamp: FIXED_NOW,
        kind: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-1",
        text: '{"path":"README.md"}'
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "tool_execution_start",
        toolName: "read",
        toolCallId: "tool-1",
        text: '{"path":"README.md"}'
      }
    ]);

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_update",
          toolName: "read",
          toolCallId: "tool-1",
          partialResult: { bytes: 10 }
        }
      }).map((projection) => projection.type)
    ).toEqual(["agent_tool_call", "conversation_log"]);

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "tool-1",
          result: { ok: true },
          isError: true
        }
      })
    ).toMatchObject([
      { type: "agent_tool_call", kind: "tool_execution_end", isError: true },
      { type: "conversation_log", kind: "tool_execution_end", isError: true }
    ]);
  });

  it("maps manager tool events to manager-context activity only", () => {
    const descriptor = makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" });

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "tool-2",
          args: { command: "pwd" }
        }
      })
    ).toEqual([
      {
        type: "agent_tool_call",
        agentId: "manager",
        actorAgentId: "manager",
        timestamp: FIXED_NOW,
        kind: "tool_execution_start",
        toolName: "bash",
        toolCallId: "tool-2",
        text: '{"command":"pwd"}'
      }
    ]);
  });

  it("keeps message_start role filtering to user, assistant, and system", () => {
    expect(
      mapRuntimeEvent({
        event: { type: "message_start", message: { role: "tool", content: "ignored" } as never }
      })
    ).toEqual([]);

    expect(
      mapRuntimeEvent({
        event: { type: "message_start", message: { role: "user", content: "hello" } }
      })
    ).toEqual([
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_start",
        role: "user",
        text: "hello"
      }
    ]);
  });

  it("maps worker assistant message_end content, error row, and runtime log in order", () => {
    expect(
      mapRuntimeEvent({
        descriptor: makeDescriptor(),
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "partial answer" },
              { type: "image", mimeType: "image/png", data: "abc" }
            ],
            stopReason: "error",
            errorMessage: "provider quota failed"
          } as never
        }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "worker",
        role: "assistant",
        text: "partial answer",
        attachments: [{ mimeType: "image/png", data: "abc" }],
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_message",
        agentId: "worker",
        role: "system",
        text: "⚠️ Worker reply failed: provider quota failed. The manager may need to retry after checking provider auth, quotas, or rate limits.",
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_end",
        role: "assistant",
        text: "partial answer"
      }
    ]);
  });

  it("maps worker system message_end content before the runtime log", () => {
    expect(
      mapRuntimeEvent({
        event: { type: "message_end", message: { role: "system", content: "system note" } }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "worker",
        role: "system",
        text: "system note",
        timestamp: FIXED_NOW,
        source: "system"
      },
      {
        type: "conversation_log",
        agentId: "worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "message_end",
        role: "system",
        text: "system note"
      }
    ]);
  });

  it("maps manager assistant message_end errors to only a system error row", () => {
    const descriptor = makeDescriptor({ agentId: "manager", role: "manager", managerId: "manager" });

    expect(
      mapRuntimeEvent({
        descriptor,
        event: {
          type: "message_end",
          message: {
            role: "assistant",
            content: "unfinished manager answer",
            stopReason: "error",
            errorMessage: "maximum context length exceeded"
          } as never
        }
      })
    ).toEqual([
      {
        type: "conversation_message",
        agentId: "manager",
        role: "system",
        text: "⚠️ Manager reply failed because the prompt exceeded the model context window (maximum context length exceeded). Try compacting the conversation to free up context space.",
        timestamp: FIXED_NOW,
        source: "system"
      }
    ]);
  });

  it("preserves missing descriptor behavior for tool events", () => {
    expect(
      mapRuntimeEvent({
        agentId: "missing-worker",
        event: {
          type: "tool_execution_end",
          toolName: "read",
          toolCallId: "tool-3",
          result: { ok: false },
          isError: false
        }
      })
    ).toEqual([
      {
        type: "conversation_log",
        agentId: "missing-worker",
        timestamp: FIXED_NOW,
        source: "runtime_log",
        kind: "tool_execution_end",
        toolName: "read",
        toolCallId: "tool-3",
        text: '{"ok":false}',
        isError: false
      }
    ]);
  });

  it("preserves safeJson circular and oversized behavior", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;

    expect(safeJson(circular)).toBe("[object Object]");

    const oversized = safeJson({ value: "x".repeat(40 * 1024) });
    expect(Buffer.byteLength(oversized, "utf8")).toBe(32 * 1024);
    expect(oversized.endsWith(" [truncated]")).toBe(true);
  });
});
