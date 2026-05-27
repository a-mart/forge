import { describe, expect, it } from "vitest";
import { SessionActiveToolsState } from "../session-active-tools.js";
import type { AgentDescriptor, AgentStatusEvent, AgentToolCallEvent } from "../types.js";

const manager = descriptor({ agentId: "session-1", role: "manager", managerId: "session-1" });
const worker = descriptor({ agentId: "worker-1", role: "worker", managerId: "session-1" });

describe("SessionActiveToolsState", () => {
  it("tracks start, update, duplicate start, and terminal end events per session", () => {
    const state = new SessionActiveToolsState();

    const start = state.recordToolCall(tool({ kind: "tool_execution_start", text: "{\"command\":\"pnpm test\"}" }));
    expect(start).toMatchObject({
      type: "session_active_tools_snapshot",
      sessionAgentId: "session-1",
      activeTools: [
        {
          sessionAgentId: "session-1",
          actorAgentId: "worker-1",
          agentId: "worker-1",
          toolCallId: "tool-1",
          toolName: "bash",
          text: "{\"command\":\"pnpm test\"}",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    state.recordToolCall(tool({ kind: "tool_execution_update", text: "progress", timestamp: "2026-01-01T00:00:01.000Z" }));
    expect(state.getSnapshot("session-1")).toMatchObject([
      { text: "progress", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" },
    ]);

    state.recordToolCall(tool({ kind: "tool_execution_start", text: "restarted", timestamp: "2026-01-01T00:00:02.000Z" }));
    expect(state.getSnapshot("session-1")).toMatchObject([
      { text: "restarted", startedAt: "2026-01-01T00:00:02.000Z", updatedAt: "2026-01-01T00:00:02.000Z" },
    ]);

    const ended = state.recordToolCall(tool({ kind: "tool_execution_end", text: "done", timestamp: "2026-01-01T00:00:03.000Z" }));
    expect(ended).toEqual({ type: "session_active_tools_snapshot", sessionAgentId: "session-1", activeTools: [] });
    expect(state.getSnapshot("session-1")).toEqual([]);
  });

  it("uses a fallback key when toolCallId is missing", () => {
    const state = new SessionActiveToolsState();

    state.recordToolCall(tool({ kind: "tool_execution_start", toolCallId: undefined, toolName: "shell" }));
    expect(state.getSnapshot("session-1")).toMatchObject([{ actorAgentId: "worker-1", toolName: "shell" }]);

    state.recordToolCall(tool({ kind: "tool_execution_end", toolCallId: undefined, toolName: "shell" }));
    expect(state.getSnapshot("session-1")).toEqual([]);
  });

  it("treats error end events as terminal removals", () => {
    const state = new SessionActiveToolsState();

    state.recordToolCall(tool({ kind: "tool_execution_start" }));
    state.recordToolCall(tool({ kind: "tool_execution_end", isError: true }));

    expect(state.getSnapshot("session-1")).toEqual([]);
  });

  it("keeps worker and manager actor tools in the same session snapshot", () => {
    const state = new SessionActiveToolsState();

    state.recordToolCall(tool({ actorAgentId: "session-1", kind: "tool_execution_start", toolCallId: "manager-tool" }));
    state.recordToolCall(tool({ actorAgentId: "worker-1", kind: "tool_execution_start", toolCallId: "worker-tool" }));

    expect(state.getSnapshot("session-1").map((entry) => entry.actorAgentId).sort()).toEqual(["session-1", "worker-1"]);
  });

  it("clears worker or whole-session entries on non-running status cleanup", () => {
    const state = new SessionActiveToolsState();

    state.recordToolCall(tool({ actorAgentId: "session-1", kind: "tool_execution_start", toolCallId: "manager-tool" }));
    state.recordToolCall(tool({ actorAgentId: "worker-1", kind: "tool_execution_start", toolCallId: "worker-tool" }));

    const workerSnapshots = state.recordAgentStatus(status("worker-1", "stopped", "session-1"), worker);
    expect(workerSnapshots).toHaveLength(1);
    expect(workerSnapshots[0].activeTools).toMatchObject([{ actorAgentId: "session-1" }]);

    const managerSnapshots = state.recordAgentStatus(status("session-1", "terminated"), manager);
    expect(managerSnapshots).toEqual([{ type: "session_active_tools_snapshot", sessionAgentId: "session-1", activeTools: [] }]);
  });

  it("returns authoritative cloned snapshots for reconnect replacement", () => {
    const state = new SessionActiveToolsState();
    state.recordToolCall(tool({ kind: "tool_execution_start" }));

    const snapshot = state.buildSnapshotEvent("session-1", "request-1");
    snapshot.activeTools[0]!.text = "mutated client state";

    expect(snapshot).toMatchObject({ type: "session_active_tools_snapshot", requestId: "request-1" });
    expect(state.getSnapshot("session-1")).toMatchObject([{ text: "{}" }]);
  });
});

function tool(overrides: Partial<AgentToolCallEvent>): AgentToolCallEvent {
  return {
    type: "agent_tool_call",
    agentId: "session-1",
    actorAgentId: "worker-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    kind: "tool_execution_start",
    toolName: "bash",
    toolCallId: "tool-1",
    text: "{}",
    ...overrides,
  };
}

function status(agentId: string, statusValue: AgentStatusEvent["status"], managerId?: string): AgentStatusEvent {
  return {
    type: "agent_status",
    agentId,
    ...(managerId !== undefined ? { managerId } : {}),
    status: statusValue,
    pendingCount: 0,
  };
}

function descriptor(overrides: Pick<AgentDescriptor, "agentId" | "role" | "managerId">): AgentDescriptor {
  return {
    agentId: overrides.agentId,
    displayName: overrides.agentId,
    role: overrides.role,
    managerId: overrides.managerId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: "/tmp/session.jsonl",
  };
}
