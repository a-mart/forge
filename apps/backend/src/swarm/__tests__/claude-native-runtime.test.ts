import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentRuntime, NATIVE_CLAUDE_STATE } from "../runtime/claude/claude-agent-runtime.js";
import { ClaudeRuntimeEvents } from "../runtime/claude/claude-runtime-events.js";
import { inferModelChangeContinuityRuntimeKind } from "../runtime/model-change-continuity.js";
import type { AgentDescriptor } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";
import type { SecureRuntimeBinding } from "../secure-sessions/runtime/secure-runtime-binding.js";

async function fixture(root: string, options: { prompt?: string; onEnd?: () => Promise<void>; binding?: SecureRuntimeBinding } = {}) {
  const events: RuntimeSessionEvent[] = [];
  const frames: SDKMessage[] = [];
  let waiting: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  let input!: AsyncIterator<SDKUserMessage>;
  let setup!: Options;
  let ended = false;
  let allowClose = true;
  const consumed = vi.fn();
  const errors = vi.fn();
  const native = { backgroundTasks: vi.fn(async (_id: string) => true), initializationResult: vi.fn(async () => ({})), supportedModels: vi.fn(async () => []),
    close: vi.fn(() => { if (!allowClose) return; ended = true; waiting?.({ done: true, value: undefined }); }),
    [Symbol.asyncIterator]() { return this; }, next(): Promise<IteratorResult<SDKMessage>> {
      if (frames.length) return Promise.resolve({ done: false, value: frames.shift()! });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      return new Promise(resolve => { waiting = resolve; });
    },
  };
  const runtime = await ClaudeAgentRuntime.create({ descriptor: { agentId: "owner", managerId: "owner", role: "manager", profileId: "fixture", cwd: root,
    sessionFile: join(root, "session.jsonl"), model: { provider: "claude-native", modelId: "claude-opus-5-5", thinkingLevel: "medium" } } as AgentDescriptor,
    systemPrompt: options.prompt ?? "Current Forge prompt", executable: "unused", env: {}, projectTrusted: false, tools: [], host: { requestUserChoice: vi.fn() },
    creationOptions: { onStartupRecoveryConsumed: consumed, secureRuntimeBinding: options.binding },
    callbacks: { onStatusChange: vi.fn(), onSessionEvent: (_id, event) => { events.push(event); }, onAgentEnd: options.onEnd ?? vi.fn(), onRuntimeError: errors },
    createQuery: args => { input = (args.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator](); setup = args.options!; return native as never; },
  });
  return { runtime, setup, consumed, errors, events, input, native, allowClose: (value: boolean) => { allowClose = value; },
    emit: async (frame: unknown) => { if (waiting) { const next = waiting; waiting = undefined; next({ done: false, value: frame as SDKMessage }); } else frames.push(frame as SDKMessage); await new Promise(resolve => setTimeout(resolve, 5)); },
  };
}
const result = (ids: string[], fields = {}) => ({ type: "result", subtype: "success", is_error: false, result: "Done", user_message_uuids: ids,
  duration_ms: 5, duration_api_ms: 4, total_cost_usd: 0.1, usage: { input_tokens: 5, output_tokens: 3 }, modelUsage: {}, ...fields });

