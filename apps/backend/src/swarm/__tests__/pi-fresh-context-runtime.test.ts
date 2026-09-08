import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { TaskNotesStore, ActorTaskNotes } from "../task-notes-store.js";
import { createTaskNotesTool } from "../task-notes-tool.js";
import { createContextManagementTools } from "../runtime/context-management-tools.js";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentRuntime } from "../agent-runtime.js";
import {
  createFreshContextHandler,
  FRESH_CONTEXT_BUSY_ERROR,
} from "../runtime/fresh-context-checkpoint.js";
import { createStaticCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { HistorySearchService } from "../history-recall/history-search-service.js";
import { getSessionFilePath } from "../storage/data-paths.js";
import { buildProjectSafePiProjectSettingsStorage } from "../project-executable-trust.js";
import type { AgentDescriptor } from "../types.js";
import {
  expectInstalledPiCodingAgentPatchIdentity,
  findInstalledPiCodingAgentFile,
} from "./pi-coding-agent-patch-identity.js";

const tempDirs: string[] = [];
const fauxRegistrations: Array<{ unregister: () => void }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFreshSession(options?: { persist?: boolean; sessionFile?: string; customTools?: ToolDefinition[] }) {
  const root = await mkdtemp(join(tmpdir(), "forge-pi-fresh-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const sessionFile = options?.sessionFile ?? join(root, "session.jsonl");
  await mkdir(dirname(sessionFile), { recursive: true });
  const faux = registerFauxProvider({
    api: "forge-fresh-api",
    provider: "forge-fresh",
    models: [{ id: "fresh-model", name: "Fresh", contextWindow: 32_000, maxTokens: 1024 }],
  });
  fauxRegistrations.push(faux);
  faux.setResponses([fauxAssistantMessage("fresh-ok")]);
  const storage = buildProjectSafePiProjectSettingsStorage({
    agentDir,
    projectExecutablesTrusted: false,
  });
  const settingsManager = SettingsManager.fromStorage(storage, { projectTrusted: false });
  settingsManager.applyOverrides({ compaction: { enabled: true } } as never);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const authStorage = AuthStorage.inMemory({});
  authStorage.setRuntimeApiKey("forge-fresh", "faux-test-key");
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    authStorage,
    modelRegistry: ModelRegistry.inMemory(authStorage),
    model: faux.getModel(),
    sessionManager: SessionManager.open(sessionFile, undefined, root),
    resourceLoader,
    settingsManager,
    noTools: "all",
    customTools: options?.customTools,
    tools: options?.customTools?.map(tool => tool.name),
  });
  return { root, sessionFile, session, faux };
}

function makeDescriptor(root: string): AgentDescriptor {
  return {
    agentId: "session-1",
    displayName: "Fresh Manager",
    role: "manager",
    managerId: "session-1",
    profileId: "profile-1",
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: root,
    model: { provider: "openai-codex", modelId: "gpt-5.5", thinkingLevel: "medium" },
    sessionFile: join(root, "session.jsonl"),
  };
}

describe("pi fresh-window native runtime", () => {
  it("keeps the installed fresh-handler and persistence patch identity", () => {
    const agentSessionPath = findInstalledPiCodingAgentFile(import.meta.url, "dist/core/agent-session.js");
    const source = readFileSync(agentSessionPath, "utf8");
    expectInstalledPiCodingAgentPatchIdentity(import.meta.url, source);
    const sessionManager = readFileSync(join(agentSessionPath, "..", "session-manager.js"), "utf8");
    expect(sessionManager).toContain("isFreshCheckpoint");
  });

  it("commits a durable first-user fresh boundary, retains the old branch, and reopens without prior messages", async () => {
    const { session, sessionFile, root } = await createFreshSession();
    session.sessionManager.appendMessage({
      role: "user",
      content: "Oversized first input that must remain on the old branch",
      timestamp: Date.now(),
    } as never);
    const dataDir = join(root, "data");
    const descriptor = makeDescriptor(root);
    descriptor.sessionFile = sessionFile;
    const handler = createFreshContextHandler({
      dataDir,
      descriptor,
      getContextMode: () => "fresh",
    });
    const events: Array<{ type: string; aborted?: boolean; reason?: string }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") {
        events.push({ type: event.type, aborted: "aborted" in event ? event.aborted : undefined, reason: "reason" in event ? event.reason : undefined });
      }
    });
    session.setFreshContextHandler(handler);
    const result = await session.compact();
    expect(result.details).toMatchObject({ forgeContext: { mode: "fresh" } });
    expect(events).toEqual([
      { type: "compaction_start", aborted: undefined, reason: "manual" },
      { type: "compaction_end", aborted: false, reason: "manual" },
    ]);
    const disk = await readFile(sessionFile, "utf8");
    expect(disk).toContain("Oversized first input that must remain on the old branch");
    expect(disk).toContain("forge_context_boundary");
    expect(disk).toContain("\"mode\":\"fresh\"");
    const active = JSON.stringify(session.sessionManager.buildSessionContext().messages);
    expect(session.sessionManager.buildSessionContext().messages.some(message => message.role === "user")).toBe(false);
    expect(active).toContain("Fresh window checkpoint");
    const branch = session.sessionManager.getBranch();
    expect(branch.some((entry) => entry.type === "message")).toBe(true);
    const reopened = SessionManager.open(sessionFile, undefined, root);
    const reopenedActive = JSON.stringify(reopened.buildSessionContext().messages);
    expect(reopened.buildSessionContext().messages.some(message => message.role === "user")).toBe(false);
    expect(reopenedActive).toContain("Fresh window checkpoint");
    expect(reopened.getBranch().some((entry) => entry.type === "compaction")).toBe(true);
    unsubscribe();
    session.dispose();
  });

  it("captures compaction IDs for identical checkpoints and fails closed without summarizer auth", async () => {
    const { session } = await createFreshSession();
    session.sessionManager.appendMessage({ role: "user", content: "alpha", timestamp: Date.now() } as never);
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
      timestamp: Date.now(),
    } as never);
    const ids: string[] = [];
    session.setFreshContextHandler(async () => ({
      summary: "identical checkpoint",
      tokensBefore: 10,
      details: { forgeContext: { mode: "fresh", trigger: "manual", willRetry: false } },
    }));
    const first = await session.compact();
    const firstId = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1)?.id;
    expect(firstId).toBeTruthy();
    ids.push(firstId!);
    session.sessionManager.appendMessage({ role: "user", content: "beta", timestamp: Date.now() } as never);
    const second = await session.compact();
    const secondId = session.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1)?.id;
    expect(second.summary).toBe(first.summary);
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
    ids.push(secondId!);
    expect(new Set(ids).size).toBe(2);

    session.setFreshContextHandler(async () => {
      throw new Error("fresh handler exploded");
    });
    session.sessionManager.appendMessage({ role: "user", content: "gamma", timestamp: Date.now() } as never);
    await expect(session.compact()).rejects.toThrow("fresh handler exploded");
    session.dispose();
  });

  it("does not commit after abort during an awaited fresh handler", async () => {
    const { session } = await createFreshSession();
    session.sessionManager.appendMessage({ role: "user", content: "keep me", timestamp: Date.now() } as never);
    let resolveHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    session.setFreshContextHandler(async (request) => {
      await gate;
      if (request.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return {
        summary: "should not commit",
        tokensBefore: 1,
        details: { forgeContext: { mode: "fresh", trigger: "manual", willRetry: false } },
      };
    });
    const compactPromise = session.compact();
    await Promise.resolve();
    session.abortCompaction();
    resolveHandler?.();
    await expect(compactPromise).rejects.toThrow();
    const messages = JSON.stringify(session.sessionManager.buildSessionContext().messages);
    expect(messages).toContain("keep me");
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    session.dispose();
  });

  it("follows live accepted settings: summary stays unchanged, then fresh commits a checkpoint", async () => {
    const { session } = await createFreshSession();
    session.sessionManager.appendMessage({ role: "user", content: "keep prior", timestamp: Date.now() } as never);
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
      timestamp: Date.now(),
    } as never);
    let mode: "summary" | "fresh" = "summary";
    session.setFreshContextHandler(async (request) => {
      if (mode !== "fresh") {
        return undefined;
      }
      return {
        summary: "fresh after switch",
        tokensBefore: request.tokensBefore ?? 0,
        details: { forgeContext: { mode: "fresh", trigger: "manual", willRetry: false } },
      };
    });
    const authStorage = (session as unknown as { modelRegistry: { authStorage: { removeRuntimeApiKey: (provider: string) => void } } }).modelRegistry.authStorage;
    authStorage.removeRuntimeApiKey("forge-fresh");
    await expect(session.compact()).rejects.toThrow();
    expect(session.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
    mode = "fresh";
    const result = await session.compact();
    expect(result.summary).toBe("fresh after switch");
    expect(result.details).toMatchObject({ forgeContext: { mode: "fresh" } });
    session.dispose();
  });

  it("recovers trailing tool evidence through a generated history.read recipe after native overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-pi-fresh-"));
    tempDirs.push(root);
    const dataDir = join(root, "data");
    const descriptor = makeDescriptor(root);
    descriptor.profileId = "profile-1";
    const canonical = getSessionFilePath(dataDir, descriptor.profileId, descriptor.agentId);
    const { session, sessionFile, faux } = await createFreshSession({ sessionFile: canonical });
    descriptor.sessionFile = sessionFile;
    session.sessionManager.appendMessage({ role: "user", content: "inspect the violet sentinel payload", timestamp: Date.now() } as never);
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-sentinel", name: "bash", arguments: { command: "cat sentinel.txt" } }],
      timestamp: Date.now(),
    } as never);
    session.sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "call-sentinel",
      toolName: "bash",
      content: [{ type: "text", text: "violet sentinel payload remains recoverable" }],
      timestamp: Date.now(),
    } as never);
    session.setFreshContextHandler(createFreshContextHandler({
      dataDir,
      descriptor,
      getContextMode: () => "fresh",
      sessionFile,
    }));
    faux.setResponses([
      fauxAssistantMessage("overflowed", {
        stopReason: "error",
        errorMessage: "Your input exceeds the context window of this model",
      }),
      fauxAssistantMessage("continued after overflow"),
      fauxAssistantMessage("after late overflow input"),
    ]);
    const pending = session.followUp("late overflow input once");
    const prompt = session.prompt("trigger overflow");
    await pending;
    await prompt;
    await session.waitForIdle();
    const compactEntry = [...session.sessionManager.getBranch()].reverse().find((entry) => entry.type === "compaction");
    expect(compactEntry).toBeTruthy();
    const summary = (compactEntry as { summary?: string }).summary ?? "";
    expect(summary).toContain("Active overflow obligation");
    expect(summary).toContain('history({op:"read",ref:');
    const match = summary.slice(summary.indexOf("## Unconsumed tool evidence")).match(/history\(\{op:"read",ref:(\{.*?\})\}\)/);
    expect(match?.[1]).toBeTruthy();
    const ref = JSON.parse(match![1]);
    const service = new HistorySearchService({
      config: { paths: { dataDir } } as never,
      getAgent: (agentId) => agentId === descriptor.agentId ? descriptor : undefined,
      listAgents: () => [descriptor],
      listProfiles: () => [{
        profileId: descriptor.profileId!,
        displayName: "Profile",
        defaultSessionAgentId: descriptor.agentId,
        defaultModel: descriptor.model,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
      }],
      loadDatabaseModule: async () => { throw new Error("index unavailable"); },
    });
    const read = await service.read(descriptor.agentId, { ref });
    expect(read.entry.text).toContain("violet sentinel payload remains recoverable");
    expect(ref).toMatchObject({
      sessionAgentId: descriptor.agentId,
      actorAgentId: descriptor.agentId,
      sourceVersion: expect.any(String),
      byteOffset: expect.any(Number),
    });
    const completedMessages = session.sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message);
    expect(completedMessages.filter((message) => message.role === "assistant" && message.stopReason === "error").map((message) => (message as { errorMessage?: string }).errorMessage)).toEqual(["Your input exceeds the context window of this model"]);
    expect(JSON.stringify(completedMessages)).toContain("after late overflow input");
    const activeMessages = session.sessionManager.buildSessionContext().messages;
    expect(activeMessages.some((message) => message.role === "toolResult")).toBe(false);
    const active = JSON.stringify(activeMessages);
    expect(active).toContain("late overflow input once");
    expect(summary).toContain("result: violet sentinel payload remains recoverable");
    session.dispose();
    await service.dispose?.();
  });
});

