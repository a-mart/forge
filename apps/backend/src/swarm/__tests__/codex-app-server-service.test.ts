import { describe, expect, it, vi } from "vitest";
import { CodexAppServerService } from "../codex-app-server/codex-app-server-service.js";
import { CodexSidecarBusyError } from "../codex-app-server/types.js";
import type {
  CodexAppServerClientHandlers,
  CodexAppServerClientPort,
  CodexAppServerServiceOptions,
  CodexSidecarHost,
  CodexSidecarPersistedThreadState,
} from "../codex-app-server/types.js";
import type {
  AgentDescriptor,
  AgentStatus,
  ConversationEntryEvent,
  ConversationMessageEvent,
} from "../types.js";
import { createManagerDescriptor } from "../../test-support/fixtures.js";

const TEST_TURN_COMPLETION_GRACE_MS = 25;

function createTestService(
  host: CodexSidecarHost,
  overrides: Omit<CodexAppServerServiceOptions, "dataDir"> = {},
): CodexAppServerService {
  return new CodexAppServerService(host, {
    dataDir: "/tmp/forge-data",
    turnCompletionGraceMs: TEST_TURN_COMPLETION_GRACE_MS,
    ...overrides,
  });
}

async function flushTurnCompletionGrace(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TEST_TURN_COMPLETION_GRACE_MS + 10));
}

class FakeCodexAppServerClient implements CodexAppServerClientPort {
  private connected = false;
  private disposed = false;
  private nextTurnNumber = 0;
  lastTurnId = "";
  readonly requests: Array<{ method: string; params?: unknown; timeoutMs?: number }> = [];
  autoCompleteTurn = true;
  turnCompletionDelayMs = 0;
  connectAttempts = 0;
  connectShouldFail = false;
  readonly failMethods = new Set<string>();
  holdTurnInterrupt = false;
  private interruptRelease: ((value: unknown) => void) | undefined;

  constructor(readonly handlers: CodexAppServerClientHandlers) {}

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.connectShouldFail) {
      this.disposed = true;
      throw new Error("connect failed");
    }
    this.connected = true;
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.failMethods.has(method)) {
      throw new Error(`JSON-RPC request timed out: ${method}`);
    }

    this.requests.push({ method, params, timeoutMs });

    if (method === "thread/resume") {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      if (threadId === "resume-fails") {
        throw new Error("resume failed");
      }
      return { thread: { id: threadId } } as T;
    }

    if (method === "thread/start") {
      expect(params).toMatchObject({ ephemeral: false });
      return { thread: { id: "thread-new" } } as T;
    }

    if (method === "turn/start") {
      this.nextTurnNumber += 1;
      const turnId = `turn-${this.nextTurnNumber}`;
      this.lastTurnId = turnId;
      if (this.autoCompleteTurn) {
        const completeTurn = async () => {
          if (this.turnCompletionDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.turnCompletionDelayMs));
          }
          await this.handlers.onNotification?.("turn/started", { turn: { id: turnId } });
          await this.handlers.onNotification?.("item/agentMessage/delta", {
            turn: { id: turnId },
            delta: "Hel",
          });
          await this.handlers.onNotification?.("item/agentMessage/delta", {
            turn: { id: turnId },
            delta: "lo",
          });
          await this.handlers.onNotification?.("item/completed", {
            turn: { id: turnId },
            item: { type: "agentMessage", text: "Hello" },
          });
          await this.handlers.onNotification?.("turn/completed", { turn: { id: turnId } });
        };

        if (this.turnCompletionDelayMs > 0) {
          void completeTurn();
        } else {
          queueMicrotask(() => {
            void completeTurn();
          });
        }
      }
      return { turn: { id: turnId } } as T;
    }

    if (method === "turn/interrupt") {
      if (this.holdTurnInterrupt) {
        return await new Promise<T>((resolve) => {
          this.interruptRelease = (value) => resolve(value as T);
        });
      }
      return {} as T;
    }

    if (method === "plugin/list") {
      return { plugins: [] } as T;
    }

    throw new Error(`Unexpected fake request: ${method}`);
  }

  notify(): void {}

  dispose(): void {
    this.disposed = true;
    this.connected = false;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  emitProcessExit(error: Error): void {
    this.handlers.onExit?.(error);
  }

  async completeTurn(turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: resolvedTurnId },
      item: { type: "agentMessage", text: "Hello" },
    });
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
    await flushTurnCompletionGrace();
  }

  releaseHeldInterrupt(): void {
    this.interruptRelease?.({});
    this.interruptRelease = undefined;
  }

  async emitOutOfOrderCompletion(finalText: string, turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
    await this.handlers.onNotification?.("item/completed", {
      turn: { id: resolvedTurnId },
      item: { type: "agentMessage", text: finalText },
    });
    await flushTurnCompletionGrace();
  }

  async emitTurnCompletedOnly(turnId?: string): Promise<void> {
    const resolvedTurnId = turnId ?? this.lastTurnId;
    await this.handlers.onNotification?.("turn/completed", { turn: { id: resolvedTurnId } });
  }

  async emitDelayedAgentMessageCompletion(finalText: string, turnId?: string): Promise<void> {
    if (turnId) {
      await this.handlers.onNotification?.("item/completed", {
        turn: { id: turnId },
        item: { type: "agentMessage", text: finalText },
      });
      return;
    }

    await this.handlers.onNotification?.("item/completed", {
      item: { type: "agentMessage", text: finalText },
    });
  }

  async emitTurnlessItemDelta(delta: string): Promise<void> {
    await this.handlers.onNotification?.("item/agentMessage/delta", { delta });
  }

  async emitTurnlessItemCompleted(text: string): Promise<void> {
    await this.handlers.onNotification?.("item/completed", {
      item: { type: "agentMessage", text },
    });
  }
}

