import { describe, expect, it, vi } from "vitest";
import { createAgentDescriptor, createWorkerDescriptor, createCodexExternalThreadWorkerDescriptor } from "../../test-support/index.js";
import {
  SwarmAgentLifecycleService,
  type SwarmAgentLifecycleServiceOptions
} from "../swarm-agent-lifecycle-service.js";
import { RuntimeRecoveryState } from "../runtime/runtime-recovery-state.js";
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
  const runtimeCreationPromisesByAgentId = overrides.runtimeCreationPromisesByAgentId ?? new Map<string, Promise<SwarmAgentRuntime>>();
  const modelCapacityBlocks =
    overrides.modelCapacityBlocks ?? new Map<string, { provider: string; modelId: string; blockedUntilMs: number }>();
  const runtimeRecoveryState = overrides.runtimeRecoveryState ?? new RuntimeRecoveryState();

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
    runtimeCreationPromisesByAgentId,
    getRuntime: overrides.getRuntime ?? ((agentId) => runtimes.get(agentId)),
    getRuntimeCreationPromise:
      overrides.getRuntimeCreationPromise ?? ((agentId) => runtimeCreationPromisesByAgentId.get(agentId)),
    setRuntimeCreationPromise:
      overrides.setRuntimeCreationPromise ?? ((agentId, promise) => runtimeCreationPromisesByAgentId.set(agentId, promise)),
    clearRuntimeCreationPromiseIfCurrent:
      overrides.clearRuntimeCreationPromiseIfCurrent ?? ((agentId, promise) => {
        if (runtimeCreationPromisesByAgentId.get(agentId) !== promise) {
          return false;
        }
        runtimeCreationPromisesByAgentId.delete(agentId);
        return true;
      }),
    runtimeRecoveryState,
    modelCapacityBlocks,
    sessionProvisioner,
    descriptorMutations: overrides.descriptorMutations ?? {
      upsertDescriptor: (descriptor) => {
        descriptors.set(descriptor.agentId, descriptor);
      },
      deleteDescriptor: (agentId) => {
        descriptors.delete(agentId);
      },
      upsertProfile: (profile) => {
        profiles.set(profile.profileId, profile);
      },
      deleteProfile: (profileId) => {
        profiles.delete(profileId);
      }
    },
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
    allowInvalidatedManualStopMessageEnd: overrides.allowInvalidatedManualStopMessageEnd ?? vi.fn(),
    markPendingManualManagerStopNotice: overrides.markPendingManualManagerStopNotice ?? vi.fn(),
    emitImmediateManualManagerStopNotice: overrides.emitImmediateManualManagerStopNotice ?? vi.fn(),
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
    detachRuntimeIfMatches:
      overrides.detachRuntimeIfMatches ??
      vi.fn((agentId: string, expectedRuntime: SwarmAgentRuntime) => {
        if (runtimes.get(agentId) !== expectedRuntime) {
          return false;
        }
        runtimes.delete(agentId);
        return true;
      }),
    syncPinnedContentForManagerRuntime: overrides.syncPinnedContentForManagerRuntime ?? vi.fn(async () => {}),
    transitionSessionWorkPlansForManualStop:
      overrides.transitionSessionWorkPlansForManualStop ?? vi.fn(async () => {}),
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
        runtimeRecoveryState: _rr,
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
    expect(out.modelId).toBe("gpt-5.5");
  });

  it("getOrCreateRuntimeForDescriptor preserves manager runtime attach ordering", async () => {
    const order: string[] = [];
    const manager = createAgentDescriptor({
      agentId: "m-order",
      role: "manager",
      managerId: "m-order",
      profileId: "m-order",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtime = makeRuntimeStub({
      descriptor: manager,
      getSystemPrompt: () => "persisted prompt",
      getContextUsage: () => ({ tokens: 2, contextWindow: 100, percent: 2 })
    });
    const runtimeOptions = { startupRecoveryContext: { reason: "model_change" as const, blockText: "recover" } };
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-1",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        ensureSessionFileParentDirectory: vi.fn(async () => {
          order.push("session-parent");
        }),
        resolveSystemPromptForDescriptor: vi.fn(async () => {
          order.push("prompt");
          return "resolved prompt";
        }),
        prepareManagerRuntimeCreation: vi.fn(async () => {
          order.push("prepare");
          return { continuityRequest, runtimeCreationOptions: runtimeOptions };
        }),
        allocateRuntimeToken: vi.fn(() => {
          order.push("allocate");
          return 42;
        }),
        getRuntimeToken: vi.fn(() => 42),
        createRuntimeForDescriptor: vi.fn(async (_descriptor, _prompt, token, options) => {
          order.push(`create:${token}:${options === runtimeOptions}`);
          return runtime;
        }),
        syncPinnedContentForManagerRuntime: vi.fn(async (_descriptor, options) => {
          expect(options?.runtime).toBe(runtime);
          order.push("pinned");
        }),
        appendAppliedModelChangeContinuity: vi.fn(async (_descriptor, request, appliedRuntime) => {
          expect(request).toBe(continuityRequest);
          expect(appliedRuntime).toBe(runtime);
          expect(runtimes.has(manager.agentId)).toBe(false);
          order.push("append");
        }),
        attachRuntime: vi.fn((agentId, attachedRuntime) => {
          order.push("attach");
          runtimes.set(agentId, attachedRuntime);
        }),
        captureSessionRuntimePromptMeta: vi.fn(async () => {
          order.push("prompt-meta");
        }),
        refreshSessionMetaStats: vi.fn(async () => {
          order.push("stats");
        }),
        emitStatus: vi.fn(() => {
          order.push("status");
        })
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).resolves.toBe(runtime);

    expect(order.slice(0, 8)).toEqual([
      "session-parent",
      "prompt",
      "prepare",
      "allocate",
      "create:42:true",
      "pinned",
      "append",
      "attach"
    ]);
    expect(order).toEqual(expect.arrayContaining(["prompt-meta", "stats", "status"]));

    const position = (step: string) => order.indexOf(step);
    expect(position("append")).toBeLessThan(position("attach"));
    expect(position("attach")).toBeLessThan(position("status"));
    expect(position("attach")).toBeLessThan(position("prompt-meta"));
    expect(position("attach")).toBeLessThan(position("stats"));
  });

  it("does not mark model-change continuity applied when the real stop-session path runs before attach", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-before-attach",
      role: "manager",
      managerId: "m-stop-before-attach",
      profileId: "m-stop-before-attach",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-stop-before-attach",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const appendAppliedModelChangeContinuity = vi.fn(async () => {});
    const attachRuntime = vi.fn();
    let runtimeToken: number | undefined;
    const allocateRuntimeToken = vi.fn(() => {
      runtimeToken = 91;
      return runtimeToken;
    });
    const getRuntimeToken = vi.fn(() => runtimeToken);
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });
    const serviceRef: { current?: SwarmAgentLifecycleService } = {};
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => runtime),
        syncPinnedContentForManagerRuntime: vi.fn(async () => {
          await serviceRef.current!.stopSession(manager.agentId);
        }),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken,
        getRuntimeToken
      })
    );
    serviceRef.current = svc;

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).rejects.toThrow(/Runtime token is stale/);

    expect(manager.status).toBe("idle");
    expect(appendAppliedModelChangeContinuity).not.toHaveBeenCalled();
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(runtime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 91);
  });

  it("does not mark model-change continuity applied when a concurrent runtime wins before attach", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-concurrent-before-attach",
      role: "manager",
      managerId: "m-concurrent-before-attach",
      profileId: "m-concurrent-before-attach",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const replacementRuntime = makeRuntimeStub({ descriptor: manager });
    const winningRuntime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-concurrent-before-attach",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const appendAppliedModelChangeContinuity = vi.fn(async () => {});
    const attachRuntime = vi.fn();
    const clearRuntimeToken = vi.fn();
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => replacementRuntime),
        syncPinnedContentForManagerRuntime: vi.fn(async () => {
          runtimes.set(manager.agentId, winningRuntime);
        }),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken: vi.fn(() => 92)
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).resolves.toBe(winningRuntime);

    expect(appendAppliedModelChangeContinuity).not.toHaveBeenCalled();
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(replacementRuntime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 92);
    expect(runtimes.get(manager.agentId)).toBe(winningRuntime);
  });

  it("terminates replacement runtime when the real stop-session path runs while continuity is being marked applied", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-after-applied",
      role: "manager",
      managerId: "m-stop-after-applied",
      profileId: "m-stop-after-applied",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-stop-after-applied",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const attachRuntime = vi.fn();
    let runtimeToken: number | undefined;
    const allocateRuntimeToken = vi.fn(() => {
      runtimeToken = 93;
      return runtimeToken;
    });
    const getRuntimeToken = vi.fn(() => runtimeToken);
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });
    const serviceRef: { current?: SwarmAgentLifecycleService } = {};
    const appendAppliedModelChangeContinuity = vi.fn(async () => {
      await serviceRef.current!.stopSession(manager.agentId);
    });
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => runtime),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken,
        getRuntimeToken
      })
    );
    serviceRef.current = svc;

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).rejects.toThrow(/Runtime token is stale/);

    expect(manager.status).toBe("idle");
    expect(appendAppliedModelChangeContinuity).toHaveBeenCalledWith(manager, continuityRequest, runtime);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(runtime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 93);
  });

  it("terminates replacement runtime when the real stop-all path runs while continuity is being marked applied", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-all-after-applied",
      role: "manager",
      managerId: "m-stop-all-after-applied",
      profileId: "m-stop-all-after-applied",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-stop-all-after-applied",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const attachRuntime = vi.fn();
    let runtimeToken: number | undefined;
    const allocateRuntimeToken = vi.fn(() => {
      runtimeToken = 96;
      return runtimeToken;
    });
    const getRuntimeToken = vi.fn(() => runtimeToken);
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });
    const serviceRef: { current?: SwarmAgentLifecycleService } = {};
    const appendAppliedModelChangeContinuity = vi.fn(async () => {
      await serviceRef.current!.stopAllAgents(manager.agentId, manager.agentId);
    });
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => runtime),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken,
        getRuntimeToken
      })
    );
    serviceRef.current = svc;

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).rejects.toThrow(/Runtime token is stale/);

    expect(manager.status).toBe("idle");
    expect(appendAppliedModelChangeContinuity).toHaveBeenCalledWith(manager, continuityRequest, runtime);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(runtime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 96);
  });

  it("terminates replacement runtime when the manager is deleted after continuity is marked applied", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-delete-after-applied",
      role: "manager",
      managerId: "m-delete-after-applied",
      profileId: "m-delete-after-applied",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-delete-after-applied",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const appendAppliedModelChangeContinuity = vi.fn(async () => {
      descriptors.delete(manager.agentId);
    });
    const attachRuntime = vi.fn();
    const clearRuntimeToken = vi.fn();
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => runtime),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken: vi.fn(() => 94),
        getRuntimeToken: vi.fn(() => 94)
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).rejects.toThrow(/Target agent is not running/);

    expect(appendAppliedModelChangeContinuity).toHaveBeenCalledWith(manager, continuityRequest, runtime);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(runtime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 94);
  });

  it("returns the winning runtime when a concurrent runtime appears after continuity is marked applied", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-concurrent-after-applied",
      role: "manager",
      managerId: "m-concurrent-after-applied",
      profileId: "m-concurrent-after-applied",
      status: "idle"
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const replacementRuntime = makeRuntimeStub({ descriptor: manager });
    const winningRuntime = makeRuntimeStub({ descriptor: manager });
    const continuityRequest = {
      version: 1 as const,
      requestId: "req-concurrent-after-applied",
      createdAt: NOW,
      sessionAgentId: manager.agentId,
      sourceModel: { provider: "claude-sdk", modelId: "claude", runtimeKind: "claude" as const },
      targetModel: { provider: "openai-codex", modelId: "gpt-5.4", runtimeKind: "pi" as const }
    };
    const appendAppliedModelChangeContinuity = vi.fn(async () => {
      runtimes.set(manager.agentId, winningRuntime);
    });
    const attachRuntime = vi.fn();
    const clearRuntimeToken = vi.fn();
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        prepareManagerRuntimeCreation: vi.fn(async () => ({ continuityRequest })),
        createRuntimeForDescriptor: vi.fn(async () => replacementRuntime),
        appendAppliedModelChangeContinuity,
        attachRuntime,
        clearRuntimeToken,
        allocateRuntimeToken: vi.fn(() => 95),
        getRuntimeToken: vi.fn(() => 95)
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(manager)).resolves.toBe(winningRuntime);

    expect(appendAppliedModelChangeContinuity).toHaveBeenCalledWith(manager, continuityRequest, replacementRuntime);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(replacementRuntime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 95);
    expect(runtimes.get(manager.agentId)).toBe(winningRuntime);
  });

  it("getOrCreateRuntimeForDescriptor dedupes in-flight creation and preserves newer creation promise on cleanup", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w-dedupe", status: "idle" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const runtime = makeRuntimeStub({ descriptor: worker });
    let releaseCreation!: () => void;
    const creationGate = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const createRuntimeForDescriptor = vi.fn(async () => {
      await creationGate;
      return runtime;
    });
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeCreationPromisesByAgentId,
        allocateRuntimeToken: vi.fn(() => 11),
        getRuntimeToken: vi.fn(() => 11),
        createRuntimeForDescriptor,
        attachRuntime: (agentId, runtimeToAttach) => {
          runtimes.set(agentId, runtimeToAttach);
        }
      })
    );

    const firstCreation = svc.getOrCreateRuntimeForDescriptor(worker);
    const secondCreation = svc.getOrCreateRuntimeForDescriptor(worker);
    expect(runtimeCreationPromisesByAgentId.get(worker.agentId)).toBeDefined();

    const newerCreation = Promise.resolve(makeRuntimeStub({ descriptor: worker }));
    runtimeCreationPromisesByAgentId.set(worker.agentId, newerCreation);
    releaseCreation();

    await expect(firstCreation).resolves.toBe(runtime);
    await expect(secondCreation).resolves.toBe(runtime);
    expect(createRuntimeForDescriptor).toHaveBeenCalledTimes(1);
    expect(runtimeCreationPromisesByAgentId.get(worker.agentId)).toBe(newerCreation);
  });

  it("terminates and clears a replacement runtime when the descriptor disappears before attach", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w-gone", status: "idle" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const runtime = makeRuntimeStub({ descriptor: worker });
    const runtimeCreationPromisesByAgentId = new Map<string, Promise<SwarmAgentRuntime>>();
    const clearRuntimeToken = vi.fn();
    const attachRuntime = vi.fn();
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});
    const refreshSessionMetaStatsBySessionId = vi.fn(async () => {});
    const emitStatus = vi.fn();
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeCreationPromisesByAgentId,
        allocateRuntimeToken: vi.fn(() => 7),
        clearRuntimeToken,
        createRuntimeForDescriptor: vi.fn(async () => {
          descriptors.delete(worker.agentId);
          return runtime;
        }),
        attachRuntime,
        updateSessionMetaForWorkerDescriptor,
        refreshSessionMetaStatsBySessionId,
        emitStatus
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(worker)).rejects.toThrow(/Target agent is not running/);

    expect(runtime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(worker.agentId, 7);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(updateSessionMetaForWorkerDescriptor).not.toHaveBeenCalled();
    expect(refreshSessionMetaStatsBySessionId).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(runtimeCreationPromisesByAgentId.has(worker.agentId)).toBe(false);
  });

  it("returns the existing runtime and preserves the runtime map when a concurrent runtime appears before attach", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w-concurrent", status: "idle" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
    const replacementRuntime = makeRuntimeStub({ descriptor: worker });
    const existingRuntime = makeRuntimeStub({ descriptor: worker });
    const clearRuntimeToken = vi.fn();
    const attachRuntime = vi.fn((agentId: string, runtimeToAttach: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtimeToAttach);
    });
    const seedWorkerCompletionReportTimestamp = vi.fn();
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});
    const refreshSessionMetaStatsBySessionId = vi.fn(async () => {});
    const emitStatus = vi.fn();
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        allocateRuntimeToken: vi.fn(() => 8),
        clearRuntimeToken,
        createRuntimeForDescriptor: vi.fn(async () => {
          runtimes.set(worker.agentId, existingRuntime);
          return replacementRuntime;
        }),
        attachRuntime,
        seedWorkerCompletionReportTimestamp,
        updateSessionMetaForWorkerDescriptor,
        refreshSessionMetaStatsBySessionId,
        emitStatus
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(worker)).resolves.toBe(existingRuntime);

    expect(replacementRuntime.terminate).toHaveBeenCalledWith({ abort: true, shutdownTimeoutMs: 1_500, drainTimeoutMs: 500 });
    expect(clearRuntimeToken).toHaveBeenCalledWith(worker.agentId, 8);
    expect(attachRuntime).not.toHaveBeenCalled();
    expect(seedWorkerCompletionReportTimestamp).not.toHaveBeenCalled();
    expect(updateSessionMetaForWorkerDescriptor).not.toHaveBeenCalled();
    expect(refreshSessionMetaStatsBySessionId).not.toHaveBeenCalled();
    expect(emitStatus).not.toHaveBeenCalled();
    expect(runtimes.get(worker.agentId)).toBe(existingRuntime);
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
    const runtimeRecoveryState = new RuntimeRecoveryState();
    runtimeRecoveryState.markRecoveryAbortedWorkerTurn(worker.agentId);

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeRecoveryState,
        runRuntimeShutdown,
        getWorkersForManager
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");
    expect(terminatedWorkerIds).toEqual(["w1"]);
    expect(runRuntimeShutdown).toHaveBeenCalled();
    expect(runtimeRecoveryState.hasRecoveryAbortedWorkerTurn(worker.agentId)).toBe(false);
    expect(runtimes.has("m1")).toBe(false);
    expect(manager.status).toBe("idle");
  });

  it("stopSession deactivates an invalidated attached manager binding after slow worker teardown", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-attached-slow-worker",
      role: "manager",
      managerId: "m-stop-attached-slow-worker",
      profileId: "m-stop-attached-slow-worker",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-stop-attached-slow",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const managerRuntime = makeRuntimeStub({ descriptor: manager, getStatus: () => "streaming" });
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const runtimes = new Map<string, SwarmAgentRuntime>([
      [manager.agentId, managerRuntime],
      [worker.agentId, workerRuntime]
    ]);
    let runtimeToken: number | undefined = 401;
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });
    const allowInvalidatedManualStopMessageEnd = vi.fn();
    const markPendingManualManagerStopNotice = vi.fn();
    const emitImmediateManualManagerStopNotice = vi.fn();
    const runRuntimeShutdown = vi.fn(async (descriptor: AgentDescriptor) => {
      if (descriptor.agentId === worker.agentId) {
        await Promise.resolve();
        return { timedOut: false, runtimeToken: 1 };
      }
      await managerRuntime.terminate({ abort: true });
      return { timedOut: false, runtimeToken: undefined };
    });
    const detachRuntimeIfMatches = vi.fn((agentId: string, expectedRuntime: SwarmAgentRuntime, expectedToken?: number) => {
      if (runtimes.get(agentId) !== expectedRuntime) {
        return false;
      }
      runtimes.delete(agentId);
      clearRuntimeToken(agentId, expectedToken);
      return true;
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        getWorkersForManager: vi.fn(() => [worker]),
        getRuntimeToken: vi.fn(() => runtimeToken),
        clearRuntimeToken,
        allowInvalidatedManualStopMessageEnd,
        markPendingManualManagerStopNotice,
        emitImmediateManualManagerStopNotice,
        runRuntimeShutdown,
        detachRuntimeIfMatches
      })
    );

    await expect(svc.stopSession(manager.agentId)).resolves.toEqual({ terminatedWorkerIds: [worker.agentId] });

    expect(allowInvalidatedManualStopMessageEnd).toHaveBeenCalledWith(manager.agentId, 401);
    expect(markPendingManualManagerStopNotice).toHaveBeenCalledTimes(2);
    expect(emitImmediateManualManagerStopNotice).not.toHaveBeenCalled();
    expect(runRuntimeShutdown).toHaveBeenCalledWith(manager, "terminate", { abort: true });
    expect(detachRuntimeIfMatches).toHaveBeenCalledWith(manager.agentId, managerRuntime, 401);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 401);
    expect(clearRuntimeToken.mock.calls.filter(([agentId, token]) => agentId === manager.agentId && token === 401)).toHaveLength(1);
    expect(runtimes.has(manager.agentId)).toBe(false);
    expect(manager.status).toBe("idle");
  });

  it("stopSession emits an immediate manual stop notice when an idle manager stops active workers", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-idle-stop-workers",
      role: "manager",
      managerId: "m-idle-stop-workers",
      profileId: "m-idle-stop-workers",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-idle-stop-workers",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const runtimes = new Map<string, SwarmAgentRuntime>([[worker.agentId, workerRuntime]]);
    const markPendingManualManagerStopNotice = vi.fn();
    const allowInvalidatedManualStopMessageEnd = vi.fn();
    const emitImmediateManualManagerStopNotice = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        getWorkersForManager: vi.fn(() => [worker]),
        markPendingManualManagerStopNotice,
        allowInvalidatedManualStopMessageEnd,
        emitImmediateManualManagerStopNotice
      })
    );

    await expect(svc.stopSession(manager.agentId)).resolves.toEqual({ terminatedWorkerIds: [worker.agentId] });

    expect(markPendingManualManagerStopNotice).not.toHaveBeenCalled();
    expect(allowInvalidatedManualStopMessageEnd).not.toHaveBeenCalled();
    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledTimes(1);
    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledWith(manager.agentId);
  });

  it("stopAllAgents emits an immediate manual stop notice when an idle manager stops active workers", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-idle-stop-all-workers",
      role: "manager",
      managerId: "m-idle-stop-all-workers",
      profileId: "m-idle-stop-all-workers",
      status: "idle"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-idle-stop-all-workers",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const runtimes = new Map<string, SwarmAgentRuntime>([[worker.agentId, workerRuntime]]);
    const markPendingManualManagerStopNotice = vi.fn();
    const allowInvalidatedManualStopMessageEnd = vi.fn();
    const emitImmediateManualManagerStopNotice = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        markPendingManualManagerStopNotice,
        allowInvalidatedManualStopMessageEnd,
        emitImmediateManualManagerStopNotice
      })
    );

    await expect(svc.stopAllAgents(manager.agentId, manager.agentId)).resolves.toMatchObject({
      managerId: manager.agentId,
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true
    });

    expect(markPendingManualManagerStopNotice).not.toHaveBeenCalled();
    expect(allowInvalidatedManualStopMessageEnd).not.toHaveBeenCalled();
    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledTimes(1);
    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledWith(manager.agentId);
  });

  it("stopAllAgents deactivates an invalidated attached manager binding after slow worker teardown", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-all-attached-slow-worker",
      role: "manager",
      managerId: "m-stop-all-attached-slow-worker",
      profileId: "m-stop-all-attached-slow-worker",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-stop-all-attached-slow",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const managerRuntime = makeRuntimeStub({ descriptor: manager, getStatus: () => "streaming" });
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const runtimes = new Map<string, SwarmAgentRuntime>([
      [manager.agentId, managerRuntime],
      [worker.agentId, workerRuntime]
    ]);
    let runtimeToken: number | undefined = 402;
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });
    const allowInvalidatedManualStopMessageEnd = vi.fn();
    const markPendingManualManagerStopNotice = vi.fn();
    const emitImmediateManualManagerStopNotice = vi.fn();
    const runRuntimeShutdown = vi.fn(async (descriptor: AgentDescriptor) => {
      if (descriptor.agentId === worker.agentId) {
        await Promise.resolve();
        return { timedOut: false, runtimeToken: 1 };
      }
      await managerRuntime.stopInFlight({ abort: true });
      return { timedOut: false, runtimeToken: undefined };
    });
    const detachRuntimeIfMatches = vi.fn((agentId: string, expectedRuntime: SwarmAgentRuntime, expectedToken?: number) => {
      if (runtimes.get(agentId) !== expectedRuntime) {
        return false;
      }
      runtimes.delete(agentId);
      clearRuntimeToken(agentId, expectedToken);
      return true;
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        getRuntimeToken: vi.fn(() => runtimeToken),
        clearRuntimeToken,
        allowInvalidatedManualStopMessageEnd,
        markPendingManualManagerStopNotice,
        emitImmediateManualManagerStopNotice,
        runRuntimeShutdown,
        detachRuntimeIfMatches
      })
    );

    await expect(svc.stopAllAgents(manager.agentId, manager.agentId)).resolves.toMatchObject({
      managerId: manager.agentId,
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true
    });

    expect(allowInvalidatedManualStopMessageEnd).toHaveBeenCalledWith(manager.agentId, 402);
    expect(markPendingManualManagerStopNotice).toHaveBeenCalledTimes(2);
    expect(emitImmediateManualManagerStopNotice).not.toHaveBeenCalled();
    expect(runRuntimeShutdown).toHaveBeenCalledWith(manager, "stopInFlight", { abort: true });
    expect(detachRuntimeIfMatches).toHaveBeenCalledWith(manager.agentId, managerRuntime, 402);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId);
    expect(clearRuntimeToken).toHaveBeenCalledWith(manager.agentId, 402);
    expect(clearRuntimeToken.mock.calls.filter(([agentId, token]) => agentId === manager.agentId && token === 402)).toHaveLength(1);
    expect(runtimes.has(manager.agentId)).toBe(false);
    expect(manager.status).toBe("idle");
  });

  it("stopSession shuts down a replacement manager runtime that attaches while worker teardown is slow", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-slow-worker",
      role: "manager",
      managerId: "m-stop-slow-worker",
      profileId: "m-stop-slow-worker",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-stop-slow",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const replacementRuntime = makeRuntimeStub({ descriptor: manager, getStatus: () => "idle" });
    const runtimes = new Map<string, SwarmAgentRuntime>([[worker.agentId, workerRuntime]]);
    let runtimeToken: number | undefined;
    const serviceRef: { current?: SwarmAgentLifecycleService } = {};
    const attachRuntime = vi.fn((agentId: string, runtimeToAttach: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtimeToAttach);
    });
    const runRuntimeShutdown = vi.fn(async (descriptor: AgentDescriptor, action: "terminate" | "stopInFlight") => {
      if (descriptor.agentId === worker.agentId) {
        await serviceRef.current!.getOrCreateRuntimeForDescriptor(manager);
        return { timedOut: false, runtimeToken: 1 };
      }
      if (action === "terminate") {
        await replacementRuntime.terminate({ abort: true });
      } else {
        await replacementRuntime.stopInFlight({ abort: true });
      }
      return { timedOut: false, runtimeToken };
    });
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        getWorkersForManager: vi.fn(() => [worker]),
        createRuntimeForDescriptor: vi.fn(async () => replacementRuntime),
        attachRuntime,
        runRuntimeShutdown,
        allocateRuntimeToken: vi.fn(() => {
          runtimeToken = 201;
          return runtimeToken;
        }),
        getRuntimeToken: vi.fn(() => runtimeToken),
        clearRuntimeToken
      })
    );
    serviceRef.current = svc;

    await expect(svc.stopSession(manager.agentId)).resolves.toEqual({ terminatedWorkerIds: [worker.agentId] });

    expect(attachRuntime).toHaveBeenCalledWith(manager.agentId, replacementRuntime);
    expect(replacementRuntime.terminate).toHaveBeenCalledWith({ abort: true });
    expect(runRuntimeShutdown).toHaveBeenCalledWith(manager, "terminate", { abort: true });
    expect(runtimes.has(manager.agentId)).toBe(false);
    expect(manager.status).toBe("idle");
  });

  it("stopAllAgents shuts down a replacement manager runtime that attaches while worker teardown is slow", async () => {
    const manager = createAgentDescriptor({
      agentId: "m-stop-all-slow-worker",
      role: "manager",
      managerId: "m-stop-all-slow-worker",
      profileId: "m-stop-all-slow-worker",
      status: "streaming"
    });
    const worker = createWorkerDescriptor("/p", manager.agentId, {
      agentId: "w-stop-all-slow",
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker]
    ]);
    const workerRuntime = makeRuntimeStub({ descriptor: worker, getStatus: () => "streaming" });
    const replacementRuntime = makeRuntimeStub({ descriptor: manager, getStatus: () => "idle" });
    const runtimes = new Map<string, SwarmAgentRuntime>([[worker.agentId, workerRuntime]]);
    let runtimeToken: number | undefined;
    const serviceRef: { current?: SwarmAgentLifecycleService } = {};
    const attachRuntime = vi.fn((agentId: string, runtimeToAttach: SwarmAgentRuntime) => {
      runtimes.set(agentId, runtimeToAttach);
    });
    const runRuntimeShutdown = vi.fn(async (descriptor: AgentDescriptor, action: "terminate" | "stopInFlight") => {
      if (descriptor.agentId === worker.agentId) {
        await serviceRef.current!.getOrCreateRuntimeForDescriptor(manager);
        return { timedOut: false, runtimeToken: 1 };
      }
      if (action === "terminate") {
        await replacementRuntime.terminate({ abort: true });
      } else {
        await replacementRuntime.stopInFlight({ abort: true });
      }
      return { timedOut: false, runtimeToken };
    });
    const clearRuntimeToken = vi.fn((_agentId: string, expectedToken?: number) => {
      if (expectedToken === undefined || expectedToken === runtimeToken) {
        runtimeToken = undefined;
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        createRuntimeForDescriptor: vi.fn(async () => replacementRuntime),
        attachRuntime,
        runRuntimeShutdown,
        allocateRuntimeToken: vi.fn(() => {
          runtimeToken = 301;
          return runtimeToken;
        }),
        getRuntimeToken: vi.fn(() => runtimeToken),
        clearRuntimeToken
      })
    );
    serviceRef.current = svc;

    await expect(svc.stopAllAgents(manager.agentId, manager.agentId)).resolves.toMatchObject({
      managerId: manager.agentId,
      stoppedWorkerIds: [worker.agentId],
      managerStopped: true
    });

    expect(attachRuntime).toHaveBeenCalledWith(manager.agentId, replacementRuntime);
    expect(replacementRuntime.stopInFlight).toHaveBeenCalledWith({ abort: true });
    expect(runRuntimeShutdown).toHaveBeenCalledWith(manager, "stopInFlight", { abort: true });
    expect(runtimes.has(manager.agentId)).toBe(false);
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

  it("createManager inserts new profiles at the top of sortOrder", async () => {
    const descriptors = new Map<string, AgentDescriptor>();
    const profiles = new Map<string, ManagerProfile>([
      [
        "manager",
        {
          profileId: "manager",
          displayName: "Main",
          defaultSessionAgentId: "manager",
          createdAt: NOW,
          updatedAt: NOW,
          sortOrder: 0
        }
      ],
      [
        "alpha",
        {
          profileId: "alpha",
          displayName: "Alpha",
          defaultSessionAgentId: "alpha",
          createdAt: NOW,
          updatedAt: NOW,
          sortOrder: 1
        }
      ]
    ]);
    const runtimes = new Map<string, SwarmAgentRuntime>();
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
        sessionProvisioner
      })
    );

    const created = await svc.createManager("bootstrap", { name: "beta", cwd: "/tmp/proj" });

    expect(profiles.get("manager")?.sortOrder).toBe(1);
    expect(profiles.get("alpha")?.sortOrder).toBe(2);
    expect(profiles.get(created.agentId)?.sortOrder).toBe(0);
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
    const runtimeRecoveryState = new RuntimeRecoveryState();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeRecoveryState
      })
    );

    const result = await svc.applyManagerRuntimeRecyclePolicy("m1", "cwd_change");
    expect(result).toBe("deferred");
    expect(runtimeRecoveryState.hasPendingManagerRuntimeRecycle("m1")).toBe(true);
  });

  it("applyManagerRuntimeRecyclePolicy defers while recovery grace is active", async () => {
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
      [
        manager.agentId,
        makeRuntimeStub({
          descriptor: manager,
          recycle,
          isContextRecoveryInProgress: () => false,
          isContextRecoveryActive: () => true
        })
      ]
    ]);
    const runtimeRecoveryState = new RuntimeRecoveryState();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeRecoveryState
      })
    );

    const result = await svc.applyManagerRuntimeRecyclePolicy("m1", "cwd_change");
    expect(result).toBe("deferred");
    expect(recycle).not.toHaveBeenCalled();
    expect(runtimeRecoveryState.hasPendingManagerRuntimeRecycle("m1")).toBe(true);
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
    const runtimeRecoveryState = new RuntimeRecoveryState();
    runtimeRecoveryState.setPendingManagerRuntimeRecycle("m1", "specialist_roster_change");

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        runtimeRecoveryState
      })
    );

    const result = await svc.applyManagerRuntimeRecyclePolicy("m1", "idle_transition");
    expect(result).toBe("recycled");
    expect(recycle).toHaveBeenCalled();
    expect(runtimeRecoveryState.hasPendingManagerRuntimeRecycle("m1")).toBe(false);
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

  it("routes lifecycle descriptor mutations through the mutation adapter", async () => {
    const worker = createWorkerDescriptor("/p", "m1", { agentId: "w1", status: "streaming" });
    const descriptors = new Map([[worker.agentId, worker]]);
    const runtimes = new Map([[worker.agentId, makeRuntimeStub({ descriptor: worker })]]);
    const upsertDescriptor = vi.fn((descriptor: AgentDescriptor) => {
      descriptors.set(descriptor.agentId, descriptor);
    });
    const deleteDescriptor = vi.fn((agentId: string) => {
      descriptors.delete(agentId);
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes,
        descriptorMutations: {
          upsertDescriptor,
          deleteDescriptor,
          upsertProfile: vi.fn((profile: ManagerProfile) => {
            // Not used by this path, but wired to prove the lifecycle service no longer owns map writes.
            return profile;
          }),
          deleteProfile: vi.fn()
        }
      })
    );

    await svc.stopWorker("w1");

    expect(upsertDescriptor).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "w1",
      status: "idle"
    }));
    expect(deleteDescriptor).not.toHaveBeenCalled();
    expect(descriptors.get("w1")?.status).toBe("idle");
  });

  it("spawnAgent resolves specialists from the collaboration roster for collab managers", async () => {
    const manager = createAgentDescriptor({
      agentId: "collab-manager",
      role: "manager",
      managerId: "collab-manager",
      profileId: "profile-1",
      status: "idle",
      cwd: "/proj",
      sessionSurface: "collab",
      collab: { workspaceId: "workspace-1", channelId: "channel-1" }
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const resolveSpecialistRosterForProfile = vi.fn(async (_profileId: string, targetSpace?: string) =>
      targetSpace === "collaboration"
        ? [
            {
              specialistId: "collab-specialist",
              displayName: "Collab Specialist",
              color: "#abc",
              enabled: true,
              whenToUse: "collaboration work",
              modelId: "gpt-5.4",
              provider: "openai-codex",
              promptBody: "collab prompt",
              available: true
            }
          ]
        : []
    );

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        assertManager: () => manager,
        resolveSpecialistRosterForProfile,
        normalizeSpecialistHandle: vi.fn(async () => "collab-specialist")
      })
    );

    const spawned = await svc.spawnAgent("collab-manager", {
      agentId: "collab-worker",
      specialist: "collab-specialist"
    });

    expect(resolveSpecialistRosterForProfile).toHaveBeenCalledWith("profile-1", "collaboration");
    expect(spawned.specialistId).toBe("collab-specialist");
    expect(spawned.specialistDisplayName).toBe("Collab Specialist");
    expect(spawned.model.modelId).toBe("gpt-5.4");
  });

  it("notifySpecialistRosterChanged syncs worker metadata from builder and collaboration rosters", async () => {
    const builderManager = createAgentDescriptor({
      agentId: "builder-manager",
      role: "manager",
      managerId: "builder-manager",
      profileId: "profile-1",
      status: "idle"
    });
    const collabWorker = createWorkerDescriptor("/proj", "builder-manager", {
      agentId: "collab-worker",
      profileId: "profile-1",
      specialistId: "collab-specialist"
    });
    const descriptors = new Map([
      [builderManager.agentId, builderManager],
      [collabWorker.agentId, collabWorker]
    ]);
    const saveStore = vi.fn(async () => {});
    const emitAgentsSnapshot = vi.fn();
    const resolveSpecialistRosterForProfile = vi.fn(async (_profileId: string, targetSpace?: string) =>
      targetSpace === "builder"
        ? [{ specialistId: "builder-specialist", displayName: "Builder Specialist", color: "#111" }]
        : [{ specialistId: "collab-specialist", displayName: "Collab Specialist", color: "#222" }]
    );

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        resolveSpecialistRosterForProfile,
        getSessionsForProfile: vi.fn(() => [builderManager as AgentDescriptor & { role: "manager"; profileId: string }]),
        saveStore,
        emitAgentsSnapshot
      })
    );

    await svc.notifySpecialistRosterChanged("profile-1");

    expect(resolveSpecialistRosterForProfile).toHaveBeenCalledWith("profile-1", "builder");
    expect(resolveSpecialistRosterForProfile).toHaveBeenCalledWith("profile-1", "collaboration");
    expect(collabWorker.specialistDisplayName).toBe("Collab Specialist");
    expect(collabWorker.specialistColor).toBe("#222");
    expect(saveStore).toHaveBeenCalled();
    expect(emitAgentsSnapshot).toHaveBeenCalled();
  });

  it("notifySpecialistRosterChanged with a collaboration session preserves channel-local shadow metadata", async () => {
    const collabManager = createAgentDescriptor({
      agentId: "channel-a",
      role: "manager",
      managerId: "channel-a",
      profileId: "_collaboration",
      sessionSurface: "collab",
      status: "idle"
    });
    const collabWorker = createWorkerDescriptor("/proj", "channel-a", {
      agentId: "collab-worker",
      profileId: "_collaboration",
      specialistId: "global-collab"
    });
    const descriptors = new Map([
      [collabManager.agentId, collabManager],
      [collabWorker.agentId, collabWorker]
    ]);
    const resolveSpecialistRosterForProfile = vi.fn(async () => [
      { specialistId: "global-collab", displayName: "Global Collab", color: "#111" }
    ]);
    const resolveSpecialistRosterForManager = vi.fn(async () => [
      {
        specialistId: "global-collab",
        displayName: "Local Shadow Collab",
        color: "#222",
        sourceKind: "channel",
        shadowsGlobal: true
      }
    ]);
    const saveStore = vi.fn(async () => {});

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        resolveSpecialistRosterForProfile,
        resolveSpecialistRosterForManager,
        getSessionsForProfile: vi.fn(() => [collabManager as AgentDescriptor & { role: "manager"; profileId: string }]),
        saveStore
      })
    );

    await svc.notifySpecialistRosterChanged("_collaboration", { sessionAgentId: "channel-a" });

    expect(resolveSpecialistRosterForManager).toHaveBeenCalledWith(collabManager, "collaboration");
    expect(resolveSpecialistRosterForProfile).not.toHaveBeenCalled();
    expect(collabWorker.specialistDisplayName).toBe("Local Shadow Collab");
    expect(collabWorker.specialistColor).toBe("#222");
    expect(saveStore).toHaveBeenCalled();
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
      modelId: "gpt-5.5",
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

  it("stopWorker calls external-thread interrupt service when available", async () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([[codex.agentId, codex]]);
    const interruptExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      const descriptor = descriptors.get(agentId);
      if (descriptor) {
        descriptor.status = "idle";
      }
    });
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});
    const refreshSessionMetaStatsBySessionId = vi.fn(async () => {});

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        interruptExternalThreadSidecarTurn,
        updateSessionMetaForWorkerDescriptor,
        refreshSessionMetaStatsBySessionId
      })
    );

    await svc.stopWorker(codex.agentId);

    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledTimes(1);
    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId);
    expect(codex.status).toBe("idle");
    expect(updateSessionMetaForWorkerDescriptor).toHaveBeenCalledWith(codex);
    expect(refreshSessionMetaStatsBySessionId).toHaveBeenCalledWith("m1");
  });

  it("stopSession preserves Codex external-thread workers with idle status instead of terminated", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "streaming"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);

    const runRuntimeShutdown = vi.fn(async () => ({ timedOut: false, runtimeToken: 1 }));
    const deleteConversationHistory = vi.fn();
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});
    const refreshSessionMetaStatsBySessionId = vi.fn(async () => {});
    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        runRuntimeShutdown,
        deleteConversationHistory,
        updateSessionMetaForWorkerDescriptor,
        refreshSessionMetaStatsBySessionId,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");
    expect(terminatedWorkerIds).toEqual([]);
    expect(descriptors.has(codex.agentId)).toBe(true);
    expect(codex.status).toBe("idle");
    expect(runRuntimeShutdown).not.toHaveBeenCalled();
    expect(deleteConversationHistory).not.toHaveBeenCalled();
    expect(updateSessionMetaForWorkerDescriptor).toHaveBeenCalledWith(codex);
    expect(refreshSessionMetaStatsBySessionId).toHaveBeenCalledWith("m1");
  });

  it("stopSession uses external-thread interrupt service when available", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const interruptExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      const descriptor = descriptors.get(agentId);
      if (descriptor) {
        descriptor.status = "idle";
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        interruptExternalThreadSidecarTurn,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");

    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledTimes(1);
    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId);
    expect(terminatedWorkerIds).toEqual([]);
    expect(descriptors.has(codex.agentId)).toBe(true);
    expect(codex.status).toBe("idle");
  });

  it("stopSession reports only deleted Forge workers in terminatedWorkerIds when Codex sidecar is preserved", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const forgeWorker = createWorkerDescriptor("/p", "m1", {
      agentId: "w1",
      status: "streaming"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [forgeWorker.agentId, forgeWorker],
      [codex.agentId, codex]
    ]);

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map([
          [forgeWorker.agentId, makeRuntimeStub({ descriptor: forgeWorker, getStatus: () => "streaming" })]
        ]),
        runRuntimeShutdown: vi.fn(async () => ({ timedOut: false, runtimeToken: 1 })),
        getWorkersForManager: vi.fn(() => [forgeWorker, codex])
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");
    expect(terminatedWorkerIds).toEqual(["w1"]);
    expect(descriptors.has(codex.agentId)).toBe(true);
    expect(codex.status).toBe("idle");
    expect(forgeWorker.status).toBe("terminated");
  });

  it("stopSession emits manual stop notice when only a streaming Codex sidecar is interrupted", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const emitImmediateManualManagerStopNotice = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        emitImmediateManualManagerStopNotice,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    await svc.stopSession("m1");

    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledTimes(1);
    expect(emitImmediateManualManagerStopNotice).toHaveBeenCalledWith("m1");
    expect(codex.status).toBe("idle");
  });

  it("stopSession leaves a terminated Codex sidecar terminated instead of resurrecting it to idle", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "terminated"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        updateSessionMetaForWorkerDescriptor,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const { terminatedWorkerIds } = await svc.stopSession("m1");

    expect(terminatedWorkerIds).toEqual([]);
    expect(descriptors.has(codex.agentId)).toBe(true);
    expect(codex.status).toBe("terminated");
    expect(updateSessionMetaForWorkerDescriptor).not.toHaveBeenCalled();
  });

  it("stopSession does not emit manual stop notice for an already-idle Codex sidecar", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "idle"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const emitImmediateManualManagerStopNotice = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        emitImmediateManualManagerStopNotice,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    await svc.stopSession("m1");

    expect(emitImmediateManualManagerStopNotice).not.toHaveBeenCalled();
    expect(codex.status).toBe("idle");
  });

  it("stopAllAgents uses external-thread interrupt service when available", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const interruptExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      const descriptor = descriptors.get(agentId);
      if (descriptor) {
        descriptor.status = "idle";
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        interruptExternalThreadSidecarTurn,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const result = await svc.stopAllAgents(manager.agentId, manager.agentId);

    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledTimes(1);
    expect(interruptExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId);
    expect(result.stoppedWorkerIds).toEqual([codex.agentId]);
    expect(codex.status).toBe("idle");
  });

  it("stopAllAgents leaves a terminated Codex sidecar terminated and omits it from stoppedWorkerIds", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "terminated"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const emitImmediateManualManagerStopNotice = vi.fn();
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        emitImmediateManualManagerStopNotice,
        updateSessionMetaForWorkerDescriptor,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const result = await svc.stopAllAgents(manager.agentId, manager.agentId);

    expect(result.stoppedWorkerIds).toEqual([]);
    expect(codex.status).toBe("terminated");
    expect(emitImmediateManualManagerStopNotice).not.toHaveBeenCalled();
    expect(updateSessionMetaForWorkerDescriptor).not.toHaveBeenCalled();
  });

  it("stopAllAgents does not count an already-idle Codex sidecar in stoppedWorkerIds or emit stop notice", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "idle"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const emitImmediateManualManagerStopNotice = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        runtimes: new Map(),
        emitImmediateManualManagerStopNotice,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const result = await svc.stopAllAgents(manager.agentId, manager.agentId);

    expect(result.stoppedWorkerIds).toEqual([]);
    expect(emitImmediateManualManagerStopNotice).not.toHaveBeenCalled();
    expect(codex.status).toBe("idle");
  });

  it("deleteSession uses external-thread terminate cleanup service without changing terminated semantics", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const interruptExternalThreadSidecarTurn = vi.fn(async () => {});
    const terminateExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      const descriptor = descriptors.get(agentId);
      if (descriptor) {
        descriptor.status = "idle";
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        interruptExternalThreadSidecarTurn,
        terminateExternalThreadSidecarTurn,
        getWorkersForManager: vi.fn(() => [codex])
      })
    );

    const { terminatedWorkerIds } = await svc.stopSessionInternal("m1", {
      saveStore: false,
      emitSnapshots: false,
      emitStatus: false,
      deleteWorkers: true,
      manualStopNotice: false,
      taskLifecycle: "none"
    });

    expect(interruptExternalThreadSidecarTurn).not.toHaveBeenCalled();
    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledTimes(1);
    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId);
    expect(terminatedWorkerIds).toEqual([codex.agentId]);
    expect(codex.status).toBe("terminated");
  });

  it("deleteSession clears fake shared busy state for other sidecars", async () => {
    const managerA = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const managerB = createAgentDescriptor({
      agentId: "m2",
      role: "manager",
      managerId: "m2",
      profileId: "m2",
      status: "idle"
    });
    const codexA = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      agentId: "m1--codex",
      status: "streaming"
    });
    const codexB = createCodexExternalThreadWorkerDescriptor("/p", "m2", {
      agentId: "m2--codex",
      status: "idle"
    });
    const descriptors = new Map([
      [managerA.agentId, managerA],
      [managerB.agentId, managerB],
      [codexA.agentId, codexA],
      [codexB.agentId, codexB]
    ]);
    let globallyBusySidecarId: string | undefined = codexA.agentId;
    const startFakeTurn = (sidecarAgentId: string) => {
      if (globallyBusySidecarId && globallyBusySidecarId !== sidecarAgentId) {
        throw new Error(`busy:${globallyBusySidecarId}`);
      }
      globallyBusySidecarId = sidecarAgentId;
    };
    const terminateExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      if (globallyBusySidecarId === agentId) {
        globallyBusySidecarId = undefined;
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        terminateExternalThreadSidecarTurn,
        getWorkersForManager: vi.fn((managerId: string) =>
          Array.from(descriptors.values()).filter(
            (descriptor) => descriptor.role === "worker" && descriptor.managerId === managerId,
          ),
        )
      })
    );

    await svc.stopSessionInternal("m1", {
      saveStore: false,
      emitSnapshots: false,
      emitStatus: false,
      deleteWorkers: true,
      manualStopNotice: false,
      taskLifecycle: "none"
    });

    expect(globallyBusySidecarId).toBeUndefined();
    expect(() => startFakeTurn(codexB.agentId)).not.toThrow();
    expect(globallyBusySidecarId).toBe(codexB.agentId);
  });

  it("killAgent uses external-thread terminate cleanup service without changing terminated semantics", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      status: "streaming"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codex.agentId, codex]
    ]);
    const emitStatus = vi.fn();
    const updateSessionMetaForWorkerDescriptor = vi.fn(async () => {});
    const interruptExternalThreadSidecarTurn = vi.fn(async () => {});
    const terminateExternalThreadSidecarTurn = vi.fn(async () => {
      codex.status = "idle";
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        assertManager: () => manager,
        emitStatus,
        updateSessionMetaForWorkerDescriptor,
        interruptExternalThreadSidecarTurn,
        terminateExternalThreadSidecarTurn
      })
    );

    await svc.killAgent("m1", codex.agentId);

    expect(interruptExternalThreadSidecarTurn).not.toHaveBeenCalled();
    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledTimes(1);
    expect(terminateExternalThreadSidecarTurn).toHaveBeenCalledWith(codex.agentId);
    expect(descriptors.has(codex.agentId)).toBe(true);
    expect(codex.status).toBe("terminated");
    expect(emitStatus).toHaveBeenCalledWith(codex.agentId, "terminated", 0);
    expect(updateSessionMetaForWorkerDescriptor).toHaveBeenCalledWith(codex);
  });

  it("killAgent clears fake shared busy state for other sidecars", async () => {
    const manager = createAgentDescriptor({
      agentId: "m1",
      role: "manager",
      managerId: "m1",
      profileId: "m1",
      status: "idle"
    });
    const codexA = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      agentId: "m1--codex",
      status: "streaming"
    });
    const codexB = createCodexExternalThreadWorkerDescriptor("/p", "m1", {
      agentId: "m1--codex-2",
      status: "idle"
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [codexA.agentId, codexA],
      [codexB.agentId, codexB]
    ]);
    let globallyBusySidecarId: string | undefined = codexA.agentId;
    const startFakeTurn = (sidecarAgentId: string) => {
      if (globallyBusySidecarId && globallyBusySidecarId !== sidecarAgentId) {
        throw new Error(`busy:${globallyBusySidecarId}`);
      }
      globallyBusySidecarId = sidecarAgentId;
    };
    const terminateExternalThreadSidecarTurn = vi.fn(async (agentId: string) => {
      if (globallyBusySidecarId === agentId) {
        globallyBusySidecarId = undefined;
      }
    });

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        assertManager: () => manager,
        terminateExternalThreadSidecarTurn
      })
    );

    await svc.killAgent("m1", codexA.agentId);

    expect(globallyBusySidecarId).toBeUndefined();
    expect(() => startFakeTurn(codexB.agentId)).not.toThrow();
    expect(globallyBusySidecarId).toBe(codexB.agentId);
  });

  it("getOrCreateRuntimeForDescriptor rejects Codex external-thread sidecars", async () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1");
    const descriptors = new Map([[codex.agentId, codex]]);
    const createRuntimeForDescriptor = vi.fn();

    const svc = new SwarmAgentLifecycleService(
      baseLifecycleOptions({
        descriptors,
        createRuntimeForDescriptor
      })
    );

    await expect(svc.getOrCreateRuntimeForDescriptor(codex)).rejects.toThrow(/external-thread sidecar/);
    expect(createRuntimeForDescriptor).not.toHaveBeenCalled();
  });

  it("resumeWorker rejects Codex external-thread sidecars", async () => {
    const codex = createCodexExternalThreadWorkerDescriptor("/p", "m1");
    const descriptors = new Map([[codex.agentId, codex]]);
    const svc = new SwarmAgentLifecycleService(baseLifecycleOptions({ descriptors }));

    await expect(svc.resumeWorker(codex.agentId)).rejects.toThrow(/does not use Forge runtime resume/);
  });
});