describe("pi fresh-window AgentRuntime policy", () => {
  it("rejects busy manual Compact/Smart Compact before abort and leaves the session idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-fresh-runtime-"));
    tempDirs.push(root);
    const session = {
      isStreaming: true,
      isCompacting: false,
      abortCalls: 0,
      compactCalls: 0,
      handler: undefined as unknown,
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      state: { messages: [] },
      agent: { state: { messages: [] } },
      setFreshContextHandler(handler: unknown) {
        this.handler = handler;
      },
      async abort() {
        this.abortCalls += 1;
      },
      abortCompaction() {},
      async compact() {
        this.compactCalls += 1;
        return { ok: true };
      },
      subscribe() {
        return () => {};
      },
      getContextUsage() {
        return undefined;
      },
    };
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(root),
      session: session as never,
      getContextMode: () => "fresh",
      dataDir: join(root, "data"),
      callbacks: { onStatusChange: () => {} },
    });
    await expect(runtime.compact()).rejects.toThrow(FRESH_CONTEXT_BUSY_ERROR);
    await expect(runtime.smartCompact()).rejects.toThrow(FRESH_CONTEXT_BUSY_ERROR);
    expect(session.abortCalls).toBe(0);
    expect(session.compactCalls).toBe(0);
    expect(runtime.getStatus()).toBe("idle");
  });

  it("buffers late input during an idle fresh checkpoint and flushes it once after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-fresh-late-"));
    tempDirs.push(root);
    let resolveCompact: (() => void) | undefined;
    const compactGate = new Promise<void>((resolve) => {
      resolveCompact = resolve;
    });
    const session = {
      isStreaming: false,
      isCompacting: false,
      promptCalls: [] as string[],
      steerCalls: [] as string[],
      queuedSteers: [] as string[],
      sessionManager: { getEntries: () => [{ type: "compaction", id: "fresh-1" }], getBranch: () => [] },
      state: { messages: [] },
      agent: { state: { messages: [] } },
      setFreshContextHandler() {},
      async compact() {
        await compactGate;
        return { ok: true };
      },
      async prompt(message: string) {
        this.promptCalls.push(message);
      },
      async steer(message: string) {
        this.steerCalls.push(message);
        this.queuedSteers.push(message);
      },
      getSteeringMessages() {
        return this.queuedSteers;
      },
      clearQueue() {
        const steering = this.queuedSteers.splice(0);
        return { steering, followUp: [] as string[] };
      },
      subscribe() {
        return () => {};
      },
      getContextUsage() {
        return undefined;
      },
    };
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(root),
      session: session as never,
      getContextMode: () => "fresh",
      dataDir: join(root, "data"),
      callbacks: { onStatusChange: () => {} },
    });
    const compactPromise = runtime.compact();
    await Promise.resolve();
    const receipt = await runtime.sendMessage("late user input");
    expect(receipt.acceptedMode).toBe("steer");
    expect(session.promptCalls).toEqual([]);
    expect(session.steerCalls).toEqual([]);
    resolveCompact?.();
    await compactPromise;
    await Promise.resolve();
    await Promise.resolve();
    expect(session.promptCalls).toEqual(["late user input"]);
    expect(session.steerCalls).toEqual([]);
    expect(runtime.getPendingCount()).toBe(1);
  });

  it("arms auto recovery before the first async checkpoint read so late input buffers", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-fresh-admit-"));
    tempDirs.push(root);
    let resolveHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { resolveHandler = resolve; });
    const session = {
      isStreaming: false,
      isCompacting: false,
      promptCalls: [] as string[],
      steerCalls: [] as string[],
      queuedSteers: [] as string[],
      sessionManager: { getEntries: () => [], getBranch: () => [], getEntry: () => undefined },
      state: { messages: [] },
      agent: { state: { messages: [] } },
      model: { contextWindow: 32_000, maxTokens: 1024 },
      handler: undefined as ((request: { reason: string; willRetry: boolean; branchEntries: unknown[] }) => Promise<unknown>) | undefined,
      setFreshContextHandler(handler: (request: { reason: string; willRetry: boolean; branchEntries: unknown[] }) => Promise<unknown>) {
        this.handler = async (request) => {
          await gate;
          return handler(request);
        };
      },
      subscribe() { return () => {}; },
      getContextUsage() { return undefined; },
      async compact() { return { ok: true }; },
      async prompt(message: string) { this.promptCalls.push(message); },
      async steer(message: string) { this.steerCalls.push(message); this.queuedSteers.push(message); },
      getSteeringMessages() { return this.queuedSteers; },
      clearQueue() { return { steering: this.queuedSteers.splice(0), followUp: [] as string[] }; },
    };
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(root),
      session: session as never,
      getContextMode: () => "fresh",
      dataDir: join(root, "data"),
      compactionRuntimeSettingsProvider: createStaticCompactionRuntimeSettingsProvider({ timeoutMs: 50 }),
      callbacks: { onStatusChange: () => {} },
    });
    const pending = (runtime as unknown as { handleFreshContextRequest: (request: unknown) => Promise<unknown> }).handleFreshContextRequest({
      reason: "overflow",
      willRetry: true,
      branchEntries: [],
    });
    await Promise.resolve();
    expect((runtime as unknown as { autoCompactionRecoveryInProgress: boolean }).autoCompactionRecoveryInProgress).toBe(true);
    expect((runtime as unknown as { isContextRecoveryInProgress: () => boolean }).isContextRecoveryInProgress()).toBe(true);
    const receipt = await runtime.sendMessage("late during stalled handler");
    expect(receipt.acceptedMode).toBe("steer");
    resolveHandler?.();
    await expect(pending).rejects.toThrow("superseded by new input");
    expect(session.promptCalls).toEqual([]);
  });

  it("skips mid-turn abort guard and summary fallback while frozen in fresh mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-fresh-guard-"));
    tempDirs.push(root);
    const session = {
      isStreaming: true,
      isCompacting: false,
      abortCalls: 0,
      compactCalls: 0,
      sessionManager: { getEntries: () => [], getBranch: () => [], buildSessionContext: () => ({ messages: [] }) },
      state: { messages: [] },
      agent: { state: { messages: [] }, continue: async () => {} },
      setFreshContextHandler() {},
      async abort() {
        this.abortCalls += 1;
      },
      abortCompaction() {},
      async compact() {
        this.compactCalls += 1;
        return { ok: true };
      },
      subscribe() {
        return () => {};
      },
      getContextUsage() {
        return { tokens: 180_000, contextWindow: 200_000, percent: 90 };
      },
    };
    const runtimeErrors: Array<{ message: string; details?: Record<string, unknown> }> = [];
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(root),
      session: session as never,
      getContextMode: () => "fresh",
      dataDir: join(root, "data"),
      callbacks: {
        onStatusChange: () => {},
        onRuntimeError: (_agentId, error) => {
          runtimeErrors.push({ message: error.message, details: error.details as Record<string, unknown> });
        },
      },
    });
    (runtime as unknown as { frozenContextMode: string }).frozenContextMode = "fresh";
    (runtime as unknown as { checkContextBudget: () => void }).checkContextBudget();
    await Promise.resolve();
    expect(session.abortCalls).toBe(0);
    expect(session.compactCalls).toBe(0);

    (runtime as unknown as { latestAutoCompactionReason: string }).latestAutoCompactionReason = "threshold";
    (runtime as unknown as { autoCompactionRecoveryInProgress: boolean }).autoCompactionRecoveryInProgress = true;
    (runtime as unknown as { contextRecoveryInProgress: boolean }).contextRecoveryInProgress = true;
    await (runtime as unknown as {
      handleAutoCompactionEndEvent: (event: unknown) => Promise<void>;
    }).handleAutoCompactionEndEvent({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "fresh handler exploded",
    });
    expect(runtimeErrors.some((error) => error.message.includes("emergency trim"))).toBe(false);
    expect(session.compactCalls).toBe(0);
  });

  it("keeps owned frozen attempts across a concurrent busy reject and a later live-mode switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-fresh-owned-"));
    tempDirs.push(root);
    let resolveHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { resolveHandler = resolve; });
    let liveMode: "summary" | "fresh" = "summary";
    const session = {
      isStreaming: false,
      isCompacting: false,
      compactCalls: 0,
      handler: undefined as ((request: { reason: string }) => Promise<unknown>) | undefined,
      sessionManager: { getEntries: () => [], getBranch: () => [] },
      state: { messages: [] },
      agent: { state: { messages: [] } },
      model: { contextWindow: 32_000, maxTokens: 1024 },
      setFreshContextHandler(handler: (request: { reason: string }) => Promise<unknown>) {
        this.handler = handler;
      },
      async compact() {
        this.compactCalls += 1;
        this.isCompacting = true;
        await this.handler?.({ reason: "manual", willRetry: false, branchEntries: [] } as never);
        this.isCompacting = false;
        return { ok: true };
      },
      subscribe() { return () => {}; },
      getContextUsage() { return undefined; },
    };
    const runtime = new AgentRuntime({
      descriptor: makeDescriptor(root),
      session: session as never,
      getContextMode: () => liveMode,
      dataDir: join(root, "data"),
      callbacks: { onStatusChange: () => {} },
    });
    await runtime.compact();
    expect((runtime as unknown as { frozenContextMode?: string }).frozenContextMode).toBeUndefined();
    liveMode = "fresh";
    const originalHandler = session.handler;
    session.handler = async (request) => {
      await gate;
      return originalHandler?.(request);
    };
    const pending = runtime.compact();
    await Promise.resolve();
    session.isStreaming = true;
    await expect(runtime.compact()).rejects.toThrow(FRESH_CONTEXT_BUSY_ERROR);
    expect((runtime as unknown as { frozenContextMode?: string }).frozenContextMode).toBe("fresh");
    liveMode = "summary";
    resolveHandler?.();
    await pending;
    expect((runtime as unknown as { frozenContextMode?: string }).frozenContextMode).toBeUndefined();
  });


});


