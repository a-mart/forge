import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmAgentRuntime } from "../runtime-contracts.js";
import {
  ProjectExecutableTrustCoordinator,
  type ProjectExecutableTrustCoordinatorHost,
  type ProjectExecutableTrustDeferredPlanPort,
  type ProjectExecutableTrustResourceAccess,
  type ProjectExecutableTrustRuntimeRecoveryPort,
} from "../project-executable-trust-coordinator.js";
import type { ProjectExecutableTrustPlan } from "../project-executable-trust.js";
import type { ProjectWorkspaceResolution } from "../project-workspace-resolver.js";
import type {
  AgentDescriptor,
  ChoiceAnswer,
  ChoiceQuestion,
  SwarmConfig,
} from "../types.js";

const TRUST_KEY_A = "/repo-a/.forge";
const TRUST_KEY_B = "/repo-b/.forge";

describe("ProjectExecutableTrustCoordinator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("deduplicates current prompts and records manage-later dismissal", async () => {
    const manager = makeManager("manager-a");
    const harness = new CoordinatorHarness([manager]);
    harness.resources.setResolution(manager.agentId, makeResolution(manager, TRUST_KEY_A));

    let answer!: (answers: ChoiceAnswer[]) => void;
    harness.choiceImplementation = () => new Promise((resolve) => {
      answer = resolve;
    });
    const coordinator = harness.createCoordinator();

    const first = coordinator.maybePrompt(manager);
    await vi.waitFor(() => expect(harness.choiceRequests).toHaveLength(1));
    const duplicate = coordinator.maybePrompt(manager);
    await duplicate;
    expect(harness.choiceRequests).toHaveLength(1);

    answer([{ questionId: "repo_executable_trust", selectedOptionIds: ["manage_later"] }]);
    await first;

    expect(harness.resources.dismissed.get(TRUST_KEY_A)).toBe("signature-manager-a");
    expect(harness.choiceRequests[0]?.questions[0]?.options?.map((option) => option.id)).toEqual([
      "trust",
      "block",
      "manage_later",
    ]);
  });

  it("suppresses collab, absent-surface, dismissed, and stale prompt answers", async () => {
    const collab = makeManager("collab", { collab: { workspaceId: "w", channelId: "c" } });
    const noSurface = makeManager("no-surface");
    const dismissed = makeManager("dismissed");
    const stale = makeManager("stale");
    const harness = new CoordinatorHarness([collab, noSurface, dismissed, stale]);
    harness.resources.setResolution(collab.agentId, makeResolution(collab, "/collab/.forge"));
    harness.resources.setResolution(noSurface.agentId, makeResolution(noSurface, "/none/.forge"));
    harness.resources.setResolution(dismissed.agentId, makeResolution(dismissed, "/dismissed/.forge"));
    harness.resources.setResolution(stale.agentId, makeResolution(stale, TRUST_KEY_A));
    harness.resources.dismissed.set("/dismissed/.forge", `signature-${dismissed.agentId}`);
    harness.existingPaths.delete(`/repo-${noSurface.agentId}/.forge/extensions`);
    const coordinator = harness.createCoordinator();

    coordinator.schedulePrompt(collab);
    await coordinator.maybePrompt(noSurface);
    await coordinator.maybePrompt(dismissed);
    harness.choiceImplementation = async () => {
      harness.resources.trustState.set(TRUST_KEY_A, "blocked");
      await coordinator.applyTrustChange(TRUST_KEY_A);
      return [{ questionId: "repo_executable_trust", selectedOptionIds: ["trust"] }];
    };
    await coordinator.maybePrompt(stale);

    expect(harness.choiceRequests).toHaveLength(1);
    expect(harness.resources.trustState.get(TRUST_KEY_A)).toBe("blocked");
    expect(harness.deferredSet).not.toHaveBeenCalled();
  });

  it("keeps the pre-acceptance plan during activation and cleans up after partial resolution", async () => {
    const managerA = makeManager("manager-a");
    const managerB = makeManager("manager-b");
    const harness = new CoordinatorHarness([managerA, managerB]);
    const resolutionA = makeResolution(managerA, TRUST_KEY_A);
    const resolutionB = makeResolution(managerB, TRUST_KEY_A);
    harness.resources.setResolution(managerA.agentId, resolutionA);
    harness.resources.setResolution(managerB.agentId, resolutionB);
    harness.resources.failManagerIds.add(managerB.agentId);
    harness.choiceImplementation = async () => [
      { questionId: "repo_executable_trust", selectedOptionIds: ["trust"] },
    ];

    let planWhileTrustWriteWasPending: ProjectExecutableTrustPlan | undefined;
    const coordinator = harness.createCoordinator({
      resolveRuntimePlan: async ({ descriptor }) => trustedPlan(
        descriptor.agentId === managerA.agentId ? resolutionA : resolutionB,
      ),
    });
    harness.resources.onSetTrust = async () => {
      planWhileTrustWriteWasPending = await coordinator.resolvePlanForRuntime({ descriptor: managerA });
    };

    await coordinator.maybePrompt(managerA);

    expect(planWhileTrustWriteWasPending?.trusted).toBe(false);
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerA })).resolves.toMatchObject({
      trusted: false,
    });
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerB })).resolves.toMatchObject({
      trusted: true,
    });
    expect(harness.recovery.hasPendingManagerRuntimeRecycle(managerA.agentId)).toBe(true);
    expect(harness.recovery.hasPendingManagerRuntimeRecycle(managerB.agentId)).toBe(false);
    expect(harness.logs).toContainEqual(expect.objectContaining({
      event: "project_resources:trust_activation:resolve_error",
      data: expect.objectContaining({ agentId: managerB.agentId }),
    }));

    coordinator.forgetManager(managerA.agentId);
    expect(harness.deferredClear).toHaveBeenCalledWith(TRUST_KEY_A);
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerA })).resolves.toMatchObject({
      trusted: true,
    });
  });

  it("keeps a deferred trust key until its last marked manager is forgotten", async () => {
    const managerA = makeManager("manager-a");
    const managerB = makeManager("manager-b");
    const harness = new CoordinatorHarness([managerA, managerB]);
    const resolutionA = makeResolution(managerA, TRUST_KEY_A);
    const resolutionB = makeResolution(managerB, TRUST_KEY_A);
    harness.resources.setResolution(managerA.agentId, resolutionA);
    harness.resources.setResolution(managerB.agentId, resolutionB);
    harness.choiceImplementation = async () => [
      { questionId: "repo_executable_trust", selectedOptionIds: ["trust"] },
    ];
    const coordinator = harness.createCoordinator({
      resolveRuntimePlan: async ({ descriptor }) => trustedPlan(
        descriptor.agentId === managerA.agentId ? resolutionA : resolutionB,
      ),
    });

    await coordinator.maybePrompt(managerA);
    harness.deferredClear.mockClear();
    coordinator.forgetManager(managerA.agentId);
    expect(harness.deferredClear).not.toHaveBeenCalled();
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerB })).resolves.toMatchObject({
      trusted: false,
    });

    coordinator.forgetManager(managerB.agentId);
    expect(harness.deferredClear).toHaveBeenCalledOnce();
    expect(harness.deferredClear).toHaveBeenCalledWith(TRUST_KEY_A);
  });

  it("fails closed when runtime trust-plan resolution throws", async () => {
    const manager = makeManager("manager-a");
    const harness = new CoordinatorHarness([manager]);
    const coordinator = harness.createCoordinator({
      resolveRuntimePlan: async () => {
        throw new Error("resolver unavailable");
      },
    });

    await expect(coordinator.resolvePlanForRuntime({ descriptor: manager })).resolves.toEqual({
      trusted: false,
      trustedForgeExtensionDirs: [],
      trustedPiExtensionDirs: [],
      trustedPiSettingsPaths: [],
    });
    expect(harness.logs).toContainEqual({
      event: "project_resources:runtime_trust_plan:error",
      data: {
        agentId: manager.agentId,
        role: "manager",
        message: "resolver unavailable",
      },
    });
  });

  it("invalidates workers and bounds a hanging manager runtime during a trust change", async () => {
    vi.useFakeTimers();
    const manager = makeManager("manager-a", { status: "streaming", streamingStartedAt: 10 });
    const worker = makeWorker("worker-a", manager.agentId);
    const harness = new CoordinatorHarness([manager, worker]);
    harness.resources.setResolution(manager.agentId, makeResolution(manager, TRUST_KEY_A));
    const terminate = vi.fn(async () => new Promise<void>(() => undefined));
    harness.runtimes.set(manager.agentId, { terminate });
    harness.runtimeTokens.set(manager.agentId, 7);
    const coordinator = harness.createCoordinator();

    const applying = coordinator.applyTrustChange(TRUST_KEY_A);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.events.slice(0, 6)).toEqual([
      `terminate:${worker.agentId}`,
      `suppress:${manager.agentId}:7`,
      `detach:${manager.agentId}:7`,
      `upsert:${manager.agentId}:idle`,
      `status:${manager.agentId}:idle`,
      `message:${manager.agentId}`,
    ]);
    expect(terminate).toHaveBeenCalledWith({
      abort: true,
      shutdownTimeoutMs: 2_000,
      drainTimeoutMs: 250,
    });

    await vi.advanceTimersByTimeAsync(2_250);
    await applying;
    expect(harness.events.slice(-3)).toEqual([
      `unsuppress:${manager.agentId}:7`,
      "save",
      "snapshot",
    ]);
    expect(manager.status).toBe("idle");
    expect(manager.streamingStartedAt).toBeUndefined();
  });

  it("invalidates in-flight creation and restores streaming state without a runtime", async () => {
    const manager = makeManager("manager-a", { status: "streaming", streamingStartedAt: 10 });
    const harness = new CoordinatorHarness([manager]);
    harness.resources.setResolution(manager.agentId, makeResolution(manager, TRUST_KEY_A));
    let rejectCreation!: (error: Error) => void;
    const creation = new Promise<void>((_resolve, reject) => {
      rejectCreation = reject;
    });
    harness.runtimeCreations.set(manager.agentId, creation);
    const coordinator = harness.createCoordinator();

    await coordinator.applyTrustChange(TRUST_KEY_A);
    rejectCreation(new Error("stale token"));
    await Promise.resolve();

    expect(harness.runtimeCreations.has(manager.agentId)).toBe(false);
    expect(harness.events.filter((event) => event === `clearToken:${manager.agentId}`)).toHaveLength(2);
    expect(harness.events).toContain(`status:${manager.agentId}:idle`);
    expect(harness.events).not.toContain(`message:${manager.agentId}`);
    expect(harness.events.slice(-2)).toEqual(["save", "snapshot"]);
  });

  it("fails open across individual propagation errors and records both failure classes", async () => {
    const manager = makeManager("manager-a");
    const worker = makeWorker("worker-a", manager.agentId);
    const harness = new CoordinatorHarness([manager, worker]);
    harness.resources.setResolution(manager.agentId, makeResolution(manager, TRUST_KEY_A));
    harness.terminationFailures.set(worker.agentId, new Error("worker termination failed"));
    harness.runtimes.set(manager.agentId, {
      terminate: vi.fn(async () => {
        throw new Error("manager termination failed");
      }),
    });
    harness.runtimeTokens.set(manager.agentId, 11);
    const coordinator = harness.createCoordinator();

    await expect(coordinator.applyTrustChange(TRUST_KEY_A)).resolves.toBeUndefined();

    expect(harness.events.slice(-3)).toEqual([
      `unsuppress:${manager.agentId}:11`,
      "save",
      "snapshot",
    ]);
    expect(harness.logs).toContainEqual({
      event: "project_resources:trust_change:propagation_errors",
      data: {
        workerFailures: [{ agentId: worker.agentId, message: "worker termination failed" }],
        managerFailures: [{ agentId: manager.agentId, message: "manager termination failed" }],
      },
    });
  });

  it("defers activation until idle and invalidates its workers exactly once", async () => {
    const manager = makeManager("manager-a");
    const worker = makeWorker("worker-a", manager.agentId);
    const harness = new CoordinatorHarness([manager, worker]);
    const resolution = makeResolution(manager, TRUST_KEY_A);
    harness.resources.setResolution(manager.agentId, resolution);
    harness.choiceImplementation = async () => [
      { questionId: "repo_executable_trust", selectedOptionIds: ["trust"] },
    ];
    harness.recycleDispositions.push("deferred", "recycled", "none");
    const coordinator = harness.createCoordinator({
      resolveRuntimePlan: async () => trustedPlan(resolution),
    });
    await coordinator.maybePrompt(manager);
    harness.events.length = 0;

    await expect(
      coordinator.applyManagerRuntimeRecyclePolicy(manager.agentId, "idle_transition"),
    ).resolves.toBe("deferred");
    expect(harness.events).not.toContain(`terminate:${worker.agentId}`);

    await expect(
      coordinator.applyManagerRuntimeRecyclePolicy(manager.agentId, "idle_transition"),
    ).resolves.toBe("recycled");
    await expect(
      coordinator.applyManagerRuntimeRecyclePolicy(manager.agentId, "idle_transition"),
    ).resolves.toBe("none");

    expect(harness.events.filter((event) => event === `terminate:${worker.agentId}`)).toHaveLength(1);
    expect(harness.events.filter((event) => event === "save")).toHaveLength(1);
    expect(harness.events.filter((event) => event === "snapshot")).toHaveLength(1);
    expect(harness.deferredClear).toHaveBeenCalledWith(TRUST_KEY_A);
  });

  it("persists a deferred recycle only at the before-runtime-use boundary", async () => {
    const manager = makeManager("manager-a");
    const harness = new CoordinatorHarness([manager]);
    harness.recovery.setPendingManagerRuntimeRecycle(manager.agentId, "project_agent_directory_change");
    harness.recycleDispositions.push("recycled");
    const coordinator = harness.createCoordinator();

    await coordinator.applyPendingManagerRuntimeRecycleBeforeRuntimeUse(manager);

    expect(harness.events).toEqual(["save", "snapshot"]);
  });

  it("clears only the changed workspace's deferred activation", async () => {
    const managerA = makeManager("manager-a");
    const managerB = makeManager("manager-b", { cwd: "/repo-b" });
    const workerA = makeWorker("worker-a", managerA.agentId);
    const workerB = makeWorker("worker-b", managerB.agentId);
    const harness = new CoordinatorHarness([managerA, managerB, workerA, workerB]);
    const resolutionA = makeResolution(managerA, TRUST_KEY_A, "workspace-a");
    const resolutionB = makeResolution(managerB, TRUST_KEY_B, "workspace-b");
    harness.resources.setResolution(managerA.agentId, resolutionA);
    harness.resources.setResolution(managerB.agentId, resolutionB);
    harness.choiceImplementation = async () => [
      { questionId: "repo_executable_trust", selectedOptionIds: ["trust"] },
    ];
    const coordinator = harness.createCoordinator({
      resolveRuntimePlan: async ({ descriptor }) => trustedPlan(
        descriptor.agentId === managerA.agentId ? resolutionA : resolutionB,
      ),
    });

    await coordinator.maybePrompt(managerA);
    await coordinator.maybePrompt(managerB);
    harness.events.length = 0;
    harness.deferredClear.mockClear();
    await coordinator.applyWorkspaceChange("workspace-a");

    expect(harness.events).toContain(`terminate:${workerA.agentId}`);
    expect(harness.events).not.toContain(`terminate:${workerB.agentId}`);
    expect(harness.recovery.hasPendingManagerRuntimeRecycle(managerA.agentId)).toBe(false);
    expect(harness.recovery.hasPendingManagerRuntimeRecycle(managerB.agentId)).toBe(true);
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerA })).resolves.toMatchObject({
      trusted: true,
    });
    await expect(coordinator.resolvePlanForRuntime({ descriptor: managerB })).resolves.toMatchObject({
      trusted: false,
    });
    expect(harness.deferredClear).toHaveBeenCalledWith(TRUST_KEY_A);
    expect(harness.deferredClear).not.toHaveBeenCalledWith(TRUST_KEY_B);
  });
});

