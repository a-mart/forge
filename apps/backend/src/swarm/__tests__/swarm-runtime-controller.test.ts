import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeExtensionSnapshot } from "@forge/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getScheduleFilePath } from "../../scheduler/schedule-storage.js";
import { AgentDescriptorStore } from "../agents/agent-descriptor-store.js";
import { ForgeExtensionHost } from "../forge-extension-host.js";
import { getProfileMemoryPath } from "../data-paths.js";
import type { RuntimeSessionEvent, SwarmAgentRuntime } from "../runtime-contracts.js";
import {
  SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE,
  type SecureRuntimeBinding,
} from "../secure-sessions/runtime/secure-runtime-binding.js";
import { SwarmRuntimeController, type SwarmRuntimeControllerHost } from "../swarm-runtime-controller.js";
import { createDefaultCompactionRuntimeSettingsProvider } from "../compaction-runtime-settings-provider.js";
import { SwarmWorkerHealthService, TRANSIENT_WORKER_TERMINATED_GRACE_MS } from "../swarm-worker-health-service.js";
import { RuntimeRecoveryState } from "../runtime/runtime-recovery-state.js";
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
      modelId: "gpt-5.5",
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
      modelId: "gpt-5.5",
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
  maybeRecoverWorkerWithSpecialistFallback: ReturnType<typeof vi.fn>;
  deliverTerminalObligationBackstop: ReturnType<typeof vi.fn>;
} {
  const descriptors = new Map<string, AgentDescriptor>();
  const emitStatus = vi.fn();
  const emitConversationMessage = vi.fn();
  const captureConversationEventFromRuntime = vi.fn();
  const consumePendingManualManagerStopNoticeIfApplicable = vi.fn(() => false);
  const stripManagerAbortErrorFromEvent = vi.fn((event: RuntimeSessionEvent) => event);
  const finalizeWorkerIdleTurn = vi.fn();
  const cortexHandleManagerStatus = vi.fn();
  const maybeRecoverWorkerWithSpecialistFallback = vi.fn(async () => false);
  const deliverTerminalObligationBackstop = vi.fn((_agentId: string, _reportText: string) => false);
  const forgeExtensionHost = new ForgeExtensionHost({ dataDir: config.paths.dataDir });
  const runtimeRecoveryState = new RuntimeRecoveryState();

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
    runtimeRecoveryState,
    conversationProjector: {
      captureConversationEventFromRuntime,
      emitConversationMessage
    },
    promptService: {
      buildClaudeRuntimeSystemPrompt: vi.fn(async (_d, sp) => sp),
      buildCursorSdkRuntimeSystemPrompt: vi.fn(async (_d, sp) => sp)
    },
    secretsEnvService: {
      getCredentialPoolService: vi.fn()
    },
    cortexService: {
      handleManagerStatusTransition: cortexHandleManagerStatus
    },
    getPiModelsJsonPathOrThrow: vi.fn(() => join(config.paths.sharedCacheDir, "pi-models.json")),
    getCompactionRuntimeSettingsProvider: () => createDefaultCompactionRuntimeSettingsProvider(),
    getMemoryRuntimeResources: vi.fn(async () => ({
      memoryContextFile: { path: "/mem", content: "" },
      additionalSkillPaths: []
    })),
    getSwarmContextFiles: vi.fn(async () => []),
    resolveProjectExecutableTrustPlanForRuntime: vi.fn(async () => ({
      trusted: false,
      trustedForgeExtensionDirs: [],
      trustedPiExtensionDirs: [],
      trustedPiSettingsPaths: [],
    })),
    maybeRecoverWorkerWithSpecialistFallback,
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
      lastFinalizedTurnSeq: null,
      pendingTransientTerminatedTurnSeq: null,
      pendingTransientTerminatedStartedAtMs: null,
      pendingTransientTerminatedCount: 0
    })),
    clearWatchdogTimer: vi.fn(),
    removeWorkerFromWatchdogBatchQueues: vi.fn(),
    beginPendingTransientWorkerTerminatedError: vi.fn(() => true),
    cancelPendingTransientWorkerTerminatedError: vi.fn(),
    hasPendingTransientWorkerTerminatedError: vi.fn(() => false),
    handleWorkerStatus: vi.fn(async () => undefined),
    finalizeWorkerIdleTurn,
    handleWorkerAgentEnd: finalizeWorkerIdleTurn,
    isRuntimeRecoveryActive: vi.fn(() => false),
    incrementSessionCompactionCount: vi.fn(),
    incrementWorkerCompactionCount: vi.fn(),
    patchDescriptorFromRuntimeStatus: vi.fn(async (agentId: string, patch: Partial<AgentDescriptor>) => {
      const descriptor = descriptors.get(agentId);
      if (!descriptor) {
        return undefined;
      }
      const updated = { ...descriptor, ...patch };
      descriptors.set(agentId, updated);
      return updated;
    }),
    emitConversationMessage,
    emitStatus,
    saveStore: vi.fn(),
    queueVersionedToolMutation: vi.fn(),
    logDebug: vi.fn(),
    markSessionActivity: vi.fn(),
    isModelCacheVisualizationEnabled: vi.fn(() => false),
    emitModelCacheObservation: vi.fn(),
    resolveManagerAssistantFinalOutputTarget: vi.fn((_agentId, activeTarget) => {
      if (activeTarget?.kind === "session_transcript") {
        return activeTarget.channel === "web" ? activeTarget : undefined;
      }
      if (activeTarget?.kind === "explicit_tool_required" && activeTarget.reason === "agent_message") {
        return { kind: "session_transcript", channel: "web", sourceContext: { channel: "web" } };
      }
      return undefined;
    }),
    deliverTerminalObligationBackstop
  };

  return {
    host,
    descriptors,
    emitStatus,
    emitConversationMessage,
    deliverTerminalObligationBackstop,
    captureConversationEventFromRuntime,
    consumePendingManualManagerStopNoticeIfApplicable,
    stripManagerAbortErrorFromEvent,
    finalizeWorkerIdleTurn,
    cortexHandleManagerStatus,
    maybeRecoverWorkerWithSpecialistFallback
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function retainedSecureRuntimeBinding(
  guardMarker = "[guarded-by-retained-binding]",
): SecureRuntimeBinding & { isActive(): boolean } {
  let active = true;
  return {
    isActive: () => active,
    invalidate: () => {
      active = false;
    },
    async executeBash() {
      if (!active) throw new Error("binding invalidated");
      return { exitCode: 0 };
    },
    guardValue<T>(value: T): T {
      if (!active) throw new Error("binding invalidated");
      if (typeof value === "string") return guardMarker as T;
      return JSON.parse(
        JSON.stringify(value).replaceAll(
          "retained-binding-secret",
          guardMarker,
        ),
      ) as T;
    },
  };
}

describe("SwarmRuntimeController", () => {
  it("guards Secure Session events before watchdogs, projection, and observability hooks", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      captureConversationEventFromRuntime,
    } = createRuntimeControllerHarness(config);
    const secret = "runtime-event-secret-canary";
    const recordManagerTurnWatchdogEvent = vi.fn();
    const beforeRuntimeEventProjection = vi.fn();
    const afterRuntimeEventProjection = vi.fn();
    host.recordManagerTurnWatchdogEvent = recordManagerTurnWatchdogEvent;
    host.beforeRuntimeEventProjection = beforeRuntimeEventProjection;
    host.afterRuntimeEventProjection = afterRuntimeEventProjection;
    host.getSecureRuntimeBinding = () => ({
      executeBash: vi.fn(async () => ({ exitCode: 0 })),
      guardValue: <T>(value: T): T =>
        JSON.parse(JSON.stringify(value).replaceAll(secret, "[guarded]")) as T,
    });
    const controller = new SwarmRuntimeController(host);
    const worker = baseDescriptor({
      agentId: "secure-worker",
      role: "worker",
      managerId: "manager",
      status: "streaming",
    });
    descriptors.set(worker.agentId, worker);
    const token = controller.allocateRuntimeToken(worker.agentId);
    const runtimeFactory = (controller as unknown as {
      runtimeFactory: {
        createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
      };
    }).runtimeFactory;
    runtimeFactory.createRuntimeForDescriptor = vi.fn(async () => (
      { descriptor: worker } as unknown as SwarmAgentRuntime
    ));
    await controller.createRuntimeForDescriptor(worker, "prompt", token);

    await controller.handleRuntimeSessionEvent(token, worker.agentId, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "call-1",
      result: { content: `output:${secret}` },
      isError: false,
    });

    for (const sink of [
      recordManagerTurnWatchdogEvent,
      beforeRuntimeEventProjection,
      afterRuntimeEventProjection,
      captureConversationEventFromRuntime,
    ]) {
      expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(sink.mock.calls)).toContain("[guarded]");
    }
  });

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

  it("projects manager assistant output from message_end without waiting for agent_end", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitConversationMessage } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "manager-agent-end-output",
      role: "manager",
      managerId: "manager-agent-end-output",
      status: "streaming",
      profileId: "profile-1",
    });
    descriptors.set(manager.agentId, { ...manager });

    const token = controller.allocateRuntimeToken(manager.agentId);
    controller.activateManagerAssistantOutputTurn(manager.agentId, {
      kind: "session_transcript",
      channel: "web",
      sourceContext: { channel: "web", messageId: "user-message-1" },
    });

    await controller.handleRuntimeSessionEvent(token, manager.agentId, {
      type: "message_end",
      message: { role: "assistant", content: "Callback-only final", stopReason: "stop" },
    });

    expect(emitConversationMessage).toHaveBeenCalledTimes(1);
    expect(emitConversationMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_message",
      agentId: manager.agentId,
      role: "assistant",
      source: "assistant_output",
      sourceContext: { channel: "web", messageId: "user-message-1" },
      text: "Callback-only final",
    }));

    await controller.handleRuntimeAgentEnd(token, manager.agentId);
    expect(emitConversationMessage).toHaveBeenCalledTimes(1);
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

  it("clears an allocated runtime token when factory creation throws", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const worker = baseDescriptor({
      agentId: "w-factory-fail",
      role: "worker",
      managerId: "m1",
      status: "idle"
    });
    descriptors.set(worker.agentId, worker);
    const token = controller.allocateRuntimeToken(worker.agentId);
    const factory = (controller as unknown as {
      runtimeFactory: {
        createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
      };
    }).runtimeFactory;
    factory.createRuntimeForDescriptor = vi.fn(async () => {
      throw new Error("factory boom");
    });

    await expect(controller.createRuntimeForDescriptor(worker, "prompt", token)).rejects.toThrow("factory boom");

    expect(factory.createRuntimeForDescriptor).toHaveBeenCalledWith(worker, "prompt", token, undefined);
    expect(controller.getRuntimeToken(worker.agentId)).toBeUndefined();
  });

  it("rejects required secure runtime creation before invoking an ordinary factory", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const worker = baseDescriptor({
      agentId: "w-secure-required",
      role: "worker",
      managerId: "m1",
      status: "idle",
    });
    descriptors.set(worker.agentId, worker);
    const token = controller.allocateRuntimeToken(worker.agentId);
    const factory = (controller as unknown as {
      runtimeFactory: {
        createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
      };
    }).runtimeFactory;
    factory.createRuntimeForDescriptor = vi.fn();

    await expect(
      controller.createRuntimeForDescriptor(
        worker,
        "prompt",
        token,
        { secureRuntimeRequired: true },
      ),
    ).rejects.toThrow(SECURE_RUNTIME_BINDING_UNAVAILABLE_MESSAGE);

    expect(factory.createRuntimeForDescriptor).not.toHaveBeenCalled();
    expect(controller.getRuntimeToken(worker.agentId)).toBeUndefined();
  });

  it("ties secure runtime usability to the exact attached runtime", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const worker = baseDescriptor({
      agentId: "w-secure-identity",
      role: "worker",
      managerId: "m1",
      status: "idle",
    });
    descriptors.set(worker.agentId, worker);
    const binding = retainedSecureRuntimeBinding();
    host.getSecureRuntimeBinding = () => binding;
    const secureRuntime = { descriptor: worker } as unknown as SwarmAgentRuntime;
    const otherRuntime = { descriptor: worker } as unknown as SwarmAgentRuntime;
    const factory = (controller as unknown as {
      runtimeFactory: {
        createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
      };
    }).runtimeFactory;
    factory.createRuntimeForDescriptor = vi.fn(async () => secureRuntime);
    const token = controller.allocateRuntimeToken(worker.agentId);

    await controller.createRuntimeForDescriptor(
      worker,
      "prompt",
      token,
      { secureRuntimeRequired: true },
    );
    controller.attachRuntime(worker.agentId, secureRuntime);

    expect(controller.isSecureRuntimeBindingUsable(
      worker.agentId,
      otherRuntime,
    )).toBe(false);
    expect(controller.isSecureRuntimeBindingUsable(
      worker.agentId,
      secureRuntime,
    )).toBe(true);

    binding.invalidate?.();
    expect(controller.isSecureRuntimeBindingUsable(
      worker.agentId,
      secureRuntime,
    )).toBe(false);
  });

  it.each(["detach", "clear"] as const)(
    "%s permanently invalidates a retained secure binding without an assignment change",
    async (lifecycleAction) => {
      const config = await makeTempConfig();
      await writeFile(
        join(config.paths.sharedCacheDir, "pi-models.json"),
        "{}",
        "utf8",
      );
      const { host, descriptors } = createRuntimeControllerHarness(config);
      const controller = new SwarmRuntimeController(host);
      const worker = baseDescriptor({
        agentId: `secure-${lifecycleAction}-worker`,
        role: "worker",
        managerId: "manager",
        status: "idle",
        workerParentContext: {
          schemaVersion: 1,
          assignmentId: "unchanged-assignment",
          managerId: "manager",
          assignedAt: "2026-07-24T00:00:00.000Z",
          outputTarget: { kind: "manager" },
        },
      });
      descriptors.set(worker.agentId, worker);
      const retainedBinding = retainedSecureRuntimeBinding();
      host.getSecureRuntimeBinding = () => retainedBinding;
      const runtime = { terminate: vi.fn() } as unknown as SwarmAgentRuntime;
      const factory = (controller as unknown as {
        runtimeFactory: {
          createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
        };
      }).runtimeFactory;
      factory.createRuntimeForDescriptor = vi.fn(async () => runtime);
      const token = controller.allocateRuntimeToken(worker.agentId);

      await controller.createRuntimeForDescriptor(worker, "prompt", token);
      controller.attachRuntime(worker.agentId, runtime);
      await expect(retainedBinding.executeBash({
        command: "safe-before-lifecycle-change",
        cwd: worker.cwd,
        onData: () => undefined,
      })).resolves.toEqual({ exitCode: 0 });

      if (lifecycleAction === "detach") {
        expect(controller.detachRuntime(worker.agentId, token)).toBe(true);
      } else {
        controller.clearRuntimeToken(worker.agentId, token);
      }

      expect(worker.workerParentContext?.assignmentId).toBe(
        "unchanged-assignment",
      );
      expect(retainedBinding.isActive()).toBe(false);
      await expect(retainedBinding.executeBash({
        command: "must-not-run-after-lifecycle-change",
        cwd: worker.cwd,
        onData: () => undefined,
      })).rejects.toThrow("binding invalidated");
    },
  );

  it("failed runtime replacement invalidates only the new binding and preserves the restored fallback binding", async () => {
    const config = await makeTempConfig();
    await writeFile(
      join(config.paths.sharedCacheDir, "pi-models.json"),
      "{}",
      "utf8",
    );
    const {
      host,
      descriptors,
      captureConversationEventFromRuntime,
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const worker = baseDescriptor({
      agentId: "secure-fallback-worker",
      role: "worker",
      managerId: "manager",
      status: "streaming",
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "fallback-assignment",
        managerId: "manager",
        assignedAt: "2026-07-24T00:00:00.000Z",
        outputTarget: { kind: "manager" },
      },
    });
    descriptors.set(worker.agentId, worker);
    const oldBinding = retainedSecureRuntimeBinding("[guarded-by-old-binding]");
    const replacementBinding = retainedSecureRuntimeBinding(
      "[guarded-by-failed-replacement]",
    );
    const oldToken = controller.allocateRuntimeToken(worker.agentId);
    host.getSecureRuntimeBinding = (_descriptor, runtimeToken) =>
      runtimeToken === oldToken ? oldBinding : replacementBinding;
    const oldRuntime = { terminate: vi.fn() } as unknown as SwarmAgentRuntime;
    const factory = (controller as unknown as {
      runtimeFactory: {
        createRuntimeForDescriptor: ReturnType<typeof vi.fn>;
      };
    }).runtimeFactory;
    factory.createRuntimeForDescriptor = vi.fn(async () => oldRuntime);
    await controller.createRuntimeForDescriptor(worker, "old prompt", oldToken);
    controller.attachRuntime(worker.agentId, oldRuntime);

    const replacementToken = controller.allocateRuntimeToken(worker.agentId);
    factory.createRuntimeForDescriptor = vi.fn(async () => {
      throw new Error("replacement factory failed");
    });
    await expect(controller.createRuntimeForDescriptor(
      worker,
      "replacement prompt",
      replacementToken,
    )).rejects.toThrow("replacement factory failed");

    expect(replacementBinding.isActive()).toBe(false);
    expect(oldBinding.isActive()).toBe(true);
    expect(controller.runtimes.get(worker.agentId)).toBe(oldRuntime);
    expect(controller.getRuntimeToken(worker.agentId)).toBeUndefined();

    controller.restoreRuntimeTokenForFallbackRollback(
      worker.agentId,
      oldToken,
    );
    expect(controller.getRuntimeToken(worker.agentId)).toBe(oldToken);
    await expect(oldBinding.executeBash({
      command: "fallback-binding-still-usable",
      cwd: worker.cwd,
      onData: () => undefined,
    })).resolves.toEqual({ exitCode: 0 });

    await controller.handleRuntimeSessionEvent(oldToken, worker.agentId, {
      type: "tool_execution_end",
      toolName: "bash",
      toolCallId: "fallback-tool-call",
      result: { content: "retained-binding-secret" },
      isError: false,
    });
    expect(JSON.stringify(captureConversationEventFromRuntime.mock.calls))
      .not.toContain("retained-binding-secret");
    expect(JSON.stringify(captureConversationEventFromRuntime.mock.calls))
      .toContain("[guarded-by-old-binding]");
  });

  it("keeps manager idle status projection independent from runtime replacement", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitStatus } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const manager = baseDescriptor({
      agentId: "m-idle-recycle",
      role: "manager",
      managerId: "m-idle-recycle",
      profileId: "m-idle-recycle",
      status: "streaming"
    });
    descriptors.set(manager.agentId, manager);
    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeStatus(token, manager.agentId, "idle", 0);

    expect(host.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      manager.agentId,
      expect.objectContaining({ status: "idle" })
    );
    expect(vi.mocked(host.refreshSessionMetaStats).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ agentId: manager.agentId })
    );
    expect(host.saveStore).toHaveBeenCalledTimes(1);
    expect(emitStatus).toHaveBeenCalledWith(manager.agentId, "idle", 0, undefined);

    const patchOrder = vi.mocked(host.patchDescriptorFromRuntimeStatus).mock.invocationCallOrder[0];
    const statsOrder = vi.mocked(host.refreshSessionMetaStats).mock.invocationCallOrder[0];
    const firstSaveOrder = vi.mocked(host.saveStore).mock.invocationCallOrder[0];
    const emitStatusOrder = emitStatus.mock.invocationCallOrder[0];

    expect(patchOrder).toBeLessThan(statsOrder);
    expect(statsOrder).toBeLessThan(firstSaveOrder);
    expect(firstSaveOrder).toBeLessThan(emitStatusOrder);
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

    expect(host.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ status: "streaming", contextUsage: expect.objectContaining({ tokens: 1 }) })
    );
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
    expect(host.handleWorkerStatus).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ status: "streaming" }),
      "streaming",
      0
    );
    const metaOrder = vi.mocked(host.updateSessionMetaForWorkerDescriptor).mock.invocationCallOrder[0];
    const statsOrder = vi.mocked(host.refreshSessionMetaStatsBySessionId).mock.invocationCallOrder[0];
    const saveOrder = vi.mocked(host.saveStore).mock.invocationCallOrder[0];
    const emitOrder = emitStatus.mock.invocationCallOrder[0];
    expect(metaOrder).toBeLessThan(statsOrder);
    expect(statsOrder).toBeLessThan(saveOrder);
    expect(saveOrder).toBeLessThan(emitOrder);
  });

  it("manager runtime-status host patch delegates through the descriptor-store live-map adapter without saving", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    const rootSession = await bootWithDefaultManager(manager, config);
    const patchSpy = vi.spyOn(AgentDescriptorStore.prototype, "patchDescriptorInLiveMaps");
    const persistedBefore = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };

    const updated = await (manager as unknown as {
      patchDescriptorFromRuntimeStatus: (
        agentId: string,
        patch: Partial<AgentDescriptor>
      ) => Promise<AgentDescriptor | undefined>;
    }).patchDescriptorFromRuntimeStatus(rootSession.agentId, {
      status: "streaming",
      contextUsage: { tokens: 3, contextWindow: 100, percent: 3 }
    });

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ descriptors: expect.any(Map), profiles: expect.any(Map) }),
      rootSession.agentId,
      expect.objectContaining({ status: "streaming" })
    );
    expect(updated?.status).toBe("streaming");
    expect(manager.getAgent(rootSession.agentId)?.status).toBe("streaming");
    const persistedAfter = JSON.parse(await readFile(config.paths.agentsStoreFile, "utf8")) as { agents: AgentDescriptor[] };
    expect(persistedAfter).toEqual(persistedBefore);
  });

  it("ignores stale runtime tokens for status, session events, runtime errors, and agent end", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitStatus,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      finalizeWorkerIdleTurn,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-stale-callbacks",
      role: "worker",
      managerId: "m1",
      status: "idle",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, { ...worker });

    const staleToken = controller.allocateRuntimeToken(worker.agentId);
    const currentToken = controller.allocateRuntimeToken(worker.agentId);
    expect(currentToken).not.toBe(staleToken);

    const sessionEvent: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "stale" }],
        stopReason: "stop"
      }
    };

    await controller.handleRuntimeStatus(staleToken, worker.agentId, "streaming" as AgentStatus, 0, {
      tokens: 10,
      contextWindow: 100,
      percent: 10
    });
    await controller.handleRuntimeSessionEvent(staleToken, worker.agentId, sessionEvent);
    await controller.handleRuntimeError(staleToken, worker.agentId, {
      phase: "prompt_start",
      message: "stale failure"
    });
    await controller.handleRuntimeAgentEnd(staleToken, worker.agentId);

    expect(descriptors.get(worker.agentId)).toEqual(expect.objectContaining({ status: "idle" }));
    expect(descriptors.get(worker.agentId)?.contextUsage).toBeUndefined();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalled();
    expect(finalizeWorkerIdleTurn).not.toHaveBeenCalled();
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(host.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(host.getOrCreateWorkerWatchdogState).not.toHaveBeenCalled();
    expect(host.workerWatchdogState.has(worker.agentId)).toBe(false);
    expect(host.workerStallState.has(worker.agentId)).toBe(false);
    expect(host.workerActivityState.has(worker.agentId)).toBe(false);
  });

  it("applies only current runtime token callbacks once after stale callbacks are ignored", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitStatus,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      finalizeWorkerIdleTurn
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-current-once",
      role: "worker",
      managerId: "m1",
      status: "idle",
      profileId: "p1"
    });
    const endingWorker = baseDescriptor({
      agentId: "w-current-agent-end-once",
      role: "worker",
      managerId: "m1",
      status: "streaming",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, { ...worker });
    descriptors.set(endingWorker.agentId, { ...endingWorker });

    const staleToken = controller.allocateRuntimeToken(worker.agentId);
    const currentToken = controller.allocateRuntimeToken(worker.agentId);
    const staleEndToken = controller.allocateRuntimeToken(endingWorker.agentId);
    const currentEndToken = controller.allocateRuntimeToken(endingWorker.agentId);
    const sessionEvent: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop"
      }
    };

    await controller.handleRuntimeSessionEvent(staleToken, worker.agentId, sessionEvent);
    await controller.handleRuntimeSessionEvent(currentToken, worker.agentId, sessionEvent);
    await controller.handleRuntimeError(staleToken, worker.agentId, {
      phase: "prompt_dispatch",
      message: "stale failure"
    });
    await controller.handleRuntimeError(currentToken, worker.agentId, {
      phase: "extension",
      message: "current failure"
    });
    await controller.handleRuntimeStatus(staleToken, worker.agentId, "streaming" as AgentStatus, 0);
    await controller.handleRuntimeStatus(currentToken, worker.agentId, "streaming" as AgentStatus, 0);
    await controller.handleRuntimeAgentEnd(staleEndToken, endingWorker.agentId);
    await controller.handleRuntimeAgentEnd(currentEndToken, endingWorker.agentId);

    expect(captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, sessionEvent);
    expect(emitConversationMessage).toHaveBeenCalledTimes(2);
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: worker.managerId,
        role: "system",
        source: "worker_report",
        sourceWorkerId: worker.agentId,
        excludeFromModelContext: true,
        text: "done",
      }),
      expect.objectContaining({
        routingReceipt: expect.objectContaining({
          decision: "route",
          reasonCode: "route:worker_result_all_view",
          sourceWorkerId: worker.agentId,
        }),
      }),
    );
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: worker.agentId,
        role: "system",
        text: "⚠️ Extension error: current failure"
      })
    );
    expect(emitStatus).toHaveBeenCalledTimes(1);
    expect(emitStatus).toHaveBeenCalledWith(worker.agentId, "streaming", 0, undefined);
    expect(finalizeWorkerIdleTurn).toHaveBeenCalledTimes(1);
    expect(finalizeWorkerIdleTurn).toHaveBeenCalledWith(
      endingWorker.agentId,
      expect.objectContaining({ agentId: endingWorker.agentId })
    );
    expect(host.maybeRecordModelCapacityBlock).toHaveBeenCalledTimes(1);
    expect(host.maybeRecordModelCapacityBlock).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ agentId: worker.agentId }),
      expect.objectContaining({ message: "current failure" })
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

  it("admits one invalidated manager token message_end so manual stop notice survives slow worker teardown", async () => {
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
      agentId: "mgr-stop-invalidated-token",
      role: "manager",
      managerId: "mgr-stop-invalidated-token",
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

    const token = controller.allocateRuntimeToken(manager.agentId);
    controller.allowInvalidatedManualStopMessageEnd(manager.agentId, token);
    controller.clearRuntimeToken(manager.agentId);

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "Request was aborted"
      }
    };

    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);
    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);

    expect(captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(stripManagerAbortErrorFromEvent).toHaveBeenCalledTimes(1);
    expect(emitConversationMessage).toHaveBeenCalledTimes(1);
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation_message",
        role: "system",
        text: "Session stopped.",
        agentId: manager.agentId
      })
    );
  });

  it("admits invalidated manager token message_end after shutdown timeout cleanup", async () => {
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
      agentId: "mgr-stop-timeout-late-end",
      role: "manager",
      managerId: "mgr-stop-timeout-late-end",
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

    const token = controller.allocateRuntimeToken(manager.agentId);
    let resolveShutdown: (() => void) | undefined;
    const neverSettlingShutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    expect(resolveShutdown).toBeTypeOf("function");
    controller.attachRuntime(manager.agentId, {
      getStatus: vi.fn(() => "streaming"),
      stopInFlight: vi.fn(() => neverSettlingShutdown)
    } as unknown as SwarmAgentRuntime);
    controller.allowInvalidatedManualStopMessageEnd(manager.agentId, token);

    const shutdownResult = controller.runRuntimeShutdown(manager, "stopInFlight", {
      abort: true,
      shutdownTimeoutMs: 1,
      drainTimeoutMs: 1
    });
    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(true);
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).toThrow(
      /runtime is stopping.*wait for it to finish/i,
    );

    await expect(shutdownResult).resolves.toEqual({ timedOut: true, runtimeToken: token });
    expect(controller.runtimes.has(manager.agentId)).toBe(false);
    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(true);
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).toThrow(
      /did not stop cleanly.*restart Forge/i,
    );

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "Request was aborted"
      }
    };

    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);

    expect(captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(stripManagerAbortErrorFromEvent).toHaveBeenCalledTimes(1);
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "conversation_message",
        role: "system",
        text: "Session stopped.",
        agentId: manager.agentId
      })
    );

    resolveShutdown?.();
    await vi.waitFor(() => {
      expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(false);
    });
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).not.toThrow();
  });

  it("blocks concurrent runtime reuse while a clean shutdown is still in progress", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const manager = baseDescriptor({
      agentId: "mgr-clean-shutdown-in-progress",
      role: "manager",
      managerId: "mgr-clean-shutdown-in-progress",
      status: "streaming",
    });
    descriptors.set(manager.agentId, manager);

    const token = controller.allocateRuntimeToken(manager.agentId);
    let resolveShutdown: (() => void) | undefined;
    const shutdown = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const runtime = {
      getStatus: vi.fn(() => "streaming"),
      stopInFlight: vi.fn(() => shutdown),
    } as unknown as SwarmAgentRuntime;
    controller.attachRuntime(manager.agentId, runtime);

    let continueAdmittedDispatch: (() => void) | undefined;
    const admittedDispatch = controller.withRuntimeAdmission(manager.agentId, async () => {
      await new Promise<void>((resolve) => {
        continueAdmittedDispatch = resolve;
      });
      expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).not.toThrow();
    });
    controller.prepareRuntimeShutdown(manager.agentId);
    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(true);
    const shutdownResult = controller.runRuntimeShutdown(manager, "stopInFlight", {
      abort: true,
      shutdownTimeoutMs: 1_000,
      drainTimeoutMs: 1,
    });

    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(true);
    await expect(controller.withRuntimeAdmission(manager.agentId, async () => {})).rejects.toThrow(
      /runtime is stopping.*wait for it to finish/i,
    );
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).toThrow(
      /runtime is stopping.*wait for it to finish/i,
    );
    expect(runtime.stopInFlight).not.toHaveBeenCalled();

    continueAdmittedDispatch?.();
    await admittedDispatch;
    await vi.waitFor(() => expect(runtime.stopInFlight).toHaveBeenCalledTimes(1));

    resolveShutdown?.();
    await expect(shutdownResult).resolves.toEqual({ timedOut: false, runtimeToken: token });
    expect(controller.runtimes.has(manager.agentId)).toBe(false);
    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(false);
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).not.toThrow();
  });

  it("keeps a failed late shutdown quarantined so a replacement cannot share the session file", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);
    const manager = baseDescriptor({
      agentId: "mgr-stop-timeout-failed-late-shutdown",
      role: "manager",
      managerId: "mgr-stop-timeout-failed-late-shutdown",
      status: "streaming",
    });
    descriptors.set(manager.agentId, manager);

    const token = controller.allocateRuntimeToken(manager.agentId);
    let rejectShutdown: ((error: Error) => void) | undefined;
    const shutdown = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    controller.attachRuntime(manager.agentId, {
      getStatus: vi.fn(() => "streaming"),
      terminate: vi.fn(() => shutdown),
    } as unknown as SwarmAgentRuntime);

    await expect(controller.runRuntimeShutdown(manager, "terminate", {
      abort: true,
      shutdownTimeoutMs: 1,
      drainTimeoutMs: 1,
    })).resolves.toEqual({ timedOut: true, runtimeToken: token });

    rejectShutdown?.(new Error("terminate_abort timed out after 1500ms"));
    await Promise.resolve();
    expect(controller.isRuntimeShutdownQuarantined(manager.agentId)).toBe(true);
    expect(() => controller.assertRuntimeCreationAllowed(manager.agentId)).toThrow(
      /did not stop cleanly.*restart Forge/i,
    );
    expect(controller.runtimes.has(manager.agentId)).toBe(false);
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

    // Simulate context recovery grace/active window (smart compaction) in progress
    (host.isRuntimeRecoveryActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
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

  it("suppresses aborted stopReason plus abort errorMessage during context recovery", async () => {
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
      agentId: "mgr-compact-aborted",
      role: "manager",
      managerId: "mgr-compact-aborted",
      status: "streaming"
    });
    descriptors.set(manager.agentId, { ...manager });

    (host.isRuntimeRecoveryActive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    stripManagerAbortErrorFromEvent.mockImplementation((event: RuntimeSessionEvent) => {
      const { errorMessage: _errorMessage, ...message } = (event as { message: Record<string, unknown> }).message;
      return {
        ...event,
        message: {
          ...message,
          stopReason: "stop"
        }
      };
    });

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
        stopReason: "aborted",
        errorMessage: "Request was aborted"
      }
    };

    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeSessionEvent(token, manager.agentId, event);

    expect(stripManagerAbortErrorFromEvent).toHaveBeenCalled();
    expect(captureConversationEventFromRuntime).toHaveBeenCalledWith(
      manager.agentId,
      expect.objectContaining({
        type: "message_end",
        message: expect.not.objectContaining({ errorMessage: expect.anything() })
      })
    );
    expect(emitConversationMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "Session stopped."
      })
    );
  });

  it("counts context-guard compaction success through the runtime error projector", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitConversationMessage } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "mgr-context-guard-success",
      role: "manager",
      managerId: "mgr-context-guard-success",
      profileId: "profile-1",
      status: "streaming",
      compactionCount: 0
    });
    descriptors.set(manager.agentId, { ...manager });
    vi.mocked(host.incrementSessionCompactionCount).mockResolvedValue(1);

    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeError(token, manager.agentId, {
      phase: "compaction",
      message: "Context compacted by context guard",
      details: {
        recoveryStage: "context_guard_compaction_succeeded",
        userFacingMessage: "Context recovered and compacted."
      }
    });

    expect(host.incrementSessionCompactionCount).toHaveBeenCalledWith(
      "profile-1",
      manager.agentId,
      "runtime:compact:count-increment-failed"
    );
    expect(host.patchDescriptorFromRuntimeStatus).toHaveBeenCalledWith(manager.agentId, { compactionCount: 1 });
    expect(emitConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        text: "Context recovered and compacted."
      })
    );
  });

  it("finalizes a normal worker completion during parent recovery instead of dropping it", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      captureConversationEventFromRuntime,
      finalizeWorkerIdleTurn,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "mgr-normal-recovery",
      role: "manager",
      managerId: "mgr-normal-recovery",
      status: "streaming"
    });
    const worker = baseDescriptor({
      agentId: "worker-normal-recovery",
      role: "worker",
      managerId: manager.agentId,
      status: "streaming"
    });
    descriptors.set(manager.agentId, manager);
    descriptors.set(worker.agentId, worker);
    (host.isRuntimeRecoveryActive as ReturnType<typeof vi.fn>).mockImplementation(
      (agentId: string) => agentId === manager.agentId
    );
    host.workerWatchdogState.set(worker.agentId, {
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: true,
      lastFinalizedTurnSeq: null
    });

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "completed normally" }],
        stopReason: "stop"
      }
    };

    const token = controller.allocateRuntimeToken(worker.agentId);
    await controller.handleRuntimeSessionEvent(token, worker.agentId, event);
    await controller.handleRuntimeStatus(token, worker.agentId, "idle", 0);
    await controller.handleRuntimeAgentEnd(token, worker.agentId);

    expect(captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, event);
    expect(finalizeWorkerIdleTurn).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ agentId: worker.agentId })
    );
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
  });

  it("defers bare terminated worker idle finalization across status-idle and agent_end until transient expiry", async () => {
    vi.useFakeTimers();
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, captureConversationEventFromRuntime } = createRuntimeControllerHarness(config);

    const manager = baseDescriptor({
      agentId: "mgr-transient-controller",
      role: "manager",
      managerId: "mgr-transient-controller",
      status: "idle"
    });
    const worker = baseDescriptor({
      agentId: "worker-transient-controller",
      role: "worker",
      managerId: manager.agentId,
      status: "streaming",
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment:worker-transient-controller",
        managerId: manager.agentId,
        assignedAt: "2026-07-16T12:00:00.000Z",
        outputTarget: { kind: "internal_only" }
      }
    });
    descriptors.set(manager.agentId, manager);
    descriptors.set(worker.agentId, worker);

    const deliverCompletedWorker = vi.fn(async () => "sent" as const);
    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes: new Map(),
      workerResults: { deliverCompletedWorker } as any,
      sendMessage: vi.fn(async () => ({})),
      publishToUser: vi.fn(async () => ({})),
      terminateDescriptor: vi.fn(async () => undefined),
      saveStore: vi.fn(async () => undefined),
      emitAgentsSnapshot: vi.fn(),
      isRuntimeInContextRecovery: vi.fn(() => false),
      isRuntimeRecoveryActive: vi.fn(() => false),
      now: () => "2026-07-16T12:01:00.000Z",
      logDebug: vi.fn()
    });
    host.beginPendingTransientWorkerTerminatedError = vi.fn((agentId, event, expire) =>
      health.beginPendingTransientWorkerTerminatedError(agentId, event, expire)
    );
    host.cancelPendingTransientWorkerTerminatedError = vi.fn((agentId, reason) =>
      health.cancelPendingTransientWorkerTerminatedError(agentId, reason)
    );
    host.hasPendingTransientWorkerTerminatedError = vi.fn((agentId) => health.hasPendingTransientWorkerTerminatedError(agentId));
    host.handleWorkerAgentEnd = vi.fn((agentId, descriptor) =>
      health.handleRuntimeAgentEnd(agentId, descriptor)
    );

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "terminated" }
    };

    const controller = new SwarmRuntimeController(host);
    const token = controller.allocateRuntimeToken(worker.agentId);
    await controller.handleRuntimeSessionEvent(token, worker.agentId, event);
    worker.status = "idle";
    await controller.handleRuntimeStatus(token, worker.agentId, "idle", 0);
    await controller.handleRuntimeAgentEnd(token, worker.agentId);

    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(host.handleWorkerAgentEnd).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ agentId: worker.agentId }),
    );
    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);
    expect(captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(captureConversationEventFromRuntime).toHaveBeenCalledWith(worker.agentId, event);
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("marks abort-like worker output during parent recovery and routes agent_end to worker health", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      captureConversationEventFromRuntime,
      emitConversationMessage,
      finalizeWorkerIdleTurn,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "mgr-recovery",
      role: "manager",
      managerId: "mgr-recovery",
      status: "streaming"
    });
    const worker = baseDescriptor({
      agentId: "worker-recovery",
      role: "worker",
      managerId: manager.agentId,
      status: "streaming"
    });
    descriptors.set(manager.agentId, manager);
    descriptors.set(worker.agentId, worker);
    (host.isRuntimeRecoveryActive as ReturnType<typeof vi.fn>).mockImplementation(
      (agentId: string) => agentId === manager.agentId
    );

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "Request was aborted."
      }
    };

    host.workerWatchdogState.set(worker.agentId, {
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: true,
      lastFinalizedTurnSeq: null
    });

    const token = controller.allocateRuntimeToken(worker.agentId);
    await controller.handleRuntimeSessionEvent(token, worker.agentId, event);
    await controller.handleRuntimeStatus(token, worker.agentId, "idle", 0);
    await controller.handleRuntimeAgentEnd(token, worker.agentId);

    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalled();
    expect(finalizeWorkerIdleTurn).toHaveBeenCalledWith(
      worker.agentId,
      expect.objectContaining({ agentId: worker.agentId, status: "idle" }),
    );
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(host.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(host.runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(worker.agentId)).toBe(true);
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

  it("buffers status during specialist fallback handoff before normal status processing", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitStatus, finalizeWorkerIdleTurn } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-fallback-status",
      role: "worker",
      managerId: "m1",
      status: "idle",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, worker);

    const oldToken = controller.allocateRuntimeToken(worker.agentId);
    const replacementToken = controller.allocateRuntimeToken(worker.agentId);
    controller.beginFallbackHandoff(worker.agentId, oldToken);

    await controller.handleRuntimeStatus(oldToken, worker.agentId, "streaming" as AgentStatus, 3, {
      tokens: 10,
      contextWindow: 100,
      percent: 10
    });

    expect(controller.getFallbackHandoffSnapshot(worker.agentId, oldToken)?.bufferedStatus).toMatchObject({
      status: "streaming",
      pendingCount: 3,
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 }
    });
    expect(host.patchDescriptorFromRuntimeStatus).not.toHaveBeenCalled();
    expect(host.updateSessionMetaForWorkerDescriptor).not.toHaveBeenCalled();
    expect(host.refreshSessionMetaStatsBySessionId).not.toHaveBeenCalled();
    expect(host.saveStore).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(finalizeWorkerIdleTurn).not.toHaveBeenCalled();
    expect(host.workerStallState.has(worker.agentId)).toBe(false);
    expect(host.workerActivityState.has(worker.agentId)).toBe(false);
    expect(host.workerWatchdogState.has(worker.agentId)).toBe(false);
    expect(host.watchdogTimerTokens.has(worker.agentId)).toBe(false);
    expect(host.clearWatchdogTimer).not.toHaveBeenCalled();
    expect(host.removeWorkerFromWatchdogBatchQueues).not.toHaveBeenCalled();

    await controller.handleRuntimeStatus(replacementToken, worker.agentId, "streaming" as AgentStatus, 0);

    expect(controller.getFallbackHandoffSnapshot(worker.agentId, oldToken)?.bufferedStatus?.pendingCount).toBe(3);
    expect(host.patchDescriptorFromRuntimeStatus).toHaveBeenCalled();
    expect(emitStatus).toHaveBeenCalledWith(worker.agentId, "streaming", 0, undefined);
  });

  it("buffers agent_end during specialist fallback handoff before worker finalization", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitStatus,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      finalizeWorkerIdleTurn,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-fallback-end",
      role: "worker",
      managerId: "m1",
      status: "streaming",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, worker);

    const oldToken = controller.allocateRuntimeToken(worker.agentId);
    const replacementToken = controller.allocateRuntimeToken(worker.agentId);
    controller.beginFallbackHandoff(worker.agentId, oldToken);

    await controller.handleRuntimeAgentEnd(oldToken, worker.agentId);

    expect(controller.getFallbackHandoffSnapshot(worker.agentId, oldToken)?.receivedAgentEnd).toBe(true);
    expect(finalizeWorkerIdleTurn).not.toHaveBeenCalled();
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalled();

    await controller.handleRuntimeAgentEnd(replacementToken, worker.agentId);

    expect(controller.getFallbackHandoffSnapshot(worker.agentId, oldToken)?.receivedAgentEnd).toBe(true);
    expect(finalizeWorkerIdleTurn).toHaveBeenCalledWith(worker.agentId, worker);
  });

  it("suppresses old-runtime session events, errors, and extension snapshots while fallback owns the token", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-fallback-suppressed",
      role: "worker",
      managerId: "m1",
      status: "streaming",
      profileId: "p1"
    });
    descriptors.set(worker.agentId, worker);

    const oldToken = controller.allocateRuntimeToken(worker.agentId);
    const replacementToken = controller.allocateRuntimeToken(worker.agentId);
    controller.beginFallbackHandoff(worker.agentId, oldToken);
    const dispatchRuntimeError = vi.spyOn(host.forgeExtensionHost, "dispatchRuntimeError");

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        errorMessage: "terminated",
        stopReason: "error"
      }
    };
    const oldSnapshot: AgentRuntimeExtensionSnapshot = {
      agentId: worker.agentId,
      role: "worker",
      managerId: worker.managerId,
      profileId: worker.profileId,
      loadedAt: "suppressed",
      extensions: [],
      loadErrors: []
    };
    const freshSnapshot: AgentRuntimeExtensionSnapshot = {
      ...oldSnapshot,
      loadedAt: "fresh"
    };
    const snapshotHandler = controller as unknown as {
      handleRuntimeExtensionSnapshot(t: number, id: string, snap: AgentRuntimeExtensionSnapshot): void;
    };

    await controller.handleRuntimeSessionEvent(oldToken, worker.agentId, event);
    await controller.handleRuntimeError(oldToken, worker.agentId, {
      phase: "prompt_start",
      message: "rate limit exceeded"
    });
    snapshotHandler.handleRuntimeExtensionSnapshot(oldToken, worker.agentId, oldSnapshot);

    expect(controller.getFallbackHandoffSnapshot(worker.agentId, oldToken)).toBeDefined();
    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(host.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(host.beginPendingTransientWorkerTerminatedError).not.toHaveBeenCalled();
    expect(dispatchRuntimeError).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalled();
    expect(controller.listRuntimeExtensionSnapshots()).toEqual([]);

    snapshotHandler.handleRuntimeExtensionSnapshot(replacementToken, worker.agentId, freshSnapshot);

    expect(controller.listRuntimeExtensionSnapshots()).toEqual([freshSnapshot]);
  });

  it("defers transient terminated idle finalization through status idle and agent_end until expiry", async () => {
    vi.useFakeTimers();
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, captureConversationEventFromRuntime } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      status: "idle",
      profileId: "p1"
    });
    const worker = baseDescriptor({
      agentId: "w-transient-controller",
      role: "worker",
      managerId: "m1",
      status: "streaming",
      profileId: "p1",
      workerParentContext: {
        schemaVersion: 1,
        assignmentId: "assignment:w-transient-controller",
        managerId: "m1",
        assignedAt: "2026-07-16T12:00:00.000Z",
        outputTarget: { kind: "internal_only" }
      }
    });
    descriptors.set(manager.agentId, manager);
    descriptors.set(worker.agentId, worker);

    const runtimeStub = {
      getStatus: () => "idle",
      getPendingCount: () => 0
    } as SwarmAgentRuntime;
    controller.runtimes.set(manager.agentId, runtimeStub);
    controller.runtimes.set(worker.agentId, runtimeStub);

    const deliverCompletedWorker = vi.fn(async () => "sent" as const);
    const health = new SwarmWorkerHealthService({
      descriptors,
      runtimes: controller.runtimes,
      workerResults: { deliverCompletedWorker } as any,
      sendMessage: vi.fn(async () => ({})),
      publishToUser: vi.fn(async () => ({})),
      terminateDescriptor: vi.fn(async () => {}),
      saveStore: vi.fn(async () => {}),
      emitAgentsSnapshot: vi.fn(),
      isRuntimeInContextRecovery: vi.fn(() => false),
      isRuntimeRecoveryActive: vi.fn(() => false),
      now: () => "2026-07-16T12:01:00.000Z",
      logDebug: vi.fn()
    });
    host.workerStallState = health.workerStallState;
    host.workerActivityState = health.workerActivityState;
    host.beginPendingTransientWorkerTerminatedError = (agentId, event, expire) =>
      health.beginPendingTransientWorkerTerminatedError(agentId, event, expire);
    host.cancelPendingTransientWorkerTerminatedError = (agentId, reason) =>
      health.cancelPendingTransientWorkerTerminatedError(agentId, reason);
    host.hasPendingTransientWorkerTerminatedError = (agentId) => health.hasPendingTransientWorkerTerminatedError(agentId);
    host.handleWorkerAgentEnd = (agentId, descriptor) =>
      health.handleRuntimeAgentEnd(agentId, descriptor);

    const token = controller.allocateRuntimeToken(worker.agentId);
    await controller.handleRuntimeSessionEvent(token, worker.agentId, {
      type: "message_end",
      message: { role: "assistant", content: "", stopReason: "error", errorMessage: "terminated" }
    });

    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(health.hasPendingTransientWorkerTerminatedError(worker.agentId)).toBe(true);

    await controller.handleRuntimeStatus(token, worker.agentId, "idle", 0);
    await controller.handleRuntimeAgentEnd(token, worker.agentId);

    expect(deliverCompletedWorker).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TRANSIENT_WORKER_TERMINATED_GRACE_MS + 1);

    expect(captureConversationEventFromRuntime).toHaveBeenCalledTimes(1);
    expect(deliverCompletedWorker).toHaveBeenCalledTimes(1);
  });

  it("suppresses runtime callbacks while intentional stop tokens are registered", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const {
      host,
      descriptors,
      emitStatus,
      emitConversationMessage,
      captureConversationEventFromRuntime,
      finalizeWorkerIdleTurn,
      maybeRecoverWorkerWithSpecialistFallback
    } = createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const worker = baseDescriptor({
      agentId: "w-sup",
      role: "worker",
      managerId: "m1",
      status: "streaming"
    });
    descriptors.set(worker.agentId, worker);
    host.workerWatchdogState.set(worker.agentId, {
      turnSeq: 0,
      reportedThisTurn: false,
      pendingReportTurnSeq: null,
      deferredFinalizeTurnSeq: null,
      hadStreamingThisTurn: true,
      lastFinalizedTurnSeq: null
    });

    const token = controller.allocateRuntimeToken(worker.agentId);
    controller.suppressIntentionalStopRuntimeCallbacks(worker.agentId, token);

    const event: RuntimeSessionEvent = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "suppressed" }],
        stopReason: "stop"
      }
    };

    await controller.handleRuntimeStatus(token, worker.agentId, "idle" as AgentStatus, 0);
    await controller.handleRuntimeSessionEvent(token, worker.agentId, event);
    await controller.handleRuntimeError(token, worker.agentId, {
      phase: "prompt_start",
      message: "suppressed failure"
    });
    await controller.handleRuntimeAgentEnd(token, worker.agentId);

    expect(emitStatus).not.toHaveBeenCalled();
    expect(captureConversationEventFromRuntime).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalled();
    expect(finalizeWorkerIdleTurn).not.toHaveBeenCalled();
    expect(maybeRecoverWorkerWithSpecialistFallback).not.toHaveBeenCalled();
    expect(host.maybeRecordModelCapacityBlock).not.toHaveBeenCalled();

    controller.clearIntentionalStopRuntimeCallbackSuppression(worker.agentId, token);
    await controller.handleRuntimeStatus(token, worker.agentId, "idle" as AgentStatus, 0);
    expect(emitStatus).toHaveBeenCalledTimes(1);
  });

  it("wires listRuntimeExtensionSnapshots through a booted TestSwarmManager", async () => {
    const config = await makeTempConfig();
    const manager = new TestSwarmManager(config);
    await bootWithDefaultManager(manager, config);
    expect(manager.listRuntimeExtensionSnapshots()).toEqual([]);
  });

  it("ignores legacy worker-result silent_turn backstop payloads", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitConversationMessage, deliverTerminalObligationBackstop } =
      createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({ agentId: "mgr-1", role: "manager", managerId: "mgr-1", status: "streaming" });
    descriptors.set(manager.agentId, { ...manager });
    deliverTerminalObligationBackstop.mockReturnValue(true);

    const reportText = "WORKER REPORT: status: blocked\nsummary: rerun failed.";
    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeError(token, manager.agentId, {
      phase: "silent_turn",
      message: "Manager produced no visible response to a worker's final report",
      details: {
        deliverOutcome: true,
        terminalReportText: reportText,
        userFacingMessage: "⚠️ The manager processed a worker's final report but did not produce a visible response.",
      },
    });

    expect(deliverTerminalObligationBackstop).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", text: expect.stringContaining("did not produce a visible response") })
    );
  });

  it("does not revive a legacy worker-result warning when a backstop would decline", async () => {
    const config = await makeTempConfig();
    await writeFile(join(config.paths.sharedCacheDir, "pi-models.json"), "{}", "utf8");
    const { host, descriptors, emitConversationMessage, deliverTerminalObligationBackstop } =
      createRuntimeControllerHarness(config);
    const controller = new SwarmRuntimeController(host);

    const manager = baseDescriptor({ agentId: "mgr-2", role: "manager", managerId: "mgr-2", status: "streaming" });
    descriptors.set(manager.agentId, { ...manager });
    deliverTerminalObligationBackstop.mockReturnValue(false);

    const token = controller.allocateRuntimeToken(manager.agentId);
    await controller.handleRuntimeError(token, manager.agentId, {
      phase: "silent_turn",
      message: "Manager produced no visible response to a worker's final report",
      details: {
        deliverOutcome: true,
        terminalReportText: "WORKER REPORT: status: done\nsummary: shipped.",
        userFacingMessage: "⚠️ did not produce a visible response",
      },
    });

    expect(deliverTerminalObligationBackstop).not.toHaveBeenCalled();
    expect(emitConversationMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", text: expect.stringContaining("did not produce a visible response") })
    );
  });
});
