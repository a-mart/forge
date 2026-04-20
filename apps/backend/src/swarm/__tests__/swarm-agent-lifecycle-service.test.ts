import { describe, expect, it, vi } from "vitest";
import { createAgentDescriptor, createWorkerDescriptor } from "../../test-support/index.js";
import {
  SwarmAgentLifecycleService,
  type ManagerRuntimeRecycleReason,
  type SwarmAgentLifecycleServiceOptions
} from "../swarm-agent-lifecycle-service.js";
import type { SessionProvisioner } from "../session-provisioner.js";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import type { AgentDescriptor, ManagerProfile, SpawnAgentInput } from "../types.js";
import { buildModelCapacityBlockKey } from "../swarm-manager-utils.js";

const NOW = "2026-04-20T12:00:00.000Z";

function makeRuntimeStub(overrides: Partial<SwarmAgentRuntime> & Pick<SwarmAgentRuntime, "descriptor">): SwarmAgentRuntime {
  return {
    getStatus: () => "idle",
    getPendingCount: () => 0,
    getContextUsage: () => undefined,
    terminate: vi.fn().mockResolvedValue(undefined),
    stopInFlight: vi.fn().mockResolvedValue(undefined),
    shutdownForReplacement: vi.fn().mockResolvedValue(undefined),
    recycle: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    compact: vi.fn().mockResolvedValue(undefined),
    smartCompact: vi.fn().mockResolvedValue({ compacted: false, reason: "test" }),
    getCustomEntries: () => [],
    appendCustomEntry: () => "id",
    ...overrides
  };
}

