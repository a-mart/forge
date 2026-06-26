import type { ConversationEntryEvent } from "@forge/protocol";
import { describe, expect, it } from "vitest";
import { buildCliSessionTranscriptResponse, parseCliSessionTranscriptOptions } from "../ws/cli-session-transcript.js";
import type { AgentDescriptor } from "../swarm/types.js";

const session = createAgent({ agentId: "session-a", role: "manager", managerId: "session-a", displayName: "Session A" });
const worker = createAgent({
  agentId: "worker-a",
  role: "worker",
  managerId: "session-a",
  displayName: "Worker A",
  specialistDisplayName: "Backend Specialist",
});
const peerManager = createAgent({ agentId: "peer-manager", role: "manager", managerId: "peer-manager" });
const otherWorker = createAgent({ agentId: "other-worker", role: "worker", managerId: "peer-manager" });

describe("CLI session transcript filtering", () => {
  it("returns only user-facing manager messages by default with filtered ordinals", () => {
    const response = buildCliSessionTranscriptResponse({
      session,
      agents: [session, worker, peerManager, otherWorker],
      history: createMixedHistory(),
      transcriptOptions: { includeWorkerUpdates: false, limit: 200, offset: 0 },
    });

    expect(response.messages).toEqual([
      expect.objectContaining({ ordinal: 0, kind: "user", role: "user", source: "user_input", text: "User asks" }),
      expect.objectContaining({
        ordinal: 1,
        kind: "assistant",
        role: "assistant",
        source: "speak_to_user",
        text: "Manager replies",
      }),
      expect.objectContaining({
        ordinal: 2,
        kind: "assistant",
        role: "assistant",
        source: "assistant_progress",
        text: "Manager progress",
      }),
      expect.objectContaining({
        ordinal: 3,
        kind: "assistant",
        role: "assistant",
        source: "assistant_output",
        text: "Projected manager reply",
      }),
    ]);
    expect(response.page).toMatchObject({ total: 4, returned: 4, hasMore: false });
    expect(JSON.stringify(response)).not.toContain("rawIndex");
    expect(JSON.stringify(response)).not.toContain("Hidden system");
    expect(JSON.stringify(response)).not.toContain("project agent input");
    expect(JSON.stringify(response)).not.toContain("tool output");
    expect(JSON.stringify(response)).not.toContain("choice-q");
    expect(JSON.stringify(response)).not.toContain("cache hit");
    expect(JSON.stringify(response)).not.toContain("Worker report");
  });

  it("includes only same-manager worker updates when requested and uses safe descriptor labels", () => {
    const response = buildCliSessionTranscriptResponse({
      session,
      agents: [session, worker, peerManager, otherWorker],
      history: createMixedHistory(),
      transcriptOptions: { includeWorkerUpdates: true, limit: 200, offset: 0 },
    });

    expect(response.messages.map((message) => [message.ordinal, message.kind, message.text])).toEqual([
      [0, "user", "User asks"],
      [1, "worker_update", "Worker report"],
      [2, "assistant", "Manager replies"],
      [3, "assistant", "Manager progress"],
      [4, "assistant", "Projected manager reply"],
    ]);
    expect(response.messages[1]).toMatchObject({
      role: "worker",
      source: "worker_update",
      fromAgentId: "worker-a",
      fromDisplayName: "Backend Specialist",
      toAgentId: "session-a",
    });
    expect(JSON.stringify(response)).not.toContain("Manager-to-worker prompt");
    expect(JSON.stringify(response)).not.toContain("Peer manager note");
    expect(JSON.stringify(response)).not.toContain("Other worker report");
    expect(JSON.stringify(response)).not.toContain("secret session prompt");
  });

  it("omits source context and sanitizes attachment metadata", () => {
    const response = buildCliSessionTranscriptResponse({
      session,
      agents: [session],
      history: [
        {
          type: "conversation_message",
          agentId: "session-a",
          id: "user-with-attachments",
          role: "user",
          text: "User with attachments",
          timestamp: "2026-06-15T00:00:00.000Z",
          source: "user_input",
          sourceContext: {
            channel: "telegram",
            channelId: "telegram-channel-id",
            messageId: "telegram-message-id",
            threadTs: "thread-ts",
            userId: "telegram-user-id",
            integrationProfileId: "integration-profile-id",
          },
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              data: "base64-image-body",
              fileName: "/tmp/private/image.png",
              filePath: "/tmp/private/image.png",
            },
            {
              type: "text",
              mimeType: "text/plain",
              text: "attachment body text",
              fileName: "notes.txt",
              filePath: "/tmp/private/notes.txt",
            },
            {
              type: "binary",
              mimeType: "application/octet-stream",
              data: "base64-binary-body",
              fileName: "archive.bin",
              filePath: "/tmp/private/archive.bin",
              fileRef: "upload-ref",
              sizeBytes: 42,
            },
          ],
        },
      ],
      transcriptOptions: { includeWorkerUpdates: false, limit: 200, offset: 0 },
    });

    expect(response.messages[0]?.attachments).toEqual([
      { type: "image", mimeType: "image/png", fileName: "image.png" },
      { type: "text", mimeType: "text/plain", fileName: "notes.txt" },
      {
        type: "binary",
        mimeType: "application/octet-stream",
        fileName: "archive.bin",
        fileRef: "upload-ref",
        sizeBytes: 42,
      },
    ]);

    const json = JSON.stringify(response);
    expect(json).not.toContain("sourceContext");
    expect(json).not.toContain("telegram-channel-id");
    expect(json).not.toContain("telegram-message-id");
    expect(json).not.toContain("thread-ts");
    expect(json).not.toContain("telegram-user-id");
    expect(json).not.toContain("integration-profile-id");
    expect(json).not.toContain("base64-image-body");
    expect(json).not.toContain("attachment body text");
    expect(json).not.toContain("base64-binary-body");
    expect(json).not.toContain("filePath");
    expect(json).not.toContain("/tmp/private");
  });

  it("applies pagination after filtering", () => {
    const response = buildCliSessionTranscriptResponse({
      session,
      agents: [session, worker],
      history: createMixedHistory(),
      transcriptOptions: { includeWorkerUpdates: true, limit: 1, offset: 1 },
    });

    expect(response.messages).toEqual([expect.objectContaining({ ordinal: 1, text: "Worker report" })]);
    expect(response.page).toEqual({ total: 5, returned: 1, offset: 1, limit: 1, hasMore: true, nextOffset: 2 });
  });

  it("normalizes and validates query options", () => {
    expect(parseCliSessionTranscriptOptions(new URLSearchParams())).toEqual({
      ok: true,
      options: { includeWorkerUpdates: false, limit: 200, offset: 0 },
    });
    expect(parseCliSessionTranscriptOptions(new URLSearchParams("includeWorkerUpdates=true&limit=1&offset=2"))).toEqual({
      ok: true,
      options: { includeWorkerUpdates: true, limit: 1, offset: 2 },
    });
    expect(parseCliSessionTranscriptOptions(new URLSearchParams("limit=0"))).toMatchObject({
      ok: false,
      code: "invalid_limit",
    });
    expect(parseCliSessionTranscriptOptions(new URLSearchParams("limit=2001"))).toMatchObject({
      ok: false,
      code: "invalid_limit",
    });
    expect(parseCliSessionTranscriptOptions(new URLSearchParams("offset=-1"))).toMatchObject({
      ok: false,
      code: "invalid_offset",
    });
    expect(parseCliSessionTranscriptOptions(new URLSearchParams("includeWorkerUpdates=yes"))).toMatchObject({
      ok: false,
      code: "invalid_include_worker_updates",
    });
  });
});

