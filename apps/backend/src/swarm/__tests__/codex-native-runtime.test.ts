import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { CodexAgentRuntime, NATIVE_CODEX_STATE } from "../runtime/codex/codex-agent-runtime.js";
import { nativeCodexEnvironment } from "../runtime/codex/codex-runtime-auth.js";
import { ManagerAssistantOutputTracker } from "../runtime/manager-assistant-output-tracker.js";
import { extractCleanManagerAssistantFinalMessage } from "../runtime/manager-assistant-final-message.js";
import { ConversationProjector } from "../conversation-projector.js";
import type { CodexAppServerClientHandlers } from "../codex-app-server/types.js";
import type { AgentDescriptor, ConversationMessageEvent } from "../types.js";
import type { RuntimeSessionEvent } from "../runtime-contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { root?: string; agentId?: string; rejectResume?: boolean; prompt?: string;
  onEvent?: (event: RuntimeSessionEvent) => void } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "forge-native-codex-test-"));
  if (!options.root) roots.push(root);
  const agentId = options.agentId ?? "native-test";
  const codexHome = join(root, "codex-home");
  const nativePath = join(codexHome, `${agentId}.jsonl`);
  await mkdir(codexHome, { recursive: true });
  const descriptor = { agentId, role: "manager", managerId: agentId, profileId: "test", cwd: root,
    status: "idle", sessionFile: join(root, `${agentId}.jsonl`), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    model: { provider: "codex-native", modelId: "gpt-6-astra", thinkingLevel: "high" },
  } as AgentDescriptor;
  let handlers!: CodexAppServerClientHandlers;
  let disposed = false;
  let interruptCompletes = true;
  const events: RuntimeSessionEvent[] = [];
  const auth = { login: vi.fn(async () => {}), refresh: vi.fn(), release: vi.fn(async () => {}) };
  const requestUserChoice = vi.fn(async () => [{ questionId: "approval", selectedOptionIds: ["decline"] }]);
  const client = {
    connect: vi.fn(async () => {}), notify: vi.fn(), dispose: vi.fn(() => { disposed = true; }), isDisposed: () => disposed,
    shutdown: vi.fn(async () => { disposed = true; }),
    request: vi.fn(async (method: string, params: any) => {
      if (method === "thread/resume" && options.rejectResume) throw new Error("Missing native thread");
      const threadId = agentId === "child" ? "forked" : "native-thread";
      if (method === "thread/start") await writeFile(nativePath, `${JSON.stringify({ type: "session_meta", payload: {
        id: threadId, dynamic_tools: params.dynamicTools,
      } })}\n`);
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) return { thread: { id: threadId, path: nativePath } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      if (method === "turn/steer") return { turnId: params.expectedTurnId };
      if (method === "turn/interrupt" && interruptCompletes) await handlers.onNotification?.("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "interrupted" } });
      return {};
    }),
  };
  const runtime = await CodexAgentRuntime.create({ descriptor, callbacks: { onStatusChange: vi.fn(),
    onSessionEvent: async (_id, event) => { events.push(event); options.onEvent?.(event); }, onRuntimeError: vi.fn(), onAgentEnd: vi.fn() },
    systemPrompt: options.prompt ?? "Forge integration only", codexHome, projectTrusted: false, auth,
    host: { requestUserChoice }, tools: [{ name: "fixture_tool", label: "Fixture", description: "Fixture tool",
      parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), execute: async (_id, args) => ({ content: [{ type: "text", text: args.value }], details: args }) }],
    createClient: h => { handlers = h; return client as never; },
  });
  return { root, nativePath, descriptor, runtime, client, auth, events, requestUserChoice,
    interruptCompletes: (value: boolean) => { interruptCompletes = value; },
    notify: (method: string, params: any) => handlers.onNotification?.(method, params),
    serverRequest: (method: string, params: any) => handlers.onRequest!(method, params),
  };
}