function baseLifecycleOptions(
  overrides: Partial<SwarmAgentLifecycleServiceOptions> & {
    descriptors?: Map<string, AgentDescriptor>;
    profiles?: Map<string, ManagerProfile>;
    runtimes?: Map<string, SwarmAgentRuntime>;
  } = {}
): SwarmAgentLifecycleServiceOptions {
  const descriptors = overrides.descriptors ?? new Map<string, AgentDescriptor>();
  const profiles = overrides.profiles ?? new Map<string, ManagerProfile>();
  const runtimes = overrides.runtimes ?? new Map<string, SwarmAgentRuntime>();
  const modelCapacityBlocks =
    overrides.modelCapacityBlocks ?? new Map<string, { provider: string; modelId: string; blockedUntilMs: number }>();
  const pendingRecycle = overrides.pendingManagerRuntimeRecycleAgentIds ?? new Set<string>();
  const pendingReasons =
    overrides.pendingManagerRuntimeRecycleReasonsByAgentId ?? new Map<string, ManagerRuntimeRecycleReason>();

  const sessionProvisioner =
    overrides.sessionProvisioner ??
    ({
      provisionSession: vi.fn(async (opts: { initializeRuntime?: () => Promise<void> }) => {
        await opts.initializeRuntime?.();
      })
    } as unknown as SessionProvisioner);

  return {
    dataDir: "/tmp/forge-data",
    descriptors,
    profiles,
    runtimes,
    runtimeCreationPromisesByAgentId: overrides.runtimeCreationPromisesByAgentId ?? new Map(),
    pendingManagerRuntimeRecycleAgentIds: pendingRecycle,
    pendingManagerRuntimeRecycleReasonsByAgentId: pendingReasons,
    modelCapacityBlocks,
    sessionProvisioner,
    now: overrides.now ?? (() => NOW),
    getRequiredSessionDescriptor:
      overrides.getRequiredSessionDescriptor ??
      ((agentId: string) => {
        const d = descriptors.get(agentId);
        if (!d || d.role !== "manager" || !d.profileId) {
          throw new Error(`missing manager session: ${agentId}`);
        }
        return d as AgentDescriptor & { role: "manager"; profileId: string };
      }),
    assertManager:
      overrides.assertManager ??
      ((agentId: string) => {
        const d = descriptors.get(agentId);
        if (!d || d.role !== "manager") {
          throw new Error(`not a manager: ${agentId}`);
        }
        return d;
      }),
    hasRunningManagers: overrides.hasRunningManagers ?? vi.fn(() => false),
    generateUniqueAgentId: overrides.generateUniqueAgentId ?? ((id: string) => id),
    generateUniqueManagerId: overrides.generateUniqueManagerId ?? ((name: string) => `mgr-${name}`),
    resolveAndValidateCwd: overrides.resolveAndValidateCwd ?? vi.fn(async (cwd: string) => cwd),
    resolveDefaultModelDescriptor:
      overrides.resolveDefaultModelDescriptor ??
      (() => ({ provider: "openai-codex", modelId: "gpt-5.4", thinkingLevel: "medium" })),
    resolveSpawnWorkerArchetypeId: overrides.resolveSpawnWorkerArchetypeId ?? vi.fn(async () => "worker"),
    resolveSpecialistRosterForProfile: overrides.resolveSpecialistRosterForProfile ?? vi.fn(async () => []),
    normalizeSpecialistHandle: overrides.normalizeSpecialistHandle ?? vi.fn(async (h: string) => h),
    resolveSystemPromptForDescriptor: overrides.resolveSystemPromptForDescriptor ?? vi.fn(async () => "sys"),
    injectWorkerIdentityContext: overrides.injectWorkerIdentityContext ?? ((_d, p) => p),
    createRuntimeForDescriptor: overrides.createRuntimeForDescriptor ?? vi.fn(async (d) => makeRuntimeStub({ descriptor: d })),
    allocateRuntimeToken: overrides.allocateRuntimeToken ?? vi.fn(() => 1),
    clearRuntimeToken: overrides.clearRuntimeToken ?? vi.fn(),
    getRuntimeToken: overrides.getRuntimeToken ?? vi.fn(() => 1),
    ensureSessionFileParentDirectory: overrides.ensureSessionFileParentDirectory ?? vi.fn(async () => {}),
    updateSessionMetaForWorkerDescriptor: overrides.updateSessionMetaForWorkerDescriptor ?? vi.fn(async () => {}),
    refreshSessionMetaStatsBySessionId: overrides.refreshSessionMetaStatsBySessionId ?? vi.fn(async () => {}),
    refreshSessionMetaStats: overrides.refreshSessionMetaStats ?? vi.fn(async () => {}),
    captureSessionRuntimePromptMeta: overrides.captureSessionRuntimePromptMeta ?? vi.fn(async () => {}),
    attachRuntime: overrides.attachRuntime ?? vi.fn((agentId, runtime) => {
      runtimes.set(agentId, runtime);
    }),
    saveStore: overrides.saveStore ?? vi.fn(async () => {}),
    emitStatus: overrides.emitStatus ?? vi.fn(),
    emitAgentsSnapshot: overrides.emitAgentsSnapshot ?? vi.fn(),
    emitProfilesSnapshot: overrides.emitProfilesSnapshot ?? vi.fn(),
    logDebug: overrides.logDebug ?? vi.fn(),
    seedWorkerCompletionReportTimestamp: overrides.seedWorkerCompletionReportTimestamp ?? vi.fn(),
    clearWatchdogState: overrides.clearWatchdogState ?? vi.fn(),
    deleteWorkerStallState: overrides.deleteWorkerStallState ?? vi.fn(),
    deleteWorkerActivityState: overrides.deleteWorkerActivityState ?? vi.fn(),
    deleteWorkerCompletionReportState: overrides.deleteWorkerCompletionReportState ?? vi.fn(),
    clearTrackedToolPaths: overrides.clearTrackedToolPaths ?? vi.fn(),
    suppressIntentionalStopRuntimeCallbacks: overrides.suppressIntentionalStopRuntimeCallbacks ?? vi.fn(),
    clearIntentionalStopRuntimeCallbackSuppression: overrides.clearIntentionalStopRuntimeCallbackSuppression ?? vi.fn(),
    markPendingManualManagerStopNotice: overrides.markPendingManualManagerStopNotice ?? vi.fn(),
    cancelAllPendingChoicesForAgent: overrides.cancelAllPendingChoicesForAgent ?? vi.fn(),
    runRuntimeShutdown:
      overrides.runRuntimeShutdown ??
      vi.fn(async () => ({ timedOut: false, runtimeToken: 1 })),
    detachRuntime:
      overrides.detachRuntime ??
      vi.fn((agentId: string) => {
        runtimes.delete(agentId);
        return true;
      }),
    syncPinnedContentForManagerRuntime: overrides.syncPinnedContentForManagerRuntime ?? vi.fn(async () => {}),
    sendMessage: overrides.sendMessage ?? vi.fn(async () => ({ delivered: true } as never)),
    sendManagerBootstrapMessage: overrides.sendManagerBootstrapMessage ?? vi.fn(async () => {}),
    materializeSortOrder: overrides.materializeSortOrder ?? vi.fn(),
    getSessionsForProfile:
      overrides.getSessionsForProfile ??
      vi.fn(() => [] as Array<AgentDescriptor & { role: "manager"; profileId: string }>),
    getWorkersForManager: overrides.getWorkersForManager ?? vi.fn(() => []),
    deleteConversationHistory: overrides.deleteConversationHistory ?? vi.fn(),
    deleteManagerSchedulesFile: overrides.deleteManagerSchedulesFile ?? vi.fn(async () => {}),
    migrateLegacyProfileKnowledgeToReferenceDoc:
      overrides.migrateLegacyProfileKnowledgeToReferenceDoc ?? vi.fn(async () => {}),
    ...(() => {
      const {
        descriptors: _d,
        profiles: _p,
        runtimes: _r,
        sessionProvisioner: _s,
        modelCapacityBlocks: _m,
        pendingManagerRuntimeRecycleAgentIds: _pa,
        pendingManagerRuntimeRecycleReasonsByAgentId: _pr,
        runtimeCreationPromisesByAgentId: _rc,
        ...rest
      } = overrides;
      return rest;
    })()
  };
}