describe("Claude native lifecycle", () => {
  it("keeps background work active across replies and completes once after all commands and the follow-on reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-background-lifecycle-"));
    const onEnd = vi.fn(); const f = await fixture(root, { onEnd });
    try {
      const first = await f.runtime.sendMessage("work"); await f.input.next();
      for (const id of ["one", "two"]) {
        await f.emit({ type: "assistant", user_message_uuids: [first.deliveryId], message: { content: [{ type: "tool_use", id, name: "Bash", input: {} }] } });
        await f.emit({ type: "system", subtype: "task_started", task_id: id, tool_use_id: id, is_backgrounded: true });
      }
      await f.emit(result([first.deliveryId], { result: "Commands still running" }));
      expect(f.runtime.getStatus()).toBe("streaming");
      expect(onEnd).not.toHaveBeenCalled();
      expect(f.events.filter(e => e.type === "agent_end")).toHaveLength(0);
      // Reply publication remains normal; agent_end, not a text reply, settles work.
      expect(f.events.filter(e => e.type === "message_end").at(-1)).toMatchObject({ message: { stopReason: "stop" } });
      await expect(f.runtime.compact()).rejects.toThrow("finish before compacting");
      const follow = await f.runtime.sendMessage("afterward", "followUp");
      expect(follow.acceptedMode).toBe("followUp");
      const steer = await f.runtime.sendMessage("status"); await f.input.next();
      expect(steer.acceptedMode).toBe("steer");
      await f.emit(result([steer.deliveryId]));
      expect(f.runtime.getPendingCount()).toBe(1);
      for (const [id, status] of [["one", "completed"], ["two", "failed"]]) {
        await f.emit({ type: "system", subtype: "task_notification", task_id: id, tool_use_id: id, status, summary: status });
        expect(f.runtime.getStatus()).toBe("streaming");
        expect(onEnd).not.toHaveBeenCalled();
      }
      await f.emit(result([]));
      expect(onEnd).toHaveBeenCalledOnce();
      expect(f.events.filter(e => e.type === "agent_end")).toHaveLength(1);
      expect((await f.input.next()).value.uuid).toBe(follow.deliveryId);
      await f.emit(result([follow.deliveryId]));
      expect(f.runtime.getStatus()).toBe("idle");
      expect(f.runtime.getPendingCount()).toBe(0);
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("cancels background work on Stop all even after the native reply has ended", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-background-stop-")); const f = await fixture(root);
    try {
      const first = await f.runtime.sendMessage("work"); await f.input.next();
      await f.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "shell", name: "Bash", input: {} }] } });
      await f.emit({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "shell", is_backgrounded: true });
      await f.emit(result([first.deliveryId]));
      expect(f.events.filter(e => e.type === "agent_end")).toHaveLength(0);
      await f.runtime.stopInFlight();
      expect(f.runtime.getStatus()).toBe("idle");
      expect(f.events.filter(e => e.type === "agent_end")).toHaveLength(1);
      expect(f.events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolCallId: "shell", result: { status: "cancelled" } }));
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("bounds native command waits without changing Forge MCP timeouts or short explicit waits", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-command-policy-")); const f = await fixture(root);
    try {
      const hook = f.setup.hooks!.PreToolUse![0]!.hooks[0]!;
      const apply = async (name: string, input: object) => await hook({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input } as never, "id", { signal: new AbortController().signal });
      expect(await apply("Bash", { command: "gh run watch 123", timeout: 3600000 })).toMatchObject({ hookSpecificOutput: { updatedInput: { command: "gh run watch 123", timeout: 10000 } } });
      expect(await apply("Bash", { command: "make check" })).toMatchObject({ hookSpecificOutput: { updatedInput: { timeout: 10000 } } });
      expect(await apply("Bash", { command: "sleep 90; echo finished", timeout: 3600000 })).toMatchObject({ hookSpecificOutput: { updatedInput: { run_in_background: true, timeout: 3600000 } } });
      expect(await apply("Bash", { command: "sleep 1", timeout: 2000 })).toEqual({});
      expect(await apply("Bash", { command: "make build", run_in_background: true })).toEqual({});
      expect(await apply("TaskOutput", { task_id: "task", block: true, timeout: 300000 })).toMatchObject({ hookSpecificOutput: { updatedInput: { timeout: 10000, task_id: "task", block: true } } });
      expect(await apply("mcp__forge__secure_bash", { command: "ssh fixture", timeout: 3600 })).toEqual({});
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true, "error"])("targets only foreground Bash for steering, keeps follow-ups queued, and tolerates background response %s", async outcome => {
    const root = await mkdtemp(join(tmpdir(), "forge-command-control-")); const f = await fixture(root);
    if (outcome === "error") f.native.backgroundTasks.mockRejectedValue(new Error("disabled"));
    else f.native.backgroundTasks.mockResolvedValue(outcome);
    try {
      const first = await f.runtime.sendMessage("work"); await f.input.next();
      expect(f.native.backgroundTasks).not.toHaveBeenCalled();
      await f.emit({ type: "assistant", user_message_uuids: [first.deliveryId], message: { content: [{ type: "tool_use", id: "bash-one", name: "Bash", input: { command: "make build" } }] } });
      await f.runtime.sendMessage("afterward", "followUp");
      expect(f.native.backgroundTasks).not.toHaveBeenCalled();
      const steer = await f.runtime.sendMessage("status"); await f.input.next();
      expect(f.native.backgroundTasks).toHaveBeenCalledWith("bash-one");
      await f.emit({ type: "assistant", user_message_uuids: [steer.deliveryId], message: { content: [{ type: "text", text: "Status" }] } });
      expect(f.runtime.getPendingCount()).toBe(1);
      expect(f.errors).not.toHaveBeenCalled();
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps background commands open across a result, then settles them on native completion or Stop all", () => {
    const mapper = new ClaudeRuntimeEvents();
    const start = (id: string) => mapper.map({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "build" } }] } } as never);
    start("shell");
    expect(mapper.map({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "shell", task_type: "local_bash", is_backgrounded: true } as never)).toContainEqual(expect.objectContaining({ type: "tool_execution_update", partialResult: expect.objectContaining({ status: "running_in_background" }) }));
    expect(mapper.map({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "shell", content: "background" }] } } as never).some(e => e.type === "tool_execution_end")).toBe(false);
    expect(mapper.finish(true, "Still running").some(e => e.type === "tool_execution_end")).toBe(false);
    expect(mapper.map({ type: "system", subtype: "task_notification", task_id: "task", tool_use_id: "shell", status: "completed", summary: "Build done" } as never)).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: false }));
    start("second");
    mapper.map({ type: "system", subtype: "task_started", task_id: "second-task", tool_use_id: "second", task_type: "local_bash", is_backgrounded: true } as never);
    expect(mapper.finish(false, undefined, true)).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: true, result: expect.objectContaining({ status: "cancelled" }) }));
  });

  it.each([true, false])("preserves a provider rejection instead of hiding it as a generic turn failure (assistant frame: %s)", async assistantFrame => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-error-"));
    const binding = { guardValue: (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll("PRIVATE_TOKEN", "[REDACTED]")) } as SecureRuntimeBinding;
    const f = await fixture(root, { binding });
    try {
      const input = await f.runtime.sendMessage("work"); await f.input.next();
      const message = "API Error: 400 This model requires Claude Code 2.1.280. PRIVATE_TOKEN";
      if (assistantFrame) await f.emit({ type: "assistant", error: "invalid_request", user_message_uuids: [input.deliveryId],
        message: { content: [{ type: "text", text: message }] } });
      await f.emit(result([input.deliveryId], { is_error: true, result: message }));
      expect(f.errors).toHaveBeenCalledOnce();
      expect(f.errors.mock.calls[0]?.[1].message).toContain("requires Claude Code 2.1.280");
      expect(JSON.stringify(f.errors.mock.calls)).not.toContain("PRIVATE_TOKEN");
      expect(f.events.some(e => e.type === "message_end" && JSON.stringify(e).includes("API Error"))).toBe(false);
      expect(f.runtime.getStatus()).toBe("idle");
      const next = await f.runtime.sendMessage("retry"); await f.input.next(); await f.emit(result([next.deliveryId]));
      expect(f.errors).toHaveBeenCalledOnce();
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });
  it("does not equate queue delivery with consumption, and activates coalesced steers once", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-unit-"));
    const f = await fixture(root);
    try {
      const first = await f.runtime.sendMessage("first"); await f.input.next();
      const steer = await f.runtime.sendMessage("worker result"); await f.input.next();
      expect(f.runtime.getPendingCount()).toBe(2);
      expect(f.consumed).not.toHaveBeenCalled();
      expect(f.events.filter(e => e.type === "message_start")).toHaveLength(1);
      await f.emit({ type: "assistant", uuid: "one", user_message_uuids: [first.deliveryId, steer.deliveryId], parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Handled both" }] } });
      expect(f.runtime.getPendingCount()).toBe(0); expect(f.consumed).toHaveBeenCalledOnce();
      await f.emit(result([first.deliveryId, steer.deliveryId], { result: "Handled both" }));
      expect(f.events.filter(e => e.type === "message_start" && e.message.role === "user")).toHaveLength(2);
      expect(f.events.filter(e => e.type === "message_end")).toHaveLength(1);
      expect(f.runtime.getStatus()).toBe("idle");
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("leaves late accepted input with Claude rather than replaying it after a result", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-late-")); const f = await fixture(root);
    try {
      const first = await f.runtime.sendMessage("first"); await f.input.next();
      const second = await f.runtime.sendMessage("late result"); await f.input.next();
      await f.emit(result([first.deliveryId], { queued_turn_count: 1 }));
      expect(f.runtime.getPendingCount()).toBe(1); expect(f.runtime.getStatus()).toBe("streaming");
      await f.emit(result([second.deliveryId]));
      expect(f.runtime.getPendingCount()).toBe(0); expect(f.runtime.getStatus()).toBe("idle");
      expect(f.events.filter(e => e.type === "message_start" && e.message.role === "user" && e.message.content === "late result")).toHaveLength(1);
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("blocks replacement until cleanup settles and allows a cleanup retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-stop-")); const f = await fixture(root);
    try {
      await f.runtime.sendMessage("work"); await f.input.next();
      f.allowClose(false);
      await expect(f.runtime.shutdownForReplacement({ shutdownTimeoutMs: 10 })).rejects.toThrow("replacement remains blocked");
      await expect(f.runtime.sendMessage("unsafe continuation")).rejects.toThrow("stopped or unavailable");
      f.allowClose(true); await f.runtime.shutdownForReplacement();
      const resumed = await fixture(root, { prompt: "Updated Forge posture" });
      expect(resumed.setup.resume).toBe((f.runtime.getCustomEntries(NATIVE_CLAUDE_STATE).at(-1) as any).sessionId);
      expect(resumed.setup.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: "Updated Forge posture" });
      await resumed.runtime.stopInFlight();
    } finally { f.allowClose(true); await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("can settle replacement after the output guard is revoked during shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-revoked-"));
    let revoked = false;
    const binding = { guardValue<T>(value: T): T { if (revoked) throw new Error("private guard detail"); return value; } } as SecureRuntimeBinding;
    const f = await fixture(root, { binding });
    try {
      await f.runtime.sendMessage("work"); await f.input.next();
      revoked = true;
      await expect(f.runtime.shutdownForReplacement()).rejects.toThrow("Secure Session output could not be safely processed");
      await expect(f.runtime.shutdownForReplacement()).resolves.toBeUndefined();
      expect(f.native.close).toHaveBeenCalledOnce();
      expect(f.runtime.getPendingCount()).toBe(0);
      expect(JSON.stringify(f.events)).not.toContain("private guard detail");
      await expect(f.runtime.sendMessage("unsafe continuation")).rejects.toThrow("stopped or unavailable");
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("uses native context capacity rather than a larger catalog allowance", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-context-")); const f = await fixture(root);
    try {
      const first = await f.runtime.sendMessage("work"); await f.input.next();
      await f.emit({ type: "stream_event", event: { type: "message_start", message: {
        usage: { input_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 100 },
      } } });
      await f.emit(result([first.deliveryId], { modelUsage: { "claude-opus-5-5": { contextWindow: 200_000 } } }));
      expect(f.runtime.getContextUsage()).toEqual({ tokens: 500, contextWindow: 200_000, percent: 0.25 });
    } finally { await f.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps an idle unstarted allocation resumable without requiring nonexistent native history", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-claude-empty-"));
    const f = await fixture(root); await f.runtime.stopInFlight();
    const second = await fixture(root);
    try { expect(second.setup.resume).toBeUndefined(); expect(await readFile(join(root, "session.jsonl"), "utf8")).toContain(NATIVE_CLAUDE_STATE); }
    finally { await second.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
  });

  it("keeps the retired Claude SDK migration separate from the native runtime", () => {
    expect(inferModelChangeContinuityRuntimeKind({ provider: "claude-native" })).toBe("claude");
    expect(inferModelChangeContinuityRuntimeKind({ provider: "claude-sdk" })).toBe("pi");
  });
});

it("projects progress before a tool and a final answer once, even with partial streams", () => {
  const mapper = new ClaudeRuntimeEvents(); const events: RuntimeSessionEvent[] = [];
  const map = (frame: unknown) => events.push(...mapper.map(frame as SDKMessage));
  map({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "" } } });
  map({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Found the issue." } } });
  map({ type: "assistant", message: { content: [{ type: "text", text: "Found the issue." }] } });
  map({ type: "assistant", message: { content: [{ type: "tool_use", id: "tool", name: "Read", input: {} }] } });
  expect(events.find(e => e.type === "message_end")).toMatchObject({ message: { stopReason: "toolUse" } });
  map({ type: "assistant", message: { content: [{ type: "text", text: "Fixed and tested." }] } });
  events.push(...mapper.finish(true, "Fixed and tested."));
  expect(events.filter(e => e.type === "message_end")).toHaveLength(2);
  expect(events.filter(e => e.type === "message_end").at(-1)).toMatchObject({ message: { stopReason: "stop" } });
});

it("persists per-model native totals across turns and resume without summing result snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-claude-usage-"));
  const f = await fixture(root);
  let resumed: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const modelUsage = { "claude-fable-5-1": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 2, costUSD: 0.01 } };
    const first = await f.runtime.sendMessage("work"); await f.input.next();
    await f.emit(result([first.deliveryId], { modelUsage }));
    const second = await f.runtime.sendMessage("again"); await f.input.next();
    await f.emit(result([second.deliveryId], { modelUsage }));
    expect(f.runtime.getCustomEntries("swarm_native_usage")).toHaveLength(1);
    expect(f.runtime.getCustomEntries("swarm_native_usage")[0]).toMatchObject({ modelId: "claude-fable-5-1", usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, total: 37 } });
    await f.runtime.stopInFlight();
    resumed = await fixture(root);
    const third = await resumed.runtime.sendMessage("continue"); await resumed.input.next();
    await resumed.emit(result([third.deliveryId], { modelUsage: { "claude-fable-5-1": { ...modelUsage["claude-fable-5-1"], outputTokens: 8 } } }));
    expect(resumed.runtime.getCustomEntries("swarm_native_usage")).toHaveLength(2);
    expect(resumed.runtime.getCustomEntries("swarm_native_usage").at(-1)).toMatchObject({ usage: { total: 40 } });
  } finally { await f.runtime.stopInFlight(); await resumed?.runtime.stopInFlight(); await rm(root, { recursive: true, force: true }); }
});
