import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor, AgentToolCallEvent, ConversationEntryEvent } from "../types.js";
import { ConversationTimeline, CONVERSATION_ENTRY_TYPE } from "../session/conversation-timeline.js";
import { reconcileInterruptedToolCallsForBoot } from "../interrupted-tool-reconciliation.js";

const NOW = "2026-05-14T00:00:00.000Z";

function descriptor(overrides: Partial<AgentDescriptor>): AgentDescriptor {
  return {
    agentId: overrides.agentId ?? "manager",
    displayName: overrides.displayName ?? overrides.agentId ?? "Manager",
    role: overrides.role ?? "manager",
    managerId: overrides.managerId ?? overrides.agentId ?? "manager",
    status: overrides.status ?? "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    model: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium",
    },
    sessionFile: overrides.sessionFile ?? "/tmp/session.jsonl",
    profileId: overrides.profileId,
    specialist: overrides.specialist,
  } as AgentDescriptor;
}

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "interrupted-tool-reconciliation-"));
  const manager = descriptor({ agentId: "manager", role: "manager", managerId: "manager", sessionFile: join(dir, "session.jsonl") });
  const worker = descriptor({ agentId: "worker", role: "worker", managerId: "manager", status: "streaming", sessionFile: join(dir, "worker.jsonl") });
  const timeline = new ConversationTimeline({ now: () => "2026-01-01T00:00:00.000Z" });
  const append = (event: ConversationEntryEvent) => timeline.appendConversationEntry(manager, event);
  return { manager, worker, append };
}

function tool(overrides: Partial<AgentToolCallEvent>): AgentToolCallEvent {
  return {
    type: "agent_tool_call",
    agentId: "manager",
    actorAgentId: "worker",
    timestamp: "2026-01-01T00:00:00.000Z",
    kind: "tool_execution_start",
    toolName: "shell",
    toolCallId: "tool-1",
    text: "{}",
    ...overrides,
  };
}

interface RawCustomEntry {
  type?: string;
  customType?: string;
  id?: string;
  parentId?: string | null;
  data?: ConversationEntryEvent;
}

async function readRawCustomEntries(sessionFile: string): Promise<RawCustomEntry[]> {
  const text = await readFile(sessionFile, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RawCustomEntry)
    .filter((entry) => entry.type === "custom" && entry.customType === CONVERSATION_ENTRY_TYPE);
}

async function readConversationEntries(sessionFile: string): Promise<ConversationEntryEvent[]> {
  return (await readRawCustomEntries(sessionFile)).map((entry) => entry.data!);
}