describe("SwarmAgentLifecycleService", () => {
  it("resolveSpawnModel maps a preset and applies modelId + reasoning overrides", () => {
    const svc = new SwarmAgentLifecycleService(baseLifecycleOptions());
    const fallback = { provider: "anthropic", modelId: "claude-sonnet", thinkingLevel: "low" };
    const resolved = svc.resolveSpawnModel(
      {
        agentId: "w",
        model: "pi-codex",
        modelId: "gpt-5.4",
        reasoningLevel: "high"
      } satisfies SpawnAgentInput,
      fallback
    );
    expect(resolved.provider).toBe("openai-codex");
    expect(resolved.modelId).toBe("gpt-5.4");
    expect(resolved.thinkingLevel).toBe("high");
  });

  it("resolveSpawnModelWithCapacityFallback reroutes to the next OpenAI Codex model when the primary is blocked", () => {
    const modelCapacityBlocks = new Map<string, { provider: string; modelId: string; blockedUntilMs: number }>();
    const key = buildModelCapacityBlockKey("openai-codex", "gpt-5.3-codex-spark");
    expect(key).toBeDefined();
    modelCapacityBlocks.set(key!, {
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      blockedUntilMs: Date.now() + 60_000
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        modelCapacityBlocks
      })
    );

    const out = svc.resolveSpawnModelWithCapacityFallback({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
      thinkingLevel: "medium"
    });
    expect(out.modelId).toBe("gpt-5.3-codex");
  });

  it("resumeSession throws when a runtime is already attached", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtimes = new Map([[manager.agentId, makeRuntimeStub({ descriptor: manager })]]);

    const svc = new SwarmAgentLifecycleService(baseLifecycleOptions({ descriptors, runtimes }));
    await expect(svc.resumeSession("m1")).rejects.toThrow(/already running/);
  });

  it("stopSession terminates workers and shuts down the manager runtime", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", "m1", {
      agentId: "w1",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const runtimes = new Map([
      [manager.agentId, makeRuntimeStub({ descriptor: manager, getStatus: () => "streaming" })],
      [worker.agentId, makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" })]
    ]);

    const runRuntimeShutdown = vi.fn(async () => ({ timedOut: false, runtimeToken: 1 }));
    const getWorkersForManager = vi.fn(() => [worker]);

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runRuntimeShutdown,
        getWorkersForManager
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");
    expect(terminatedWorkerIds).toEqual(["w1"]);
    expect(runRuntimeShutdown).toHaveBeenCalled();
    expect(runtimes.has("m1")).toBe(false);
    expect(manager.status).toBe("idle");
  });

  it("createManager rejects the reserved cortex name", async () => {
    const svc = new SwarmAgentLifecycleService(baseLifecycleOptions());
    await expect(
      svc.createManager("bootstrap", { name: "cortex", cwd: "/tmp/proj" })
    ).rejects.toThrow(/reserved/);
  });

  it("createManager provisions session, persists profile, and sends bootstrap message", async () => {
    const descriptors = new Map<string, AgentDescriptor>();
    const profiles = new Map<string, ManagerProfile>();
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const sendManagerBootstrapMessage = vi.fn(async () => {});
    const sessionProvisioner = {
      provisionSession: vi.fn(
        async (opts: {
          profile?: ManagerProfile;
          initializeRuntime?: () => Promise<void>;
        }) => {
          if (opts.profile) {
            profiles.set(opts.profile.profileId, opts.profile);
          }
          await opts.initializeRuntime?.();
        }
      )
    } as unknown as SessionProvisioner;

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        profiles,
        runtimes,
        hasRunningManagers: () => false,
        sendManagerBootstrapMessage,
        sessionProvisioner
      })
    );

    const created = await svc.createManager("bootstrap", { name: "alpha", cwd: "/tmp/proj" });
    expect(created.role).toBe("manager");
    expect(created.profileId).toBe(created.agentId);
    expect(profiles.has(created.agentId)).toBe(true);
    expect(runtimes.has(created.agentId)).toBe(true);
    expect(sendManagerBootstrapMessage).toHaveBeenCalledWith(created.agentId);
  });

  it("deleteManager refuses Cortex archetype sessions", async () => {
    const cortexManager = createAgentDescriptor({
      agentId: "cx",
      role: "manager",
      managerId: "cx",
      profileId: "cx",
      archetypeId: "cortex",
      status: "idle"
    });
    const profiles = new Map<string, ManagerProfile>([
      [
        "cx",
        {
          profileId: "cx",
          displayName: "Cortex",
          defaultSessionAgentId: "cx",
          createdAt: NOW,
          updatedAt: NOW,
          sortOrder: 0
        }
      ]
    ]);

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors: new Map([[cortexManager.agentId, cortexManager]]),
        profiles,
        getSessionsForProfile: () => [cortexManager as AgentDescriptor & { role: "manager"; profileId: string }]
      })
    );

    await expect(svc.deleteManager("cx", "cx")).rejects.toThrow(/Cortex manager cannot be deleted/);
  });

  it("applyManagerRuntimeRecyclePolicy returns none for non-managers", async () => {
    const svc = new SwarmAgentLifecycleService(baseLifecycleOptions());
    await expect(svc.applyManagerRuntimeRecyclePolicy("nope", "cwd_change")).resolves.toBe("none");
  });

  it("applyManagerRuntimeRecyclePolicy defers when the manager runtime is not fully idle", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtimes = new Map([
      [manager.agentId, makeRuntimeStub({ descriptor: manager, getStatus: () => "idle", getPendingCount: () => 0 })]
    ]);
    const pending = new Set<string>();
    const pendingReasons = new Map<string, "cwd_change">();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        pendingManagerRuntimeRecycleAgentIds: pending,
        pendingManagerRuntimeRecycleReasonsByAgentId: pendingReasons
      })
    );

    const result = await svc.applyManagerRuntimeRecyclePolicy("m1", "cwd_change");
    expect(result).toBe("deferred");
    expect(pending.has("m1")).toBe(true);
  });

  it("applyManagerRuntimeRecyclePolicy recycles immediately when idle and clears pending state", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const recycle = vi.fn().mockResolvedValue(undefined);
    const runtimes = new Map([
      [manager.agentId, makeRuntimeStub({ descriptor: manager, recycle, isContextRecoveryInProgress: () => false })]
    ]);
    const pending = new Set<string>(["m1"]);
    const pendingReasons = new Map<string, "specialist_roster_change">([["m1", "specialist_roster_change"]]);

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        pendingManagerRuntimeRecycleAgentIds: pending,
        pendingManagerRuntimeRecycleReasonsByAgentId: pendingReasons
      })
    );

    const result = await svc.applyManagerRuntimeRecyclePolicy("m1", "idle_transition");
    expect(result).toBe("recycled");
    expect(recycle).toHaveBeenCalled();
    expect(pending.has("m1")).toBe(false);
  });

  it("stopWorker shuts down the worker runtime and clears health hooks via options", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const runtimes = new Map([[worker.agentId, makeRuntimeStub({ descriptor: worker })]]);

    const clearWatchdogState = vi.fn();
    const deleteWorkerStallState = vi.fn();
    const suppressIntentionalStopRuntimeCallbacks = vi.fn();
    const runRuntimeShutdown = vi.fn(async () => ({ timedOut: false, runtimeToken: 1 }));

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        clearWatchdogState,
        deleteWorkerStallState,
        runRuntimeShutdown,
        suppressIntentionalStopRuntimeCallbacks
      })
    );

    await svc.stopWorker("w1");
    expect(suppressIntentionalStopRuntimeCallbacks).toHaveBeenCalled();
    expect(runRuntimeShutdown).toHaveBeenCalled();
    expect(clearWatchdogState).toHaveBeenCalled();
    expect(deleteWorkerStallState).toHaveBeenCalled();
    expect(runtimes.has("w1")).toBe(false);
    expect(worker.status).toBe("idle");
  });

  it("spawnAgent retries with specialist fallback model when the first runtime creation hits capacity", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle",
      cwd: "/proj"
    });
    const descriptors = new Map([[manager.agentId, manager]]);

    const specialist = {
      specialistId: "spec1",
      displayName: "Spec",
      color: "#fff",
      enabled: true,
      whenToUse: "test",
      modelId: "gpt-5.3-codex",
      provider: "openai-codex",
      promptBody: "prompt",
      available: true,
      fallbackModelId: "gpt-5.4",
      fallbackProvider: "openai-codex"
    };

    const createRuntimeForDescriptor = vi
      .fn()
      .mockRejectedValueOnce(new Error("402 payment required"))
      .mockImplementation(async (d: AgentDescriptor) => makeRuntimeStub({ descriptor: d }));

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        assertManager: () => manager,
        resolveSpecialistRosterForProfile: vi.fn(async () => [specialist]),
        normalizeSpecialistHandle: vi.fn(async () => "spec1"),
        createRuntimeForDescriptor
      })
    );

    const spawned = await svc.spawnAgent("m1", {
      agentId: "worker-a",
      specialist: "spec1"
    });

    expect(createRuntimeForDescriptor).toHaveBeenCalledTimes(2);
    expect(spawned.model.modelId).toBe("gpt-5.4");
  });
});