class CoordinatorHarness {
  readonly resources = new ResourceHarness();
  readonly recovery = new RecoveryHarness();
  readonly deferredSet = vi.fn();
  readonly deferredClear = vi.fn();
  readonly choiceRequests: Array<{ agentId: string; questions: ChoiceQuestion[] }> = [];
  readonly runtimes = new Map<string, Pick<SwarmAgentRuntime, "terminate">>();
  readonly runtimeTokens = new Map<string, number>();
  readonly runtimeCreations = new Map<string, Promise<unknown>>();
  readonly terminationFailures = new Map<string, Error>();
  readonly recycleDispositions: Array<"recycled" | "deferred" | "none"> = [];
  readonly events: string[] = [];
  readonly logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  choiceImplementation: (
    agentId: string,
    questions: ChoiceQuestion[],
  ) => Promise<ChoiceAnswer[]> = async () => [];

  constructor(readonly descriptors: AgentDescriptor[]) {
    for (const descriptor of descriptors) {
      if (descriptor.role === "manager") {
        this.existingPaths.add(`/repo-${descriptor.agentId}/.forge/extensions`);
      }
    }
  }

  readonly existingPaths = new Set<string>();

  createCoordinator(overrides: {
    resolveRuntimePlan?: (options: {
      descriptor: AgentDescriptor;
      sessionDescriptor?: AgentDescriptor;
    }) => Promise<ProjectExecutableTrustPlan>;
  } = {}): ProjectExecutableTrustCoordinator {
    const deferredPlans: ProjectExecutableTrustDeferredPlanPort = {
      setDeferredProjectExecutableTrustPlan: this.deferredSet,
      clearDeferredProjectExecutableTrustPlan: this.deferredClear,
    };
    const host: ProjectExecutableTrustCoordinatorHost = {
      listDescriptors: () => this.descriptors,
      requestUserChoice: async (agentId, questions) => {
        this.choiceRequests.push({ agentId, questions });
        return this.choiceImplementation(agentId, questions);
      },
      applyBaseManagerRuntimeRecyclePolicy: async () =>
        this.recycleDispositions.shift() ?? "none",
      terminateDescriptor: async (descriptor) => {
        this.events.push(`terminate:${descriptor.agentId}`);
        const failure = this.terminationFailures.get(descriptor.agentId);
        if (failure) throw failure;
      },
      getRuntime: (agentId) => this.runtimes.get(agentId),
      getRuntimeToken: (agentId) => this.runtimeTokens.get(agentId),
      getRuntimeCreationPromise: (agentId) => this.runtimeCreations.get(agentId),
      deleteRuntimeCreationPromise: (agentId) => {
        this.runtimeCreations.delete(agentId);
        this.events.push(`deleteCreation:${agentId}`);
      },
      clearRuntimeToken: (agentId, runtimeToken) => {
        this.events.push(`clearToken:${agentId}${runtimeToken === undefined ? "" : `:${runtimeToken}`}`);
      },
      suppressIntentionalStopRuntimeCallbacks: (agentId, runtimeToken) => {
        this.events.push(`suppress:${agentId}:${runtimeToken}`);
      },
      clearIntentionalStopRuntimeCallbackSuppression: (agentId, runtimeToken) => {
        this.events.push(`unsuppress:${agentId}:${runtimeToken}`);
      },
      detachRuntime: (agentId, runtimeToken) => {
        this.runtimes.delete(agentId);
        this.events.push(`detach:${agentId}:${runtimeToken}`);
        return true;
      },
      upsertDescriptorInLiveMaps: (descriptor) => {
        this.events.push(`upsert:${descriptor.agentId}:${descriptor.status}`);
      },
      emitStatus: (agentId, status) => {
        this.events.push(`status:${agentId}:${status}`);
      },
      emitTrustRuntimeRestartMessage: (agentId) => {
        this.events.push(`message:${agentId}`);
      },
      saveStore: async () => {
        this.events.push("save");
      },
      emitAgentsSnapshot: () => {
        this.events.push("snapshot");
      },
      now: () => "2026-07-13T12:00:00.000Z",
      logDebug: (event, data) => {
        this.logs.push({ event, data });
      },
    };

    return new ProjectExecutableTrustCoordinator({
      config: { paths: { dataDir: "/data" } } as SwarmConfig,
      host,
      runtimeRecovery: this.recovery,
      deferredPlans,
      createResourceAccess: this.resources.createAccess,
      resolveRuntimePlan: overrides.resolveRuntimePlan,
      pathExists: (pathValue) => this.existingPaths.has(pathValue),
    });
  }
}