describe("reconcileInterruptedToolCallsForBoot", () => {
  it("does not append anything when a streaming actor's tool call already has an end", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ kind: "tool_execution_start", toolCallId: "matched" }));
    append(tool({ kind: "tool_execution_end", toolCallId: "matched", text: "done" }));

    const result = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const entries = await readConversationEntries(manager.sessionFile);
    expect(result).toEqual({ reconciledToolCalls: 0, deliveryWarnings: 0 });
    expect(entries).toHaveLength(2);
  });

  it("appends a synthetic error end for an unmatched tool start from an interrupted streaming actor", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ toolName: "shell", toolCallId: "open-tool", text: "{\"command\":\"pnpm test\"}" }));

    const result = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const rawEntries = await readRawCustomEntries(manager.sessionFile);
    const entries = rawEntries.map((entry) => entry.data!);
    expect(result).toEqual({ reconciledToolCalls: 1, deliveryWarnings: 0 });
    expect(rawEntries.at(-1)?.parentId).toBe(rawEntries.at(-2)?.id);
    expect(entries.at(-1)).toMatchObject({
      type: "agent_tool_call",
      agentId: "manager",
      actorAgentId: "worker",
      kind: "tool_execution_end",
      toolName: "shell",
      toolCallId: "open-tool",
      isError: true,
      text: "Tool call interrupted by backend restart before completion.",
    });
  });

  it("does not reconcile duplicate starts followed by an end for the same tool-call key", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ kind: "tool_execution_start", toolCallId: "duplicate", text: "first" }));
    append(tool({ kind: "tool_execution_start", toolCallId: "duplicate", text: "second" }));
    append(tool({ kind: "tool_execution_end", toolCallId: "duplicate", text: "done" }));

    const result = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const entries = await readConversationEntries(manager.sessionFile);
    expect(result).toEqual({ reconciledToolCalls: 0, deliveryWarnings: 0 });
    expect(entries).toHaveLength(3);
  });

  it("does not reconcile duplicate starts followed by an end when toolCallId is missing", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ kind: "tool_execution_start", toolCallId: undefined, toolName: "shell", text: "first" }));
    append(tool({ kind: "tool_execution_start", toolCallId: undefined, toolName: "shell", text: "second" }));
    append(tool({ kind: "tool_execution_end", toolCallId: undefined, toolName: "shell", text: "done" }));

    const result = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const entries = await readConversationEntries(manager.sessionFile);
    expect(result).toEqual({ reconciledToolCalls: 0, deliveryWarnings: 0 });
    expect(entries).toHaveLength(3);
  });

  it("chains synthetic append to a large final tool-start entry", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ toolName: "shell", toolCallId: "large-tool", text: JSON.stringify({ output: "x".repeat(12_000) }) }));

    reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const rawEntries = await readRawCustomEntries(manager.sessionFile);
    expect(rawEntries.at(-2)?.data).toMatchObject({
      type: "agent_tool_call",
      kind: "tool_execution_start",
      toolCallId: "large-tool",
    });
    expect(rawEntries.at(-1)?.data).toMatchObject({
      type: "agent_tool_call",
      kind: "tool_execution_end",
      toolCallId: "large-tool",
    });
    expect(rawEntries.at(-1)?.parentId).toBe(rawEntries.at(-2)?.id);
  });

  it("is idempotent after appending the synthetic end", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({ toolName: "shell", toolCallId: "open-tool" }));
    const descriptors = new Map([[manager.agentId, manager], [worker.agentId, worker]]);
    const interruptedActorAgentIds = new Set([worker.agentId]);

    reconcileInterruptedToolCallsForBoot({ descriptors, interruptedActorAgentIds, now: () => NOW });
    const second = reconcileInterruptedToolCallsForBoot({ descriptors, interruptedActorAgentIds, now: () => NOW });

    const entries = await readConversationEntries(manager.sessionFile);
    expect(second).toEqual({ reconciledToolCalls: 0, deliveryWarnings: 0 });
    expect(entries.filter((entry) => entry.type === "agent_tool_call" && entry.kind === "tool_execution_end")).toHaveLength(1);
  });

  it("adds a manager-visible warning for interrupted send_message_to_agent deliveries", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({
      toolName: "send_message_to_agent",
      toolCallId: "send-1",
      text: JSON.stringify({ targetAgentId: "manager-2", message: "Please continue the release handoff with the latest notes." }),
    }));

    const result = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const entries = await readConversationEntries(manager.sessionFile);
    expect(result).toEqual({ reconciledToolCalls: 1, deliveryWarnings: 1 });
    expect(entries.at(-2)).toMatchObject({
      type: "agent_tool_call",
      kind: "tool_execution_end",
      toolName: "send_message_to_agent",
      isError: true,
    });
    expect(entries.at(-1)).toMatchObject({
      type: "conversation_message",
      agentId: "manager",
      role: "system",
      source: "system",
    });
    expect(entries.at(-1)?.type === "conversation_message" ? entries.at(-1)?.text : "").toContain("Delivery to manager-2 may not have completed");
    expect(entries.at(-1)?.type === "conversation_message" ? entries.at(-1)?.text : "").toContain("Please continue the release handoff");
  });

  it("extracts target and leading preview from truncated send_message_to_agent JSON", async () => {
    const { manager, worker, append } = await createFixture();
    append(tool({
      toolName: "send_message_to_agent",
      toolCallId: "send-large",
      text: '{"targetAgentId":"manager-large","message":"Leading preview survives even when the JSON is truncated',
    }));

    reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([[manager.agentId, manager], [worker.agentId, worker]]),
      interruptedActorAgentIds: new Set([worker.agentId]),
      now: () => NOW,
    });

    const entries = await readConversationEntries(manager.sessionFile);
    const warning = entries.at(-1);
    expect(warning?.type).toBe("conversation_message");
    expect(warning?.type === "conversation_message" ? warning.text : "").toContain("Delivery to manager-large may not have completed");
    expect(warning?.type === "conversation_message" ? warning.text : "").toContain("Leading preview survives");
  });
});
