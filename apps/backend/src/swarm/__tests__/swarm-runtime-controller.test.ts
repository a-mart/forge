import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import { getProfileMemoryPath } from "../data-paths.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import { SwarmRuntimeController, type SwarmRuntimeControllerHost } from "../swarm-runtime-controller.js";
import type { AgentDescriptor, AgentStatus, SwarmConfig } from "../types.js";
import { TestSwarmManager, bootWithDefaultManager } from "../../test-support/index.js";

async function makeTempConfig(port = 8897): Promise<SwarmConfig> {
  const root = await mkdtemp(join(tmpdir(), "swarm-runtime-controller-test-"));
  const dataDir = join(root, "data");
  const swarmDir = join(dataDir, "swarm");
  const sessionsDir = join(dataDir, "sessions");
  const uploadsDir = join(dataDir, "uploads");
  const profilesDir = join(dataDir, "profiles");
  const sharedDir = join(dataDir, "shared");
  const sharedConfigDir = join(sharedDir, "config");
  const sharedCacheDir = join(sharedDir, "cache");
  const sharedStateDir = join(sharedDir, "state");
  const sharedAuthDir = join(sharedConfigDir, "auth");
  const sharedAuthFile = join(sharedAuthDir, "auth.json");
  const sharedSecretsFile = join(sharedConfigDir, "secrets.json");
  const sharedIntegrationsDir = join(sharedConfigDir, "integrations");
  const authDir = join(dataDir, "auth");
  const agentDir = join(dataDir, "agent");
  const managerAgentDir = join(agentDir, "manager");
  const repoArchetypesDir = join(root, ".swarm", "archetypes");
  const memoryDir = join(dataDir, "memory");
  const memoryFile = getProfileMemoryPath(dataDir, "manager");
  const repoMemorySkillFile = join(root, ".swarm", "skills", "memory", "SKILL.md");

  await mkdir(swarmDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(uploadsDir, { recursive: true });
  await mkdir(profilesDir, { recursive: true });
  await mkdir(sharedAuthDir, { recursive: true });
  await mkdir(sharedIntegrationsDir, { recursive: true });
  await mkdir(sharedCacheDir, { recursive: true });
  await mkdir(sharedStateDir, { recursive: true });
  await mkdir(authDir, { recursive: true });
  await mkdir(memoryDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(managerAgentDir, { recursive: true });
  await mkdir(repoArchetypesDir, { recursive: true });

  return {
    host: "127.0.0.1",
    port,
    debug: false,
    isDesktop: false,
    cortexEnabled: true,
    allowNonManagerSubscriptions: false,
    managerId: "manager",
    managerDisplayName: "Manager",
    defaultModel: {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    defaultCwd: root,
    cwdAllowlistRoots: [root, join(root, "worktrees")],
    paths: {
      rootDir: root,
      dataDir,
      swarmDir,
      uploadsDir,
      agentsStoreFile: join(swarmDir, "agents.json"),
      profilesDir,
      sharedDir,
      sharedConfigDir,
      sharedCacheDir,
      sharedStateDir,
      sharedAuthDir,
      sharedAuthFile,
      sharedSecretsFile,
      sharedIntegrationsDir,
      sessionsDir,
      memoryDir,
      authDir,
      authFile: join(authDir, "auth.json"),
      secretsFile: join(dataDir, "secrets.json"),
      agentDir,
      managerAgentDir,
      repoArchetypesDir,
      memoryFile,
      repoMemorySkillFile,
      schedulesFile: getScheduleFilePath(dataDir, "manager")
    }
  };
}

function baseDescriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "role" | "managerId">): AgentDescriptor {
  const now = new Date().toISOString();
  return {
    agentId: overrides.agentId,
    displayName: overrides.displayName ?? overrides.agentId,
    role: overrides.role,
    managerId: overrides.managerId,
    status: overrides.status ?? "idle",
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    cwd: overrides.cwd ?? "/tmp",
    sessionFile: overrides.sessionFile ?? "/tmp/session.jsonl",
    model: overrides.model ?? {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex",
      thinkingLevel: "medium"
    },
    ...overrides
  };
}

function createRuntimeControllerHarness(config: SwarmConfig): {
  host: SwarmRuntimeControllerHost;
  descriptors: Map<string, AgentDescriptor>;
  emitStatus: ReturnType<typeof vi.fn>;
  emitConversationMessage: ReturnType<typeof vi.fn>;
  captureConversationEventFromRuntime: ReturnType<typeof vi.fn>;
  consumePendingManualManagerStopNoticeIfApplicable: ReturnType<typeof vi.fn>;
  stripManagerAbortErrorFromEvent: ReturnType<typeof vi.fn>;
  finalizeWorkerIdleTurn: ReturnType<typeof vi.fn>;
  cortexHandleManagerStatus: ReturnType<typeof vi.fn>;
  applyManagerRuntimeRecyclePolicy: ReturnType<typeof vi.fn>;
  maybeRecoverWorkerWithSpecialistFallback: ReturnType<typeof vi.fn>;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const emitStatus = vi.fn();
  const emitConversationMessage = vi.fn();
  const captureConversationEventFromRuntime = vi.fn();
  const consumePendingManualManagerStopNoticeIfApplicable = vi.fn(() => false);
  const stripManagerAbortErrorFromEvent = vi.fn((event: RuntimeSessionEvent) => event);
  const finalizeWorkerIdleTurn = vi.fn();
  const cortexHandleManagerStatus = vi.fn();
  const applyManagerRuntimeRecyclePolicy = vi.fn(async () => "none" as const);
  const maybeRecoverWorkerWithSpecialistFallback = vi.fn(async () => false);
  const forgeExtensionHost = new ForgeExtensionHost({ dataDir: config.paths.dataDir });

  const host: SwarmRuntimeControllerHost = {
    listAgents: () => Array.from(descriptors.values()),
    getWorkerActivity: () => undefined,
    spawnAgent: vi.fn(),
    killAgent: vi.fn(),
    sendMessage: vi.fn(),
    createSessionFromAgent: vi.fn(),
    publishToUser: vi.fn(async () => ({ targetContext: { channel: "web" as const } })),
    requestUserChoice: vi.fn(),
    config,
    forgeExtensionHost,
    now: () => new Date().toISOString(),
    descriptors,
    workerWatchdogState: new Map(),
    workerStallState: new Map(),
    workerActivityState: new Map(),
    watchdogTimerTokens: new Map(),
    conversationProjector: {
      captureConversationEventFromRuntime,
      emitConversationMessage
    },
    promptService: {
      buildClaudeRuntimeSystemPrompt: vi.fn(async (_d, sp) => sp),
      buildCodexRuntimeSystemPrompt: vi.fn(async (_d, sp) => sp),
      buildAcpRuntimeSystemPrompt: vi.fn(async (_d, sp) => sp)
    },
    secretsEnvService: {
      getCredentialPoolService: vi.fn()
    },
    cortexService: {
      handleManagerStatusTransition: cortexHandleManagerStatus
    },
    getPiModelsJsonPathOrThrow: vi.fn(() => join(config.paths.sharedCacheDir, "pi-models.json")),
    getMemoryRuntimeResources: vi.fn(async () => ({
      memoryContextFile: { path: "/mem", content: "" },
      additionalSkillPaths: []
    })),
    getSwarmContextFiles: vi.fn(async () => []),
    resolveSystemPromptForDescriptor: vi.fn(async () => "prompt"),
    injectWorkerIdentityContext: vi.fn((_d, sp) => sp),
    resolveSpecialistRosterForProfile: vi.fn(async () => []),
    resolveSpecialistFallbackModelForDescriptor: vi.fn(async () => undefined),
    maybeRecoverWorkerWithSpecialistFallback,
    resolveSpawnModelWithCapacityFallback: (m) => m,
    createRuntimeForDescriptor: vi.fn(),
    updateSessionMetaForWorkerDescriptor: vi.fn(),
    refreshSessionMetaStatsBySessionId: vi.fn(),
    refreshSessionMetaStats: vi.fn(),
    maybeRecordModelCapacityBlock: vi.fn(),
    consumePendingManualManagerStopNoticeIfApplicable,
    stripManagerAbortErrorFromEvent,
    getOrCreateWorkerWatchdogState: vi.fn((_agentId: string) => ({
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: false,
      lastFinalizedTurnSeq: null
    })),
    clearWatchdogTimer: vi.fn(),
    removeWorkerFromWatchdogBatchQueues: vi.fn(),
    finalizeWorkerIdleTurn,
    isRuntimeInContextRecovery: vi.fn(() => false),
    incrementSessionCompactionCount: vi.fn(),
    emitConversationMessage,
    emitStatus,
    emitAgentsSnapshot: vi.fn(),
    saveStore: vi.fn(),
    applyManagerRuntimeRecyclePolicy,
    queueVersionedToolMutation: vi.fn(),
    logDebug: vi.fn()
  };

  return {
    host,
    descriptors,
    emitStatus,
    emitConversationMessage,
    captureConversationEventFromRuntime,
    consumePendingManualManagerStopNoticeIfApplicable,
    stripManagerAbortErrorFromEvent,
    finalizeWorkerIdleTurn,
    cortexHandleManagerStatus,
    applyManagerRuntimeRecyclePolicy,
    maybeRecoverWorkerWithSpecialistFallback
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SwarmRuntimeController", () => {
  it("tracks runtime tokens per agent and clears stale tokens without dropping the active token", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const first = controller.allocateRuntimeToken("agent-a");
    const second = controller.allocateRuntimeToken("agent-a");
    expect(first).not.toBe(second);
    expect(controller.getRuntimeToken("agent-a")).toBe(second);

    controller.clearRuntimeToken("agent-a", first);
    expect(controller.getRuntimeToken("agent-a")).toBe(second);

    controller.clearRuntimeToken("agent-a", second);
    expect(controller.getRuntimeToken("agent-a")).toBeUndefined();
  });

  it("detachRuntime ignores stale runtime tokens but still clears bindings for that token", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w1",
      role: "worker",
      managerId: "m1",
      status: "idle"
    });
    descriptors.set(worker.agentId, worker);

    const staleToken = controller.allocateRuntimeToken(worker.agentId);
    const rt = { terminate: vi.fn() } as unknown as SwarmAgentRuntime;
    controller.attachRuntime(worker.agentId, rt);
    const freshToken = controller.allocateRuntimeToken(worker.agentId);

    const deactivateSpy = vi.spyOn(host.forgeExtensionHost, "deactivateRuntimeBindings");

    expect(controller.detachRuntime(worker.agentId, staleToken)).toBe(false);
    expect(controller.runtimes.get(worker.agentId)).toBe(rt);
    expect(controller.getRuntimeToken(worker.agentId)).toBe(freshToken);
    expect(deactivateSpy).toHaveBeenCalled();

    expect(controller.detachRuntime(worker.agentId, freshToken)).toBe(true);
    expect(controller.runtimes.has(worker.agentId)).toBe(false);
  });

  it("routes status updates through emitStatus and persists worker descriptor transitions", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitStatus } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-status",
      role: "worker",
      managerId: "m1",
      status: "idle",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, { ...worker });

    const token = controller.allocateRuntimeToken(worker.agentId);
    await controller.handleRuntimeStatus(token, worker.agentId, "streaming" as AgentStatus, 0, {
      tokens: 1,
      contextWindow: 100,
      percent: 1
    });

    const updated = descriptors.get(worker.agentId);
    expect(updated?.status).toBe("streaming");
    expect(updated?.contextUsage).toEqual({
      tokens: 1,
      contextWindow: 100,
      percent: 1
    });
    expect(emitStatus).toHaveBeenCalledWith(
      worker.agentId,
      "streaming",
      0,
      expect.objectContaining({ tokens: 1 })
    );
  });

  it("surfaces manual manager stop as a neutral system notice and strips abort-shaped assistant errors", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      consumePendingManualManagerStopNoticeIfApplicable,
      stripManagerAbortErrorFromEvent
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "mgr-stop",
      role: "manager",
      managerId: "mgr-stop",
      status: "streaming"
    });
    descriptors.set(manager.agentId, { ...manager });

    consumePendingManualManagerStopNoticeIfApplicable.mockReturnValue(true);
    stripManagerAbortErrorFromEvent.mockImplementation((event: RuntimeSessionEvent) => ({
      ...event,
      message: {
        ...(event as { message: Record<string, unknown> }).message,
        stopReason: "stop"
      }
    }));

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x" }],
        stopReason: "error",
        errorMessage: "Request was aborted"
      }
    };

    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);

    expect(captureConversationEventFromRuntime).toHaveBeenCalled();
    expect(stripManagerAbortErrorFromEvent).toHaveBeenCalled();
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation_message",
        role: "system",
        text: "Session stopped.",
        agentId: manager.agentId
      })
    );
  });

  it("suppresses abort errors during context recovery without emitting a system notice", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      stripManagerAbortErrorFromEvent
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "mgr-compact",
      role: "manager",
      managerId: "mgr-compact",
      status: "streaming"
    });
    descriptors.set(manager.agentId, { ...manager });

    // Simulate context recovery (smart compaction) in progress
    (host.isRuntimeInContextRecovery as ReturnType<typeof vi.fn>).mockReturnValue(true);
    stripManagerAbortErrorFromEvent.mockImplementation((event: RuntimeSessionEvent) => ({
      ...event,
      message: {
        ...(event as { message: Record<string, unknown> }).message,
        stopReason: "stop",
        errorMessage: undefined
      }
    }));

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
        stopReason: "error",
        errorMessage: "Request was aborted."
      }
    };

    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);

    // The abort error should be stripped
    expect(stripManagerAbortErrorFromEvent).toHaveBeenCalled();
    expect(captureConversationEventFromRuntime).toHaveBeenCalledWith(
      manager.agentId,
      expect.objectContaining({
        type: "message_end",
        message: expect.objectContaining({ stopReason: "stop" })
      })
    );
    // No "Session stopped." system notice should be emitted — compaction handles its own messaging
    expect(emitConversationMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "Session stopped."
      })
    );
  });

  it("stores extension snapshots for the current runtime token and lists defensive copies sorted", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-ext",
      role: "worker",
      managerId: "m1",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, worker);

    const token = controller.allocateRuntimeToken(worker.agentId);
    const snapshot: AgentRuntimeExtensionSnapshot = {
      agentId: worker.agentId,
      role: "worker",
      managerId: worker.managerId,
      profileId: "p1",
      loadedAt: "t0",
      extensions: [
        {
          displayName: "A",
          path: "/a",
          resolvedPath: "/a",
          source: "global-worker",
          events: ["e1"],
          tools: ["t1"]
        }
      ],
      loadErrors: [{ path: "/bad", error: "nope" }]
    };

    const snapshotHandler = controller as unknown as {
      handleRuntimeExtensionSnapshot(t: number, id: string, snap: AgentRuntimeExtensionSnapshot): void;
    };
    snapshotHandler.handleRuntimeExtensionSnapshot(token, worker.agentId, snapshot);

    const listed = controller.listRuntimeExtensionSnapshots();
    expect(listed).toHaveLength(1);
    expect(listed[0].extensions[0].events).toEqual(["e1"]);
    listed[0].extensions[0].events.push("mutate");
    expect(controller.listRuntimeExtensionSnapshots()[0].extensions[0].events).toEqual(["e1"]);
  });

  it("suppresses runtime callbacks while intentional stop tokens are registered", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitStatus } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-sup",
      role: "worker",
      managerId: "m1"
    });
    descriptors.set(worker.agentId, worker);

    const token = controller.allocateRuntimeToken(worker.agentId);
    controller.suppressIntentionalStopRuntimeCallbacks(worker.agentId, token);

    await controller.handleRuntimeStatus(token, worker.agentId, "idle" as AgentStatus, 0);
    expect(emitStatus).not.toHaveBeenCalled();

    controller.clearIntentionalStopRuntimeCallbackSuppression(worker.agentId, token);
    await controller.handleRuntimeStatus(token, worker.agentId, "idle" as AgentStatus, 0);
    expect(emitStatus).toHaveBeenCalled();
  });

  it("wires listRuntimeExtensionSnapshots through a booted TestSwarmManager", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    expect(manager.listRuntimeExtensionSnapshots()).toEqual([]);
  });
});