class RecoveryHarness implements ProjectExecutableTrustRuntimeRecoveryPort {
  private readonly reasons = new Map<string, import("../runtime/runtime-recovery-state.js").ManagerRuntimeRecycleReason>();

  hasPendingManagerRuntimeRecycle(agentId: string): boolean {
    return this.reasons.has(agentId);
  }

  getPendingManagerRuntimeRecycleReason(agentId: string) {
    return this.reasons.get(agentId);
  }

  setPendingManagerRuntimeRecycle(
    agentId: string,
    reason: import("../runtime/runtime-recovery-state.js").ManagerRuntimeRecycleReason,
  ): void {
    this.reasons.set(agentId, reason);
  }

  clearPendingManagerRuntimeRecycle(agentId: string): void {
    this.reasons.delete(agentId);
  }
}

class ResourceHarness {
  readonly resolutions = new Map<string, ProjectWorkspaceResolution>();
  readonly failManagerIds = new Set<string>();
  readonly trustState = new Map<string, "trusted" | "blocked" | "untrusted">();
  readonly dismissed = new Map<string, string>();
  onSetTrust?: (key: string, action: "trust" | "block" | "reset") => Promise<void> | void;

  setResolution(agentId: string, resolution: ProjectWorkspaceResolution): void {
    this.resolutions.set(agentId, resolution);
    if (resolution.trust.key && !this.trustState.has(resolution.trust.key)) {
      this.trustState.set(resolution.trust.key, resolution.trust.state as "trusted" | "blocked" | "untrusted");
    }
  }