function createFakeHost(initialDescriptors: AgentDescriptor[] = []): {
  host: CodexSidecarHost;
  descriptors: Map<string, AgentDescriptor>;
  conversationEntries: ConversationEntryEvent[];
  conversationMessages: ConversationMessageEvent[];
  statusEvents: Array<{ agentId: string; status: AgentStatus; pendingCount: number }>;
  threadAuditBySessionFile: Map<string, CodexSidecarPersistedThreadState>;
  threadFallbackBySessionFile: Map<string, CodexSidecarPersistedThreadState>;
} {
  const descriptors = new Map(initialDescriptors.map((descriptor) => [descriptor.agentId, descriptor]));
  const conversationEntries: ConversationEntryEvent[] = [];
  const conversationMessages: ConversationMessageEvent[] = [];
  const statusEvents: Array<{ agentId: string; status: AgentStatus; pendingCount: number }> = [];
  const threadAuditBySessionFile = new Map<string, CodexSidecarPersistedThreadState>();
  const threadFallbackBySessionFile = new Map<string, CodexSidecarPersistedThreadState>();

  const host: CodexSidecarHost = {
    now: () => "2026-05-30T12:00:00.000Z",
    logDebug: vi.fn(),
    getDescriptor: (agentId) => descriptors.get(agentId),
    upsertDescriptor: (descriptor) => {
      descriptors.set(descriptor.agentId, descriptor);
    },
    saveStore: vi.fn(async () => undefined),
    ensureSessionFileParentDirectory: vi.fn(async () => undefined),
    appendConversationEntry: (_agentId, entry) => {
      conversationEntries.push(entry);
    },
    emitConversationMessage: (event) => {
      conversationMessages.push(event);
    },
    emitAgentMessage: vi.fn(),
    emitAgentToolCall: vi.fn(),
    emitStatus: (agentId, status, pendingCount) => {
      statusEvents.push({ agentId, status, pendingCount });
    },
    emitAgentsSnapshot: vi.fn(),
    emitProfilesSnapshot: vi.fn(),
    listWorkersForSession: (sessionAgentId) =>
      [...descriptors.values()].filter(
        (descriptor) => descriptor.managerId === sessionAgentId && descriptor.role === "worker",
      ),
    readSidecarThreadStateFallback: (sessionFile) => threadFallbackBySessionFile.get(sessionFile),
    writeSidecarThreadStateAudit: async (sessionFile, state, _cwd) => {
      threadAuditBySessionFile.set(sessionFile, state);
    },
    emitParentExternalThreadCard: (params) => {
      conversationMessages.push({
        type: "conversation_message",
        agentId: params.managerAgentId,
        role: "system",
        text: params.status,
        timestamp: "2026-05-30T12:00:00.000Z",
        source: "system",
        externalThreadContext: {
          type: "codex_app_server",
          sidecarAgentId: params.sidecarAgentId,
          requestId: params.requestId,
          turnCorrelationId: params.turnCorrelationId,
          promptPreview: params.promptPreview,
          resultPreview: params.resultPreview,
          status: params.status,
          excludeFromModelContext: true,
        },
      });
    },
    emitParentUserToCodexAgentMessage: vi.fn(),
  };

  return {
    host,
    descriptors,
    conversationEntries,
    conversationMessages,
    statusEvents,
    threadAuditBySessionFile,
    threadFallbackBySessionFile,
  };
}