function createMixedHistory(): ConversationEntryEvent[] {
  return [
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "user-1",
      role: "user",
      text: "User asks",
      timestamp: "2026-06-15T00:00:00.000Z",
      source: "user_input",
      sourceContext: { channel: "cli", channelId: "cli-channel-id" },
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      role: "system",
      text: "Hidden system",
      timestamp: "2026-06-15T00:00:01.000Z",
      source: "system",
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      role: "user",
      text: "project agent input",
      timestamp: "2026-06-15T00:00:02.000Z",
      source: "project_agent_input",
      projectAgentContext: { fromAgentId: "docs-agent", fromDisplayName: "Docs Agent" },
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:03.000Z",
      source: "agent_to_agent",
      fromAgentId: "worker-a",
      toAgentId: "session-a",
      text: "Worker report",
      sourceContext: { channel: "telegram", channelId: "telegram-channel-id" },
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:04.000Z",
      source: "user_to_agent",
      fromAgentId: "session-a",
      toAgentId: "worker-a",
      text: "Manager-to-worker prompt",
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:05.000Z",
      source: "agent_to_agent",
      fromAgentId: "peer-manager",
      toAgentId: "session-a",
      text: "Peer manager note",
    },
    {
      type: "agent_message",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:06.000Z",
      source: "agent_to_agent",
      fromAgentId: "other-worker",
      toAgentId: "session-a",
      text: "Other worker report",
    },
    {
      type: "conversation_log",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:07.000Z",
      source: "runtime_log",
      kind: "tool_execution_update",
      toolName: "bash",
      toolCallId: "tool-call-id",
      text: "tool output",
    },
    {
      type: "agent_tool_call",
      agentId: "session-a",
      actorAgentId: "session-a",
      timestamp: "2026-06-15T00:00:08.000Z",
      kind: "tool_execution_update",
      toolName: "bash",
      toolCallId: "tool-call-id",
      text: "tool row",
    },
    {
      type: "choice_request",
      agentId: "session-a",
      choiceId: "choice-q",
      questions: [{ id: "q", question: "Pick one?" }],
      status: "pending",
      timestamp: "2026-06-15T00:00:09.000Z",
    },
    {
      type: "work_plan_created",
      agentId: "session-a",
      id: "work-plan-row",
      timestamp: "2026-06-15T00:00:10.000Z",
      planId: "plan-a",
      stateRevision: 1,
      planRevision: 1,
      plan: { id: "plan-a", title: "Plan", status: "active", items: [] },
    } as unknown as ConversationEntryEvent,
    {
      type: "model_cache_observation",
      agentId: "session-a",
      timestamp: "2026-06-15T00:00:11.000Z",
      text: "cache hit",
    } as unknown as ConversationEntryEvent,
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "assistant-1",
      role: "assistant",
      text: "Manager replies",
      timestamp: "2026-06-15T00:00:12.000Z",
      source: "speak_to_user",
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "assistant-2",
      role: "assistant",
      text: "Manager progress",
      timestamp: "2026-06-15T00:00:13.000Z",
      source: "assistant_progress",
      sourceContext: { channel: "web" },
    },
    {
      type: "conversation_message",
      agentId: "session-a",
      id: "assistant-3",
      role: "assistant",
      text: "Projected manager reply",
      timestamp: "2026-06-15T00:00:14.000Z",
      source: "assistant_output",
      sourceContext: { channel: "web" },
    },
  ];
}

function createAgent(overrides: Partial<AgentDescriptor> & { agentId: string }): AgentDescriptor {
  const role = overrides.role ?? "manager";
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role,
    managerId: overrides.managerId ?? (role === "manager" ? overrides.agentId : "session-a"),
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: `/tmp/project/sessions/${overrides.agentId}.jsonl`,
    ...overrides,
  };
}