describe("Native Codex manager", () => {
  it("releases the native writer on stop before resuming the same thread", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Original work");
    await f.runtime.stopInFlight();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
    expect(f.client.isDisposed()).toBe(true);
    expect(f.auth.release).toHaveBeenCalledOnce();
    await expect(f.runtime.sendMessage("Cannot reuse detached runtime")).rejects.toThrow("stopped or unavailable");
    const resumed = await fixture({ root: f.root });
    expect(resumed.client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "native-thread" }));
    await resumed.runtime.sendMessage("Continue work");
    expect(resumed.client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "native-thread" }));
    await resumed.runtime.terminate();
    await f.runtime.terminate();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
  });

  it("keeps stop blocked when process exit is unconfirmed and permits cleanup retry", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    f.client.shutdown.mockRejectedValueOnce(new Error("Exit unconfirmed"));
    await expect(f.runtime.stopInFlight()).rejects.toThrow("Exit unconfirmed");
    expect(f.auth.release).not.toHaveBeenCalled();
    await expect(f.runtime.sendMessage("Unsafe replacement")).rejects.toThrow("stopped or unavailable");
    await f.runtime.shutdownForReplacement();
    expect(f.client.shutdown).toHaveBeenCalledTimes(2);
    expect(f.auth.release).toHaveBeenCalledOnce();
  });

  it("releases an idle native writer when stopped", async () => {
    const f = await fixture();
    await f.runtime.stopInFlight();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
    expect(f.auth.release).toHaveBeenCalledOnce();
    await f.runtime.stopInFlight();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
  });

  it("publishes separate native commentary live and replays it once after restart", async () => {
    let consume: (event: RuntimeSessionEvent) => void = () => {};
    const f = await fixture({ onEvent: event => consume(event) });
    const agentId = f.descriptor.agentId;
    const live: ConversationMessageEvent[] = [];
    const makeProjector = (running: boolean) => new ConversationProjector({
      descriptors: new Map([[agentId, f.descriptor]]),
      runtimes: running ? new Map([[agentId, f.runtime]]) : new Map(),
      conversationEntriesByAgentId: new Map(), now: () => new Date().toISOString(),
      emitServerEvent: (_name, event) => { if (event.type === "conversation_message") live.push(event); },
      logDebug: () => {},
    });
    const projector = makeProjector(true);
    const tracker = new ManagerAssistantOutputTracker({ now: () => new Date().toISOString(),
      emitConversationMessage: event => projector.emitConversationMessage(event), markSessionActivity: () => {} });
    consume = event => {
      if (event.type === "message_start" && event.message.role === "user") {
        tracker.activateTurn(agentId, { kind: "session_transcript", channel: "web" });
      }
      tracker.handleRuntimeEvent(agentId, event);
    };
    await f.runtime.sendMessage("Inspect and validate the fixture");
    const base = { threadId: "native-thread", turnId: "turn-1" };
    for (const [id, text] of [["inspect", "I found the scheduling boundary."], ["validate", "The focused checks pass; I'm checking the final diff."]]) {
      await f.notify("item/started", { ...base, item: { type: "agentMessage", id, phase: "commentary", text: "" } });
      await f.notify("item/agentMessage/delta", { ...base, itemId: id, delta: text });
      const message = { ...base, item: { type: "agentMessage", id, phase: "commentary", text } };
      await f.notify("item/completed", message);
      await f.notify("item/completed", message);
      await f.notify("item/started", { ...base, item: { type: "commandExecution", id: `${id}-cmd`, command: "true", status: "inProgress" } });
      expect(live.at(-1)).toMatchObject({ text, source: "assistant_progress" });
      await f.notify("item/completed", { ...base, item: { type: "commandExecution", id: `${id}-cmd`, status: "completed", exitCode: 0 } });
    }
    await f.notify("item/completed", { ...base, item: { type: "agentMessage", id: "final", phase: "final_answer", text: "Verified." } });
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "completed" } });
    expect(live).toHaveLength(2);
    expect(f.events.map(extractCleanManagerAssistantFinalMessage).filter(Boolean)).toEqual([{ text: "Verified." }]);
    await projector.flushPendingHistoryCacheWrites();
    await f.runtime.terminate();

    const reloaded = makeProjector(false);
    expect(reloaded.getConversationHistory(agentId).filter(event => event.type === "conversation_message" && event.source === "assistant_progress")).toEqual(live);
    await reloaded.flushPendingHistoryCacheWrites();
  });

  it("resumes legacy Pi-contaminated schemas without replacing history and strips only their budget metadata", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();
    const header = JSON.parse(await readFile(f.nativePath, "utf8"));
    const tool = header.payload.dynamic_tools[0].tools[0];
    delete tool.deferLoading;
    tool.inputSchema.properties.max_output_tokens = { type: "integer", minimum: 256,
      description: "Output token budget. Defaults to 10000 estimated tokens; larger requests may be capped by runtime policy." };
    await writeFile(f.nativePath, `${JSON.stringify(header)}\n`);
    const resumed = await fixture({ root: f.root });
    expect(resumed.client.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await resumed.runtime.sendMessage("Continue");
    const result = await resumed.serverRequest("item/tool/call", { threadId: "native-thread", turnId: "turn-1",
      namespace: "forge", tool: "fixture_tool", callId: "legacy", arguments: { value: "accepted", max_output_tokens: 2000 } });
    expect(result).toMatchObject({ success: true, contentItems: [{ text: "accepted" }] });
    expect(resumed.events.find(event => event.type === "tool_execution_end")).toMatchObject({ result: { details: { value: "accepted" } } });
    await expect(resumed.serverRequest("item/tool/call", { threadId: "native-thread", turnId: "turn-1",
      namespace: "forge", tool: "fixture_tool", callId: "invalid", arguments: { value: "x", unexpected: true } })).rejects.toThrow("Invalid Forge tool arguments");
    await resumed.runtime.terminate();
  });

  it("still rejects an incompatible persisted tool schema without starting a replacement thread", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();
    const header = JSON.parse(await readFile(f.nativePath, "utf8"));
    header.payload.dynamic_tools[0].tools[0].inputSchema.properties.value.type = "number";
    await writeFile(f.nativePath, `${JSON.stringify(header)}\n`);
    await expect(fixture({ root: f.root })).rejects.toThrow("incompatible Forge tool configuration");
  });

  it("uses full access without command approvals for new and resumed threads", async () => {
    const f = await fixture();
    expect(f.client.request).toHaveBeenCalledWith("thread/start", expect.objectContaining({
      approvalPolicy: "never", sandbox: "danger-full-access",
    }));
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();

    const resumed = await fixture({ root: f.root });
    expect(resumed.client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({
      threadId: "native-thread", approvalPolicy: "never", sandbox: "danger-full-access",
    }));
    await resumed.runtime.sendMessage("Continue with full access");
    expect(resumed.requestUserChoice).not.toHaveBeenCalled();
    await resumed.runtime.terminate();
  });

  it("does not block cleanup when auth fails before a turn was submitted", async () => {
    const f = await fixture();
    f.auth.login.mockRejectedValueOnce(new Error("Account needs reconnecting"));
    await expect(f.runtime.sendMessage("Work")).rejects.toThrow("Account needs reconnecting");
    expect(f.client.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
    await f.runtime.terminate();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
  });
  it("preserves an acknowledged but unconsumed steer as history when stopped", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Start work");
    await f.runtime.sendMessage("Keep this new constraint");
    await f.runtime.stopInFlight();
    const injected = f.client.request.mock.calls.find(([method]) => method === "thread/inject_items")![1];
    expect(injected.items[0].content[0].text).toContain("Keep this new constraint");
    expect(injected.items[0].content[0].text).toContain("do not restart cancelled work");
    expect(f.client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    await f.runtime.terminate();
  });

  it("does not inject a steer a second time after Codex consumes it", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Start work");
    await f.runtime.sendMessage("Consumed constraint");
    const consumedInputs = () => f.events.filter(event => event.type === "message_start" && event.message.role === "user")
      .map(event => event.type === "message_start" ? event.message.content : undefined);
    expect(consumedInputs()).toEqual(["Start work"]);
    const steer = f.client.request.mock.calls.find(([method]) => method === "turn/steer")![1];
    const input = { threadId: "native-thread", turnId: "turn-1", item: { type: "userMessage", id: "input", clientId: steer.clientUserMessageId } };
    await f.notify("item/started", input);
    await f.notify("item/completed", input);
    expect(consumedInputs()).toEqual(["Start work", "Consumed constraint"]);
    await f.runtime.stopInFlight();
    expect(f.client.request.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(false);
    await f.runtime.terminate();
  });
  it("leaves an acknowledged provider failure retryable without replacing the native thread", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "failed", error: { message: "Provider unavailable" } } });
    expect(f.runtime.getStatus()).toBe("idle");
    expect((await f.runtime.sendMessage("Retry now")).acceptedMode).toBe("prompt");
    expect(f.client.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    await f.runtime.terminate();
  });

  it("queues a follow-up until the previous native turn has completed", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("First");
    expect((await f.runtime.sendMessage("Second", "followUp")).acceptedMode).toBe("followUp");
    expect(f.runtime.getPendingCount()).toBe(1);
    expect(f.client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "completed" } });
    await vi.waitFor(() => expect(f.client.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(2));
    await f.runtime.terminate();
  });

  it("requires a complete file diff before asking the user for permission", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    const base = { threadId: "native-thread", turnId: "turn-1", itemId: "patch" };
    await expect(f.serverRequest("item/fileChange/requestApproval", base)).rejects.toThrow("complete proposed changes");
    expect(f.requestUserChoice).not.toHaveBeenCalled();
    await f.notify("item/started", { ...base, item: { id: "patch", type: "fileChange", changes: [{ path: "/outside/a", diff: "+reviewable content", kind: { type: "add" } }] } });
    expect(await f.serverRequest("item/fileChange/requestApproval", base)).toEqual({ decision: "decline" });
    expect(f.requestUserChoice.mock.calls[0]).toEqual(["native-test", [expect.objectContaining({ question: expect.stringContaining("+reviewable content") })]]);
    await f.runtime.terminate();
  });
  it("updates changed developer instructions on resume without replacing native history", async () => {
    const f = await fixture({ prompt: "Delegation first" });
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();
    const resumed = await fixture({ root: f.root, prompt: "Hands-on: execute directly" });
    const injected = resumed.client.request.mock.calls.find(([method]) => method === "thread/inject_items")![1];
    expect(injected.items[0]).toMatchObject({ role: "developer" });
    expect(injected.items[0].content[0].text).toContain("Hands-on: execute directly");
    expect(resumed.client.request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await resumed.runtime.terminate();
    const unchanged = await fixture({ root: f.root, prompt: "Hands-on: execute directly" });
    expect(unchanged.client.request.mock.calls.some(([method]) => method === "thread/inject_items")).toBe(false);
    await unchanged.runtime.terminate();
  });

  it("waits for native compaction completion before reporting success", async () => {
    const f = await fixture();
    let completed = false;
    const compacting = f.runtime.smartCompact().then(result => { completed = true; return result; });
    await vi.waitFor(() => expect(f.client.request).toHaveBeenCalledWith("thread/compact/start", { threadId: "native-thread" }));
    expect(completed).toBe(false);
    await f.notify("turn/started", { threadId: "native-thread", turn: { id: "compact-1" } });
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "compact-1", status: "completed" } });
    expect(await compacting).toEqual({ compacted: true });
    await f.runtime.terminate();
  });

  it("keeps native instructions, selects exact model/effort, and steers the active turn", async () => {
    const f = await fixture();
    const started = f.client.request.mock.calls.find(([method]) => method === "thread/start")![1];
    expect(started).not.toHaveProperty("baseInstructions");
    expect(started.developerInstructions).toBe("Forge integration only");
    expect(started.dynamicTools[0]).toMatchObject({ type: "namespace", name: "forge" });
    expect((await f.runtime.sendMessage("Implement the fix")).acceptedMode).toBe("prompt");
    expect(f.client.request).toHaveBeenCalledWith("turn/start", expect.objectContaining({ model: "gpt-6-astra", effort: "high" }));
    expect((await f.runtime.sendMessage("Keep the original API")).acceptedMode).toBe("steer");
    expect(f.client.request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({ expectedTurnId: "turn-1" }));
    await f.runtime.terminate();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
  });

  it("persists identity immediately, resumes it, and reconstructs bounded copied sessions independently", async () => {
    const f = await fixture();
    f.runtime.appendCustomEntry("swarm_conversation_entry", { type: "conversation_message", agentId: "native-test", role: "user", text: "Selected fork boundary", source: "user_input", timestamp: new Date().toISOString() });
    await f.runtime.sendMessage("Create a persisted native turn");
    await f.runtime.terminate();
    const resumed = await fixture({ root: f.root });
    expect(resumed.client.request).toHaveBeenCalledWith("thread/resume", expect.objectContaining({ threadId: "native-thread" }));
    await resumed.runtime.terminate();
    await cp(f.descriptor.sessionFile, join(f.root, "child.jsonl"));
    const fork = await fixture({ root: f.root, agentId: "child" });
    expect(fork.client.request).toHaveBeenCalledWith("thread/start", expect.not.objectContaining({ threadId: "native-thread" }));
    expect(fork.client.request.mock.calls.some(([method]) => method === "thread/fork")).toBe(false);
    expect(fork.client.request.mock.calls.find(([method]) => method === "thread/inject_items")?.[1].items[0].content[0].text).toContain("Selected fork boundary");
    expect(fork.runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1)).toMatchObject({ threadId: "forked", ownerAgentId: "child" });
    await fork.runtime.terminate();
    await expect(fixture({ root: f.root, rejectResume: true })).rejects.toThrow("Missing native thread");
  });

  it("keeps ownership until interruption settles and permits a scoped cleanup retry", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Long task");
    f.interruptCompletes(false);
    await expect(f.runtime.shutdownForReplacement({ shutdownTimeoutMs: 10 })).rejects.toThrow("replacement remains blocked");
    expect(f.client.shutdown).not.toHaveBeenCalled();
    await expect(f.runtime.sendMessage("Another task")).rejects.toThrow("stopped or unavailable");
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "interrupted" } });
    await f.runtime.shutdownForReplacement();
    expect(f.client.shutdown).toHaveBeenCalledOnce();
  });

  it("projects native text and commands once and rejects foreign-thread tool requests", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    const base = { threadId: "native-thread", turnId: "turn-1" };
    await expect(f.serverRequest("item/tool/call", { ...base, threadId: "foreign", namespace: "forge", tool: "fixture_tool", callId: "tool", arguments: { value: "ok" } })).rejects.toThrow("not owned");
    expect(await f.serverRequest("item/tool/call", { ...base, namespace: "forge", tool: "fixture_tool", callId: "tool", arguments: { value: "ok" } })).toMatchObject({ success: true });
    await f.notify("item/started", { ...base, item: { type: "commandExecution", id: "cmd", command: "test", status: "inProgress" } });
    await f.notify("item/completed", { ...base, item: { type: "commandExecution", id: "cmd", command: "test", status: "completed", exitCode: 0 } });
    const final = { ...base, item: { type: "agentMessage", id: "answer", phase: "final_answer", text: "Verified" } };
    await f.notify("item/completed", final);
    await f.notify("item/completed", final);
    await f.notify("turn/completed", { threadId: "native-thread", turn: { id: "turn-1", status: "completed" } });
    expect(f.events.filter(e => e.type === "message_end")).toHaveLength(1);
    expect(f.events.filter(e => e.type === "tool_execution_end")).toHaveLength(2);
    const persisted = (await readFile(f.descriptor.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const assistant = persisted.find(entry => entry.type === "message" && entry.message.role === "assistant");
    expect(assistant.message).toMatchObject({ stopReason: "stop", usage: { totalTokens: 0, cost: { total: 0 } } });
    await f.runtime.terminate();
  });

  it("routes approvals through Forge choices and refuses secret questions", async () => {
    const f = await fixture();
    await f.runtime.sendMessage("Work");
    const params = { threadId: "native-thread", turnId: "turn-1", command: "touch /outside/file" };
    expect(await f.serverRequest("item/commandExecution/requestApproval", params)).toEqual({ decision: "decline" });
    expect(f.requestUserChoice).toHaveBeenCalled();
    await expect(f.serverRequest("item/commandExecution/requestApproval", { ...params, command: "x".repeat(13000) })).rejects.toThrow("too large to review");
    await expect(f.serverRequest("item/tool/requestUserInput", { ...params, questions: [{ id: "secret", isSecret: true }] })).rejects.toThrow("cannot collect secrets");
    await f.runtime.terminate();
  });

  it("does not pass provider keys, vault secrets, or ambient Codex home to the subprocess", () => {
    expect(nativeCodexEnvironment("/isolated", { PATH: "/bin", HOME: "/home/user", OPENAI_API_KEY: "private",
      FORGE_SECRET: "private", CODEX_HOME: "/desktop", AWS_SECRET_ACCESS_KEY: "private" }))
      .toEqual({ PATH: "/bin", HOME: "/home/user", CODEX_HOME: "/isolated" });
  });
});


it("recreates only an unused native allocation after a settings recycle", async () => {
  const f = await fixture();
  expect(f.runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1)).toMatchObject({ hasStartedTurn: false });
  await f.runtime.terminate();
  const fresh = await fixture({ root: f.root, rejectResume: true, prompt: "New work mode" });
  expect(fresh.client.request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
  expect(fresh.client.request.mock.calls.some(([method]) => method === "thread/start")).toBe(true);
  await fresh.runtime.sendMessage("First actual message");
  expect(fresh.runtime.getCustomEntries(NATIVE_CODEX_STATE).at(-1)).toMatchObject({ hasStartedTurn: true });
  await fresh.runtime.terminate();
  await expect(fixture({ root: f.root, rejectResume: true })).rejects.toThrow("Missing native thread");
});
