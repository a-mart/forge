import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFauxProvider } from "../pi/pi-ai-compat.js";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
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
  while (fauxRegistrations.length > 0) {
    fauxRegistrations.pop()?.unregister();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createFreshSession(options?: { persist?: boolean; sessionFile?: string }) {
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
    expect(active).not.toContain("Oversized first input that must remain on the old branch");
    expect(active).toContain("Fresh window checkpoint");
    const branch = session.sessionManager.getBranch();
    expect(branch.some((entry) => entry.type === "message")).toBe(true);
    const reopened = SessionManager.open(sessionFile, undefined, root);
    const reopenedActive = JSON.stringify(reopened.buildSessionContext().messages);
    expect(reopenedActive).not.toContain("Oversized first input that must remain on the old branch");
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
    const match = summary.match(/history\(\{op:"read",ref:(\{.*?\})\}\)/);
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
    await pending;
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