  readonly createAccess = (): ProjectExecutableTrustResourceAccess => ({
    settings: {
      getDismissedExecutablePrompt: async (key) => {
        const signature = this.dismissed.get(key);
        return signature ? { signature, dismissedAt: "2026-07-13T12:00:00.000Z" } : undefined;
      },
      setTrust: async (key, action) => {
        this.dismissed.delete(key);
        this.trustState.set(key, action === "reset" ? "untrusted" : action === "trust" ? "trusted" : "blocked");
        await this.onSetTrust?.(key, action);
        return {};
      },
      dismissExecutablePrompt: async (key, signature) => {
        this.dismissed.set(key, signature);
        return {};
      },
    },
    resolver: {
      resolve: async ({ sessionAgentId }) => {
        if (this.failManagerIds.has(sessionAgentId)) {
          throw new Error(`resolution failed for ${sessionAgentId}`);
        }
        const resolution = this.resolutions.get(sessionAgentId);
        if (!resolution) throw new Error(`missing resolution for ${sessionAgentId}`);
        const key = resolution.trust.key;
        return {
          ...resolution,
          trust: key
            ? { key, state: this.trustState.get(key) ?? resolution.trust.state }
            : resolution.trust,
        } as ProjectWorkspaceResolution;
      },
    },
  });
}