describe("CodexAppServerService", () => {
  it("reuses one shared client across sidecars", async () => {
    let createdClients = 0;
    const fakeClients: FakeCodexAppServerClient[] = [];
    const { host } = createFakeHost();
    const service = createTestService(host, {
      createClient: (handlers) => {
        createdClients += 1;
        const client = new FakeCodexAppServerClient(handlers);
        fakeClients.push(client);
        return client;
      },
    });

    const managerA = createManagerDescriptor("/tmp/project-a", {
      agentId: "mgr-a",
      profileId: "profile-a",
    });
    const managerB = createManagerDescriptor("/tmp/project-b", {
      agentId: "mgr-b",
      profileId: "profile-b",
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.createOrResumeThread("mgr-a--codex");
    await service.createOrResumeThread("mgr-b--codex");

    expect(createdClients).toBe(1);
    expect(fakeClients[0]?.requests.filter((request) => request.method === "thread/start")).toHaveLength(2);
  });

  it("creates sidecar descriptor with persisted external thread metadata", async () => {
    const { host, descriptors } = createFakeHost();
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    const manager = createManagerDescriptor("/tmp/project", {
      agentId: "mgr-1",
      profileId: "profile-1",
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    expect(sidecar.agentId).toBe("mgr-1--codex");
    expect(sidecar.externalThread).toEqual({
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
    });
    expect(descriptors.has("mgr-1--codex")).toBe(true);
    expect(host.ensureSessionFileParentDirectory).toHaveBeenCalled();
  });

  it("reconciles descriptor-primary thread id and falls back to transcript audit state", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, descriptors, threadFallbackBySessionFile } = createFakeHost([manager]);
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    sidecar.externalThread = {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "thread-descriptor",
    };
    descriptors.set(sidecar.agentId, sidecar);

    await expect(service.reconcileSidecarThreadId(sidecar)).resolves.toBe("thread-descriptor");

    sidecar.externalThread = {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
    };
    threadFallbackBySessionFile.set(sidecar.sessionFile, {
      threadId: "thread-fallback",
      persisted: true,
    });

    await expect(service.reconcileSidecarThreadId(sidecar)).resolves.toBe("thread-fallback");
    expect(sidecar.externalThread.threadId).toBe("thread-fallback");
    expect(host.saveStore).toHaveBeenCalled();
  });

  it("persists only thread ids across restart, so in-progress parent cards have no durable active-turn metadata", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const initial = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(initial.host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn(sidecar.agentId, "long task", {
      parentRouting: {
        managerAgentId: manager.agentId,
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    expect(service.getRuntimeStateForTest(sidecar.agentId)?.activeTurn).toBeDefined();
    expect(
      initial.conversationMessages.some(
        (message) =>
          message.agentId === manager.agentId &&
          message.externalThreadContext?.type === "codex_app_server" &&
          message.externalThreadContext.status === "sent",
      ),
    ).toBe(true);
    expect(initial.threadAuditBySessionFile.get(sidecar.sessionFile)).toEqual({
      threadId: "thread-new",
      persisted: true,
    });

    service.dispose();

    const restartedSidecar: AgentDescriptor = {
      ...sidecar,
      externalThread: {
        type: "codex_app_server",
        persisted: true,
        createdByMention: true,
      },
    };
    const restarted = createFakeHost([manager, restartedSidecar]);
    restarted.threadFallbackBySessionFile.set(
      sidecar.sessionFile,
      initial.threadAuditBySessionFile.get(sidecar.sessionFile)!,
    );
    const restartedService = createTestService(restarted.host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    await expect(restartedService.reconcileSidecarThreadId(restartedSidecar)).resolves.toBe("thread-new");
    expect(restartedService.getRuntimeStateForTest(sidecar.agentId)).toBeUndefined();
  });

  it("starts persisted thread with ephemeral false when resume fails", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        return fakeClient;
      },
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    sidecar.externalThread = {
      type: "codex_app_server",
      persisted: true,
      createdByMention: true,
      threadId: "resume-fails",
    };

    const threadId = await service.createOrResumeThread(sidecar.agentId);
    expect(threadId).toBe("thread-new");
    expect(fakeClient?.requests.map((request) => request.method)).toEqual([
      "thread/resume",
      "thread/start",
    ]);
    expect(fakeClient?.requests[1]?.params).toMatchObject({ ephemeral: false });
  });

  it("rejects concurrent sends for the same sidecar", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);

    await service.sendTextTurn("mgr-1--codex", "first turn");
    await expect(service.sendTextTurn("mgr-1--codex", "second turn")).rejects.toBeInstanceOf(
      CodexSidecarBusyError,
    );

    fakeClient!.autoCompleteTurn = true;
    await fakeClient!.completeTurn();
  });

  it("runs a text turn through streaming to assistant message and idle status", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages, statusEvents, threadAuditBySessionFile } =
      createFakeHost([manager]);
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "say hello");

    await vi.waitFor(() => {
      expect(conversationMessages.some((message) => message.text === "Hello")).toBe(true);
    });

    expect(conversationEntries.some((entry) => entry.type === "conversation_message" && entry.text === "say hello")).toBe(
      true,
    );
    expect(statusEvents.some((event) => event.agentId === sidecar.agentId && event.status === "streaming")).toBe(true);
    expect(statusEvents.at(-1)).toMatchObject({ agentId: "mgr-1--codex", status: "idle", pendingCount: 0 });
    expect(threadAuditBySessionFile.get(sidecar.sessionFile)?.threadId).toBe("thread-new");
  });

  it("syncs sidecar cwd from manager before thread resume and turn start", async () => {
    const manager = createManagerDescriptor("/tmp/old", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, descriptors } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        return fakeClient;
      },
    });

    const sidecar = await service.getOrCreateSidecarDescriptor(manager);
    expect(sidecar.cwd).toBe("/tmp/old");

    manager.cwd = "/tmp/new";
    descriptors.set(manager.agentId, manager);

    await service.sendTextTurn("mgr-1--codex", "hello");

    expect(descriptors.get("mgr-1--codex")?.cwd).toBe("/tmp/new");
    expect(fakeClient?.requests.find((request) => request.method === "thread/start")?.params).toMatchObject({
      cwd: "/tmp/new",
    });
    expect(fakeClient?.requests.find((request) => request.method === "turn/start")?.params).toMatchObject({
      cwd: "/tmp/new",
    });
  });

  it("persists synced cwd for an existing idle sidecar even when another sidecar keeps Codex globally busy", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b-old", { agentId: "mgr-b", profileId: "profile-b" });
    const { host, descriptors } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "running");

    const saveStoreSpy = host.saveStore as unknown as ReturnType<typeof vi.fn>;
    saveStoreSpy.mockClear();

    managerB.cwd = "/tmp/project-b-new";
    descriptors.set(managerB.agentId, managerB);

    const sidecarB = await service.getOrCreateSidecarDescriptor(managerB);
    await expect(service.sendTextTurn("mgr-b--codex", "blocked")).rejects.toBeInstanceOf(
      CodexSidecarBusyError,
    );

    expect(sidecarB.cwd).toBe("/tmp/project-b-new");
    expect(descriptors.get("mgr-b--codex")?.cwd).toBe("/tmp/project-b-new");
    expect(saveStoreSpy).toHaveBeenCalledTimes(1);
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn).toBeUndefined();

    fakeClient!.autoCompleteTurn = true;
    await fakeClient!.completeTurn();
  });

  it("cleanupSidecarTurnStateForTermination clears global busy state without stop semantics", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b", { agentId: "mgr-b", profileId: "profile-b" });
    const { host, conversationEntries, conversationMessages, statusEvents } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "running", {
      parentRouting: {
        managerAgentId: "mgr-a",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    const entriesBeforeCleanup = conversationEntries.length;
    const statusEventsBeforeCleanup = statusEvents.length;
    const parentCardsBeforeCleanup = conversationMessages.filter(
      (message) =>
        message.agentId === "mgr-a" &&
        message.externalThreadContext?.type === "codex_app_server",
    );
    expect(parentCardsBeforeCleanup.some((message) => message.externalThreadContext?.status === "sent")).toBe(true);
    expect(parentCardsBeforeCleanup.some((message) => message.externalThreadContext?.status === "stopped")).toBe(false);

    await service.cleanupSidecarTurnStateForTermination("mgr-a--codex");

    expect(fakeClient?.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    expect(service.getRuntimeStateForTest("mgr-a--codex")?.activeTurn).toBeUndefined();
    expect(conversationEntries.length).toBe(entriesBeforeCleanup);
    expect(statusEvents.length).toBe(statusEventsBeforeCleanup);
    expect(conversationEntries.some((entry) => entry.type === "conversation_message" && entry.text === "Codex turn stopped.")).toBe(
      false,
    );
    expect(
      conversationMessages.some(
        (message) =>
          message.agentId === "mgr-a" &&
          message.externalThreadContext?.type === "codex_app_server" &&
          message.externalThreadContext?.status === "stopped",
      ),
    ).toBe(true);

    await service.sendTextTurn("mgr-b--codex", "after cleanup");
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn?.turnId).toBe("turn-2");
  });

  it("ignores stale cross-sidecar turnless A and still accepts legitimate attributed B after termination cleanup", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b", { agentId: "mgr-b", profileId: "profile-b" });
    const { host, conversationMessages } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "turn A");
    await service.cleanupSidecarTurnStateForTermination("mgr-a--codex");

    await service.sendTextTurn("mgr-b--codex", "turn B");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    const messagesBeforeStale = conversationMessages.length;
    await fakeClient!.emitTurnlessItemCompleted("stale final from cleaned-up A");

    expect(conversationMessages.length).toBe(messagesBeforeStale);
    expect(conversationMessages.some((message) => message.text.includes("stale final from cleaned-up A"))).toBe(
      false,
    );
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn?.turnCompletedPending).toBe(
      true,
    );

    await fakeClient!.emitDelayedAgentMessageCompletion("B real final", "turn-2");
    await flushTurnCompletionGrace();
    expect(conversationMessages.some((message) => message.text === "B real final")).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn).toBeUndefined();
  });

  it("interruptTurn calls turn/interrupt and clears active turn", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "long task");
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnId).toBe("turn-1");

    await service.interruptTurn("mgr-1--codex");
    expect(fakeClient?.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    expect(conversationEntries.some((entry) => entry.type === "conversation_message" && entry.text === "Codex turn stopped.")).toBe(
      true,
    );
  });

  it("ignores stale turnless A and still accepts legitimate attributed B after interrupt", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    await service.interruptTurn("mgr-1--codex");

    await service.sendTextTurn("mgr-1--codex", "turn B");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    const messagesBeforeStale = conversationMessages.length;
    await fakeClient!.emitTurnlessItemCompleted("stale final from interrupted A");

    expect(conversationMessages.length).toBe(messagesBeforeStale);
    expect(conversationMessages.some((message) => message.text.includes("stale final from interrupted A"))).toBe(
      false,
    );
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnCompletedPending).toBe(
      true,
    );

    await fakeClient!.emitDelayedAgentMessageCompletion("B real final", "turn-2");
    await flushTurnCompletionGrace();
    expect(conversationMessages.some((message) => message.text === "B real final")).toBe(true);
    expect(
      conversationEntries.some(
        (entry) => entry.type === "conversation_message" && entry.text.includes("ambiguous turnless output"),
      ),
    ).toBe(false);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("marks active sidecar error and appends system message when shared client exits", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, statusEvents } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "work");
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeDefined();

    fakeClient?.emitProcessExit(new Error("process crashed"));
    expect(statusEvents.at(-1)).toMatchObject({ agentId: "mgr-1--codex", status: "error" });
    expect(
      conversationEntries.some(
        (entry) => entry.type === "conversation_message" && entry.text.includes("process crashed"),
      ),
    ).toBe(true);
  });

  it("probe reports health using shared client initialization", async () => {
    const { host } = createFakeHost();
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    await expect(service.probe()).resolves.toEqual({ ok: true, initialized: true });
  });

  it("clears active turn and marks error when thread/start fails during sendTextTurn", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, descriptors } = createFakeHost([manager]);
    const fakeClients: FakeCodexAppServerClient[] = [];
    const service = createTestService(host, {
      createClient: (handlers) => {
        const client = new FakeCodexAppServerClient(handlers);
        fakeClients.push(client);
        return client;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.probe();
    fakeClients[0]!.failMethods.add("thread/start");

    await expect(service.sendTextTurn("mgr-1--codex", "hello")).rejects.toThrow(
      /JSON-RPC request timed out: thread\/start/,
    );
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    expect(descriptors.get("mgr-1--codex")?.status).toBe("error");
    expect(service.getSharedClientForTest()).toBeUndefined();

    fakeClients[0]!.failMethods.delete("thread/start");
    await service.sendTextTurn("mgr-1--codex", "hello again");
    expect(descriptors.get("mgr-1--codex")?.status).toBe("streaming");
  });

  it("does not emit parent manager artifacts before send acceptance when thread/start fails", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    const fakeClients: FakeCodexAppServerClient[] = [];
    const service = createTestService(host, {
      createClient: (handlers) => {
        const client = new FakeCodexAppServerClient(handlers);
        fakeClients.push(client);
        return client;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.probe();
    fakeClients[0]!.failMethods.add("thread/start");

    await expect(
      service.sendTextTurn("mgr-1--codex", "hello", {
        parentRouting: {
          managerAgentId: "mgr-1",
          emitParentRequestCard: true,
          sourceContext: { channel: "web" },
        },
      }),
    ).rejects.toThrow(/JSON-RPC request timed out: thread\/start/);

    expect(
      conversationMessages.filter(
        (message) => message.agentId === "mgr-1" && message.externalThreadContext?.type === "codex_app_server",
      ),
    ).toHaveLength(0);
    expect(host.emitParentUserToCodexAgentMessage).not.toHaveBeenCalled();
  });

  it("clears active turn and marks error when turn/start fails", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, descriptors, statusEvents } = createFakeHost([manager]);
    const fakeClients: FakeCodexAppServerClient[] = [];
    const service = createTestService(host, {
      createClient: (handlers) => {
        const client = new FakeCodexAppServerClient(handlers);
        fakeClients.push(client);
        return client;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.probe();
    fakeClients[0]!.failMethods.add("turn/start");

    await expect(service.sendTextTurn("mgr-1--codex", "hello")).rejects.toThrow(
      /JSON-RPC request timed out: turn\/start/,
    );
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    expect(descriptors.get("mgr-1--codex")?.status).toBe("error");
    expect(statusEvents.at(-1)).toMatchObject({ agentId: "mgr-1--codex", status: "error" });

    fakeClients[0]!.failMethods.delete("turn/start");
    await service.sendTextTurn("mgr-1--codex", "retry");
    expect(descriptors.get("mgr-1--codex")?.status).toBe("streaming");
  });

  it("clears active turn when audit persistence fails", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, descriptors } = createFakeHost([manager]);
    host.writeSidecarThreadStateAudit = vi.fn(async () => {
      throw new Error("audit write failed");
    });

    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await expect(service.sendTextTurn("mgr-1--codex", "hello")).rejects.toThrow("audit write failed");
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    expect(descriptors.get("mgr-1--codex")?.status).toBe("error");
  });

  it("enforces a global single-active-turn guard across sidecars", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b", { agentId: "mgr-b", profileId: "profile-b" });
    const { host } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "first");

    await expect(service.sendTextTurn("mgr-b--codex", "second")).rejects.toMatchObject({
      sidecarAgentId: "mgr-a--codex",
      requestedSidecarAgentId: "mgr-b--codex",
    });
    expect(service.getRuntimeStateForTest("mgr-a--codex")?.activeTurn?.turnId).toBe("turn-1");
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn).toBeUndefined();

    await fakeClient!.completeTurn();
    expect(service.getRuntimeStateForTest("mgr-a--codex")?.activeTurn).toBeUndefined();
    await service.sendTextTurn("mgr-b--codex", "second");
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn?.turnId).toBe("turn-2");
  });

  it("routes shared notifications only to the globally active sidecar", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b", { agentId: "mgr-b", profileId: "profile-b" });
    const { host, conversationMessages } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "only-a");

    await fakeClient!.emitOutOfOrderCompletion("Sidecar A reply");
    expect(conversationMessages.some((message) => message.agentId === "mgr-a--codex" && message.text === "Sidecar A reply")).toBe(
      true,
    );
    expect(conversationMessages.some((message) => message.agentId === "mgr-b--codex")).toBe(false);
  });

  it("preserves final assistant text when turn/completed arrives before item/completed", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "hello");
    await fakeClient!.emitOutOfOrderCompletion("Final answer");

    expect(conversationMessages.some((message) => message.text === "Final answer")).toBe(true);
  });

  it("hydrates assistant text from turn/completed items when item/completed is missing", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "hello", {
      parentRouting: {
        managerAgentId: "mgr-1",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    await fakeClient!.handlers.onNotification?.("turn/completed", {
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", id: "item-1", text: "Final from turn payload" }],
      },
    });

    await vi.waitFor(() => {
      expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    });

    expect(
      conversationMessages.some(
        (message) => message.agentId === "mgr-1--codex" && message.text === "Final from turn payload",
      ),
    ).toBe(true);
    expect(
      conversationMessages.some(
        (message) =>
          message.agentId === "mgr-1" &&
          message.externalThreadContext?.status === "completed" &&
          message.externalThreadContext.resultPreview === "Final from turn payload",
      ),
    ).toBe(true);
  });

  it("surfaces failed turn/completed payloads as error cards instead of blank completions", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "hello", {
      parentRouting: {
        managerAgentId: "mgr-1",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    await fakeClient!.handlers.onNotification?.("turn/completed", {
      turn: {
        id: "turn-1",
        status: "failed",
        items: [],
        error: { message: "Connection refused" },
      },
    });

    await vi.waitFor(() => {
      expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    });

    expect(
      conversationEntries.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.agentId === "mgr-1--codex" &&
          entry.role === "system" &&
          entry.text === "Codex turn failed: Connection refused",
      ),
    ).toBe(true);
    expect(
      conversationMessages.some(
        (message) =>
          message.agentId === "mgr-1" &&
          message.externalThreadContext?.status === "error" &&
          message.externalThreadContext.resultPreview === "Codex turn failed: Connection refused",
      ),
    ).toBe(true);
  });

  it("disposes failed shared client when connect fails and retries on next use", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host } = createFakeHost([manager]);
    const fakeClients: FakeCodexAppServerClient[] = [];
    const service = createTestService(host, {
      createClient: (handlers) => {
        const client = new FakeCodexAppServerClient(handlers);
        if (fakeClients.length === 0) {
          client.connectShouldFail = true;
        } else {
          client.autoCompleteTurn = true;
        }
        fakeClients.push(client);
        return client;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await expect(service.sendTextTurn("mgr-1--codex", "hello")).rejects.toThrow("connect failed");
    expect(fakeClients[0]?.isDisposed()).toBe(true);
    expect(service.getSharedClientForTest()).toBeUndefined();

    await service.sendTextTurn("mgr-1--codex", "hello");
    await vi.waitFor(() => {
      expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    });
    expect(fakeClients[1]?.connectAttempts).toBe(1);
    expect(service.getSharedClientForTest()).toBe(fakeClients[1]);
  });

  it("accepts item/completed after turn/completed grace tick has passed setImmediate", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "hello");
    await fakeClient!.emitTurnCompletedOnly();
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeDefined();
    await fakeClient!.emitDelayedAgentMessageCompletion("Late final");
    expect(conversationMessages.some((message) => message.text === "Late final")).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("keeps shared client globally busy until interruptTurn clears active turn", async () => {
    const managerA = createManagerDescriptor("/tmp/project-a", { agentId: "mgr-a", profileId: "profile-a" });
    const managerB = createManagerDescriptor("/tmp/project-b", { agentId: "mgr-b", profileId: "profile-b" });
    const { host } = createFakeHost([managerA, managerB]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        fakeClient.holdTurnInterrupt = true;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(managerA);
    await service.getOrCreateSidecarDescriptor(managerB);
    await service.sendTextTurn("mgr-a--codex", "running");

    const interruptPromise = service.interruptTurn("mgr-a--codex");
    await vi.waitFor(() => {
      expect(service.getRuntimeStateForTest("mgr-a--codex")?.activeTurn?.interruptInProgress).toBe(true);
    });

    await expect(service.sendTextTurn("mgr-b--codex", "blocked")).rejects.toMatchObject({
      sidecarAgentId: "mgr-a--codex",
      requestedSidecarAgentId: "mgr-b--codex",
    });

    fakeClient!.releaseHeldInterrupt();
    await interruptPromise;

    expect(service.getRuntimeStateForTest("mgr-a--codex")?.activeTurn).toBeUndefined();
    await service.sendTextTurn("mgr-b--codex", "after interrupt");
    expect(service.getRuntimeStateForTest("mgr-b--codex")?.activeTurn?.turnId).toBe("turn-2");
  });

  it("ignores late turnless item notifications from a prior turn after grace finalization", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnId).toBe("turn-1");

    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-1" } });
    await fakeClient!.emitTurnCompletedOnly("turn-1");
    await flushTurnCompletionGrace();
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();

    await service.sendTextTurn("mgr-1--codex", "turn B");
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnId).toBe("turn-2");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });

    const messagesBeforeStale = conversationMessages.length;
    await fakeClient!.emitTurnlessItemDelta("stale-from-A");
    await fakeClient!.emitTurnlessItemCompleted("stale final from A");

    expect(conversationMessages.length).toBe(messagesBeforeStale);
    expect(
      conversationMessages.some(
        (message) => message.text.includes("stale") || message.text.includes("stale-from-A"),
      ),
    ).toBe(false);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.assistantText).toBe("");
  });

  it("attributed current-turn completion still wins over quarantined guarded text during B completion grace", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-1" } });
    await fakeClient!.emitTurnCompletedOnly("turn-1");
    await flushTurnCompletionGrace();

    await service.sendTextTurn("mgr-1--codex", "turn B");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    const messagesBeforeStale = conversationMessages.length;
    await fakeClient!.emitTurnlessItemCompleted("stale final from A");

    expect(conversationMessages.length).toBe(messagesBeforeStale);
    expect(conversationMessages.some((message) => message.text.includes("stale final from A"))).toBe(
      false,
    );
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnCompletedPending).toBe(
      true,
    );

    await fakeClient!.emitDelayedAgentMessageCompletion("B real final", "turn-2");
    expect(conversationMessages.some((message) => message.text === "B real final")).toBe(true);
    expect(
      conversationEntries.some(
        (entry) => entry.type === "conversation_message" && entry.text.includes("ambiguous turnless output"),
      ),
    ).toBe(false);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("accepts legitimate attributed B after summary-only turn A finalized from turn/completed payload", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    await fakeClient!.handlers.onNotification?.("turn/completed", {
      turn: {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", content: "A from summary" }],
      },
    });
    await vi.waitFor(() => {
      expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
    });

    await service.sendTextTurn("mgr-1--codex", "turn B");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn?.turnCompletedPending).toBe(
      true,
    );

    await fakeClient!.emitDelayedAgentMessageCompletion("B real final", "turn-2");
    await flushTurnCompletionGrace();
    expect(conversationMessages.some((message) => message.text === "B real final")).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("drops guarded stale turnless completion text and emits an explicit ambiguity result", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    await service.interruptTurn("mgr-1--codex");

    await service.sendTextTurn("mgr-1--codex", "turn B", {
      parentRouting: {
        managerAgentId: "mgr-1",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    await fakeClient!.emitTurnlessItemCompleted("stale final from A only");
    await flushTurnCompletionGrace();

    expect(conversationMessages.some((message) => message.text === "stale final from A only")).toBe(false);
    expect(
      conversationEntries.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.text.includes("ambiguous turnless output") &&
          entry.text.includes("Result not shown"),
      ),
    ).toBe(true);
    expect(
      conversationMessages.some(
        (message) =>
          message.externalThreadContext?.status === "error" &&
          message.externalThreadContext.resultPreview?.includes("ambiguous turnless output") === true,
      ),
    ).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("turnless-only guarded current-turn output resolves to explicit ambiguity instead of a blank completion", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationEntries, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "turn A");
    await service.interruptTurn("mgr-1--codex");

    await service.sendTextTurn("mgr-1--codex", "turn B", {
      parentRouting: {
        managerAgentId: "mgr-1",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-2" } });
    await fakeClient!.emitTurnCompletedOnly("turn-2");

    await fakeClient!.emitTurnlessItemCompleted("legit but unattributed current-turn output");
    await flushTurnCompletionGrace();

    expect(
      conversationMessages.some((message) => message.text === "legit but unattributed current-turn output"),
    ).toBe(false);
    expect(
      conversationEntries.some(
        (entry) =>
          entry.type === "conversation_message" &&
          entry.text.includes("ambiguous turnless output") &&
          entry.text.includes("Result not shown"),
      ),
    ).toBe(true);
    expect(
      conversationMessages.some(
        (message) =>
          message.externalThreadContext?.status === "error" &&
          message.externalThreadContext.resultPreview?.includes("ambiguous turnless output") === true,
      ),
    ).toBe(true);
    expect(service.getRuntimeStateForTest("mgr-1--codex")?.activeTurn).toBeUndefined();
  });

  it("ignores notifications after dispose clears active turn state", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    let fakeClient: FakeCodexAppServerClient | undefined;
    const service = createTestService(host, {
      createClient: (handlers) => {
        fakeClient = new FakeCodexAppServerClient(handlers);
        fakeClient.autoCompleteTurn = false;
        return fakeClient;
      },
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "running");
    await fakeClient!.handlers.onNotification?.("turn/started", { turn: { id: "turn-1" } });

    const messagesBeforeDispose = conversationMessages.length;
    service.dispose();

    await fakeClient!.emitTurnlessItemDelta("late delta");
    await fakeClient!.emitTurnlessItemCompleted("late final");
    await fakeClient!.handlers.onNotification?.("turn/completed", { turn: { id: "turn-1" } });

    expect(conversationMessages.length).toBe(messagesBeforeDispose);
    expect(service.getRuntimeStateForTest("mgr-1--codex")).toBeUndefined();
  });

  it("emits append-only parent request and completion cards with manager-owned agentId", async () => {
    const manager = createManagerDescriptor("/tmp/project", { agentId: "mgr-1", profileId: "profile-1" });
    const { host, conversationMessages } = createFakeHost([manager]);
    const service = createTestService(host, {
      createClient: (handlers) => new FakeCodexAppServerClient(handlers),
    });

    await service.getOrCreateSidecarDescriptor(manager);
    await service.sendTextTurn("mgr-1--codex", "say hello", {
      parentRouting: {
        managerAgentId: "mgr-1",
        emitParentRequestCard: true,
        sourceContext: { channel: "web" },
      },
    });

    await vi.waitFor(() => {
      expect(
        conversationMessages.filter(
          (message) =>
            message.agentId === "mgr-1" && message.externalThreadContext?.type === "codex_app_server",
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });

    const parentCards = conversationMessages.filter(
      (message) => message.agentId === "mgr-1" && message.externalThreadContext?.type === "codex_app_server",
    );
    expect(parentCards.map((message) => message.externalThreadContext?.status)).toEqual(
      expect.arrayContaining(["sent", "completed"]),
    );
    expect(host.emitParentUserToCodexAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        managerAgentId: "mgr-1",
        sidecarAgentId: "mgr-1--codex",
      }),
    );
  });
});