async function createControlledFreshSession(extraTools?: (getRuntime: () => AgentRuntime) => ToolDefinition[],
  getContextMode: () => "fresh" | "summary" = () => "fresh") {
  const root = await mkdtemp(join(tmpdir(), "forge-controlled-fresh-"));
  tempDirs.push(root);
  const dataDir = join(root, "data");
  const descriptor = makeDescriptor(root);
  descriptor.sessionFile = getSessionFilePath(dataDir, descriptor.profileId!, descriptor.agentId);
  const notes = new TaskNotesStore({ dataDir }).forActor({
    profileId: descriptor.profileId!, sessionAgentId: descriptor.agentId, actorAgentId: descriptor.agentId,
  });
  const getRuntime = () => runtime;
  const native = await createFreshSession({ sessionFile: descriptor.sessionFile, customTools: [
    createTaskNotesTool(notes), ...createContextManagementTools(getRuntime), ...(extraTools?.(getRuntime) ?? []),
  ] });
  const onRuntimeError = vi.fn();
  const runtime = new AgentRuntime({ descriptor, session: native.session, dataDir,
    getContextMode, callbacks: { onStatusChange: () => {}, onRuntimeError },
  });
  return { ...native, descriptor, dataDir, notes, runtime, onRuntimeError };
}