function makeManager(
  agentId: string,
  patch: Partial<AgentDescriptor> = {},
): AgentDescriptor & { role: "manager" } {
  return {
    agentId,
    displayName: agentId,
    managerId: agentId,
    profileId: "profile-a",
    status: "idle",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    cwd: "/repo-a",
    model: { provider: "test", modelId: "test", thinkingLevel: "none" },
    sessionFile: `/sessions/${agentId}.jsonl`,
    ...patch,
    role: "manager",
  };
}

function makeWorker(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...makeManager(agentId),
    role: "worker",
    managerId,
  };
}

function makeResolution(
  manager: AgentDescriptor,
  trustKey: string,
  workspaceKey = `workspace-${manager.agentId}`,
): ProjectWorkspaceResolution {
  return {
    profileId: manager.profileId ?? manager.agentId,
    sessionAgentId: manager.agentId,
    cwdRealpath: manager.cwd,
    detectedGitRoot: manager.cwd,
    workspaceKey,
    defaultForgeDir: trustKey,
    effectiveForgeDir: trustKey,
    effectiveForgeDirRealpath: trustKey,
    source: "git-root",
    trust: { key: trustKey, state: "untrusted" },
    repoRootResources: {
      forgeExtensionsDir: `/repo-${manager.agentId}/.forge/extensions`,
    },
    legacyExecutableSurfaces: [],
    signature: `signature-${manager.agentId}`,
  };
}

function trustedPlan(resolution: ProjectWorkspaceResolution): ProjectExecutableTrustPlan {
  return {
    resolution: {
      ...resolution,
      trust: resolution.trust.key
        ? { key: resolution.trust.key, state: "trusted" }
        : resolution.trust,
    },
    trusted: true,
    effectiveForgeDirRealpath: resolution.effectiveForgeDirRealpath,
    trustedForgeExtensionDirs: resolution.repoRootResources.forgeExtensionsDir
      ? [resolution.repoRootResources.forgeExtensionsDir]
      : [],
    trustedPiExtensionDirs: [],
    trustedPiSettingsPaths: [],
  };
}