describe("agent-controlled native Fresh continuation", () => {
  it("persists every completed tool before the boundary, continues once, and reopens the new window", async () => {
    let effects = 0;
    let compactionsInsideTool = -1;
    const harness = await createControlledFreshSession(() => [{
      name: "record_effect", label: "Record effect", description: "Synthetic effect", parameters: Type.Object({}),
      async execute() {
        effects++;
        compactionsInsideTool = harness.session.sessionManager.getBranch().filter(entry => entry.type === "compaction").length;
        return { content: [{ type: "text", text: "effect completed once: violet-receipt" }], details: {} };
      },
    }]);
    const { session, faux, notes, runtime, sessionFile, root, onRuntimeError } = harness;
    vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 1000, contextWindow: 32_000, percent: 3.125 } as never);
    await notes.write({ path: "checkpoint.md", text: "Objective: finish synthetic task. Permission: local synthetic writes only. Next: verify violet-receipt and report." });
    let secondContext = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("new_context", {}, { id: "reset-1" }), fauxToolCall("record_effect", {}, { id: "effect-1" })], { stopReason: "toolUse" }),
      context => { secondContext = JSON.stringify(context.messages); return fauxAssistantMessage("Verified the completed effect; task done."); },
    ]);
    await session.prompt("Complete the synthetic task without repeating its effect.");
    await session.waitForIdle();
    expect(onRuntimeError.mock.calls.map(([, error]) => error.details?.userFacingMessage)).toEqual([
      "Fresh context requested — switching to a new window.",
      "Requested Fresh context transition completed.",
    ]);
    expect(effects).toBe(1);
    expect(faux.state.callCount).toBe(2);
    expect(compactionsInsideTool).toBe(0);
    expect(secondContext).toContain("Fresh window checkpoint");
    expect(secondContext).toContain("violet-receipt");
    expect(secondContext).not.toContain('"role":"toolResult"');
    const branch = session.sessionManager.getBranch();
    const boundaryIndex = branch.findIndex(entry => entry.type === "custom" && entry.customType === "forge_context_boundary");
    expect(boundaryIndex).toBeGreaterThan(0);
    expect(branch.slice(0, boundaryIndex).filter(entry => entry.type === "message" && entry.message.role === "toolResult")).toHaveLength(2);
    const compactions = branch.filter(entry => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].details).toMatchObject({ forgeContext: { trigger: "agent", willRetry: true, taskCheckpointRevision: 1 } });
    expect(runtime.getContextRemaining()).toMatchObject({ mode: "fresh", transitionPending: false });
    expect(runtime.getContextRemaining().windowId).toBe(`window:fresh:${compactions[0].id}`);
    expect((await runtime.requestNewContext()).accepted).toBe(false);
    expect(SessionManager.open(sessionFile, undefined, root).buildSessionContext().messages.some(message => message.role === "toolResult")).toBe(false);
    await runtime.terminate({ abort: false });
  });

  it("rejects missing notes without dropping context or running a summarizer", async () => {
    const { session, faux, runtime } = await createControlledFreshSession();
    let nextContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
      context => { nextContext = JSON.stringify(context.messages); return fauxAssistantMessage("Need to save notes first."); },
    ]);
    await session.prompt("Keep this original request available.");
    await session.waitForIdle();
    expect(nextContext).toContain("Keep this original request available.");
    expect(nextContext).toContain("Save or update notes checkpoint.md");
    expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
    expect(faux.state.callCount).toBe(2);
    await runtime.terminate({ abort: false });
  });

  it("invalidates an accepted request when late user input arrives before the tool batch settles", async () => {
    const { session, faux, notes, runtime } = await createControlledFreshSession(getRuntime => [{
      name: "late_input", label: "Late input", description: "Synthetic input arrival", parameters: Type.Object({}),
      async execute() {
        await getRuntime().sendMessage("New correction: inspect the existing result first.");
        return { content: [{ type: "text", text: "Late correction delivered" }], details: {} };
      },
    }]);
    await notes.write({ path: "checkpoint.md", text: "Original task is active; verify its result." });
    let nextContext = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("new_context", {}), fauxToolCall("late_input", {})], { stopReason: "toolUse" }),
      context => { nextContext = JSON.stringify(context.messages); return fauxAssistantMessage("Applied the new correction."); },
    ]);
    await session.prompt("Perform the original task.");
    await session.waitForIdle();
    expect(nextContext).toContain("New correction: inspect the existing result first.");
    expect(nextContext.match(/New correction: inspect the existing result first/g)).toHaveLength(1);
    expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
    await runtime.terminate({ abort: false });
  });

  it("preserves context if recovery storage fails after accepting the tool request", async () => {
    const { session, faux, notes, runtime } = await createControlledFreshSession(() => [{
      name: "break_notes", label: "Break notes", description: "Synthetic storage failure", parameters: Type.Object({}),
      async execute() {
        vi.spyOn(ActorTaskNotes.prototype, "checkpointHint").mockResolvedValue({ ready: false, empty: false,
          revision: 0, digest: "", hint: "unavailable", notes: [], warnings: ["synthetic failure"] });
        return { content: [{ type: "text", text: "Storage unavailable" }], details: {} };
      },
    }]);
    await notes.write({ path: "checkpoint.md", text: "Continue the task and retain permission scope." });
    let nextContext = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("new_context", {}), fauxToolCall("break_notes", {})], { stopReason: "toolUse" }),
      context => { nextContext = JSON.stringify(context.messages); return fauxAssistantMessage("Context retained; repair notes."); },
    ]);
    await session.prompt("Keep the task until storage is fixed.");
    await session.waitForIdle();
    expect(nextContext).toContain("Keep the task until storage is fixed.");
    expect(nextContext).toContain("requested fresh context was not committed");
    expect(session.sessionManager.getBranch().some(entry => entry.type === "compaction")).toBe(false);
    expect(faux.state.callCount).toBe(2);
    await runtime.terminate({ abort: false });
  });

  it.each(["new input", "stop"] as const)("cancels native preparation on %s without committing or losing the original context", async interruption => {
    const { session, faux, notes, runtime } = await createControlledFreshSession();
    await notes.write({ path: "checkpoint.md", text: "Original objective is active. Local actions only. Continue after checking the latest correction." });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalHint = ActorTaskNotes.prototype.checkpointHint;
    let held = false;
    vi.spyOn(ActorTaskNotes.prototype, "checkpointHint").mockImplementation(async function(options) {
      if (!held && (runtime as unknown as { freshBoundaryInProgress: boolean }).freshBoundaryInProgress) {
        held = true;
        enter();
        await gate;
      }
      return originalHint.call(this, options);
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("Original context retained; latest input incorporated."),
      fauxAssistantMessage("Late input incorporated once."),
    ]);
    const prompt = session.prompt("Original active task must survive failed preparation.");
    await entered;
    const interrupted = interruption === "stop"
      ? runtime.stopInFlight()
      : runtime.sendMessage("Latest correction during preparation.");
    release();
    await interrupted;
    await prompt;
    await session.waitForIdle();
    await vi.waitFor(() => expect(runtime.getStatus()).toBe("idle"));
    const branch = session.sessionManager.getBranch();
    expect(branch.some(entry => entry.type === "compaction")).toBe(false);
    const users = branch.filter(entry => entry.type === "message" && entry.message.role === "user");
    expect(JSON.stringify(users)).toContain("Original active task must survive failed preparation.");
    if (interruption === "new input") expect(JSON.stringify(users).match(/Latest correction during preparation/g)).toHaveLength(1);
    expect(runtime.getContextRemaining()).toMatchObject({ windowId: "window:initial", transitionPending: false });
    await vi.waitFor(() => expect(runtime.isContextRecoveryActive()).toBe(false), { timeout: 4000 });
    await runtime.shutdownForReplacement();
    expect((await runtime.requestNewContext()).accepted).toBe(false);
  });


  it("reminds once before using reserved capacity and checkpoints after the notes tool settles", async () => {
    const { session, faux, runtime, onRuntimeError } = await createControlledFreshSession(() => [{
      name: "inspect", label: "Inspect", description: "Synthetic inspection", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "Inspected state" }], details: {} }; },
    }]);
    vi.spyOn(session, "getContextUsage").mockReturnValue({ tokens: 29_500, contextWindow: 32_000, percent: 92.18 } as never);
    let reminderContext = "";
    let freshContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("inspect", {}), { stopReason: "toolUse" }),
      context => {
        reminderContext = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxToolCall("notes", { op: "write", path: "checkpoint.md", text: "Objective: finish inspection. Inspected state. Next: report verified outcome." }), { stopReason: "toolUse" });
      },
      context => { freshContext = JSON.stringify(context.messages); return fauxAssistantMessage("Inspection finished."); },
    ]);
    await session.prompt("Inspect and finish the task.");
    await session.waitForIdle();
    expect(onRuntimeError.mock.calls.map(([, error]) => error.details?.userFacingMessage)).toEqual([
      "Context is getting full — compacting automatically.",
      "Automatic compaction completed.",
    ]);
    expect(reminderContext).toContain("Context is nearing its reserved capacity");
    expect(freshContext).toContain("Fresh window checkpoint");
    const branch = session.sessionManager.getBranch();
    expect(branch.filter(entry => entry.type === "custom_message" && entry.customType === "forge_context_reserve")).toHaveLength(1);
    const compactions = branch.filter(entry => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].details).toMatchObject({ forgeContext: { trigger: "threshold", willRetry: true } });
    expect(faux.state.callCount).toBe(3);
    await runtime.terminate({ abort: false });
  });


  it("preserves automatic Summary start and completion messages", async () => {
    const { session, faux, runtime, onRuntimeError } = await createControlledFreshSession(undefined, () => "summary");
    faux.setResponses([fauxAssistantMessage("Initial response."), fauxAssistantMessage("Next response."), fauxAssistantMessage("Summary of the task."), fauxAssistantMessage("Turn prefix summary.")]);
    await session.prompt("Preserve this task. ".repeat(1000));
    await session.waitForIdle();
    await session.prompt("Continue the task.");
    await session.waitForIdle();
    session.settingsManager.applyOverrides({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 4096 } });
    await (session as unknown as {
      _runAutoCompaction(reason: "threshold", willRetry: boolean): Promise<boolean>;
    })._runAutoCompaction("threshold", false);
    await vi.waitFor(() => expect(onRuntimeError.mock.calls.map(([, error]) => error.details?.userFacingMessage)).toEqual([
      "Context is getting full — compacting automatically.",
      "Automatic compaction completed.",
    ]));
    const compactions = session.sessionManager.getBranch().filter(entry => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].details).not.toMatchObject({ forgeContext: { mode: "fresh" } });
    await runtime.terminate({ abort: false });
  });

  it("keeps registered tools truthful across a live Summary-to-Fresh policy switch", async () => {
    let mode: "summary" | "fresh" = "summary";
    const { session, faux, notes, runtime } = await createControlledFreshSession(undefined, () => mode);
    await notes.write({ path: "checkpoint.md", text: "Objective: verify the live policy. Local task only. Next: finish after the accepted Fresh transition." });
    let summaryContext = "";
    let freshContext = "";
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" }),
      context => {
        summaryContext = JSON.stringify(context.messages);
        mode = "fresh";
        return fauxAssistantMessage(fauxToolCall("new_context", {}), { stopReason: "toolUse" });
      },
      context => { freshContext = JSON.stringify(context.messages); return fauxAssistantMessage("Same task completed in Fresh mode."); },
    ]);
    await session.prompt("Exercise the currently selected context policy.");
    await session.waitForIdle();
    expect(summaryContext).toContain("Agent-requested fresh context is unavailable in this runtime or mode.");
    expect(summaryContext).not.toContain("Fresh window checkpoint");
    expect(freshContext).toContain("Fresh window checkpoint");
    expect(session.sessionManager.getBranch().filter(entry => entry.type === "compaction")).toHaveLength(1);
    expect(faux.state.callCount).toBe(3);
    await runtime.terminate({ abort: false });
  });

});
