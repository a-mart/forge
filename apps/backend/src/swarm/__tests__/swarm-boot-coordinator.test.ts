import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BootReconciler } from "../agents/descriptor-store/boot-reconciler.js";
import {
  prunePersistedWorkerSidecars,
  WorkerBootRecovery,
} from "../agents/descriptor-store/worker-boot-recovery.js";
import { getWorkerSessionFilePath } from "../data-paths.js";
import type { RestartRecoveryCoordinator } from "../restart-recovery-coordinator.js";
import {
  SwarmBootCoordinator,
  type BootDomainPort,
  type BootPreparationPort,
  type BootPublicationPort,
  type BootRuntimePort,
  type BootSessionStatePort,
} from "../swarm-boot-coordinator.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SwarmBootCoordinator", () => {
  it("keeps persisted, recovery, session-meta, runtime, and publication phases ordered", async () => {
    const order: string[] = [];
    const harness = createHarness(order);
    await harness.coordinator.boot();

    expect(order).toEqual([
      "ensureDirectories",
      "migrateSharedConfigLayout",
      "cleanupOldSharedConfigPaths",
      "removeRetiredPlanningArtifacts",
      "ensureCanonicalAuthFilePath",
      "reloadModelCatalog",
      "loadSecrets",
      "loadCompactionSettings",
      "reloadSkillMetadata",
      "resolveDefaultCwd",
      "refreshDefaultMemoryTemplate",
      "loadAndReconcilePersistedStore",
      "normalizeCodexPluginWorkers",
      "ensureCortexProfile",
      "loadOnboardingState",
      "ensureLegacyProfileKnowledgeReferenceDocs",
      "restartRecovery",
      "recoverMissingWorkers",
      "reconcileWorkerSpecialistMetadata",
      "reconcileProjectAgentMirror",
      "reconcileProjectAgentSharing",
      "initializeSecureSessions",
      "ensureMemoryFiles",
      "saveStore",
      "rebuildSessionManifest",
      "hydrateCompactionCounts",
      "startCompactionCountBackfill",
      "loadConversationHistories",
      "listPrompts",
      "emitAgentsSnapshot",
      "emitProfilesSnapshot",
      "scheduleProjectExecutableTrustPrompts",
      "startWorkerHealth",
      "scheduleGoalContinuations",
    ]);
    expect(harness.readyLog).toHaveBeenCalledWith("boot:ready", expect.objectContaining({
      loadedArchetypeIds: ["manager", "researcher"],
      restoredAgentIds: [],
    }));
  });

  it("consults runtime eligibility and contains a non-primary restore failure", async () => {
    const order: string[] = [];
    const manager = descriptor({ agentId: "manager", role: "manager", managerId: "manager" });
    const worker = descriptor({
      agentId: "worker",
      role: "worker",
      managerId: "manager",
      status: "streaming",
    });
    const descriptors = new Map([
      [manager.agentId, manager],
      [worker.agentId, worker],
    ]);
    const shouldRestore = vi.fn((candidate: AgentDescriptor) => candidate.agentId === worker.agentId);
    const restore = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const emitStatus = vi.fn();
    const upsertDescriptor = vi.fn((candidate: AgentDescriptor) => {
      descriptors.set(candidate.agentId, candidate);
    });
    const harness = createHarness(order, {
      descriptors,
      config: config({ managerId: undefined }),
      runtime: { shouldRestore, restore, emitStatus },
      upsertDescriptor,
    });

    await harness.coordinator.boot();

    expect(shouldRestore).toHaveBeenCalledWith(worker);
    expect(restore).toHaveBeenCalledWith(worker);
    expect(worker.status).toBe("stopped");
    expect(emitStatus).toHaveBeenCalledWith("worker", "stopped", 0);
    expect(upsertDescriptor).toHaveBeenCalledWith(worker);
    expect(order.filter((entry) => entry === "saveStore")).toHaveLength(2);
  });

  it("adds stable context to invalid default cwd failures", async () => {
    const harness = createHarness([], {
      resolveDefaultCwd: async () => {
        throw new Error("not a directory");
      },
    });
    await expect(harness.coordinator.boot()).rejects.toThrow(
      "Invalid default working directory: not a directory",
    );
  });
});

describe("worker boot recovery", () => {
  it("prunes only persisted cache-sidecar worker descriptors", () => {
    const manager = descriptor({ agentId: "manager", role: "manager", managerId: "manager" });
    const worker = descriptor({ agentId: "worker", role: "worker", managerId: "manager" });
    const sidecarById = descriptor({
      agentId: "worker.conversation",
      role: "worker",
      managerId: "manager",
    });
    const sidecarByFile = descriptor({
      agentId: "other",
      role: "worker",
      managerId: "manager",
      sessionFile: "/tmp/other.jsonl.conversation.jsonl",
    });
    const logDebug = vi.fn();

    const result = prunePersistedWorkerSidecars(
      { agents: [manager, worker, sidecarById, sidecarByFile] },
      logDebug,
    );

    expect(result.pruned).toBe(true);
    expect(result.store.agents.map((entry) => entry.agentId)).toEqual(["manager", "worker"]);
    expect(logDebug).toHaveBeenCalledWith("boot:worker_sidecar_descriptors:pruned", {
      removedAgents: 2,
    });
  });

  it("recovers canonical transcripts with header metadata and ignores cache sidecars", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-worker-boot-"));
    tempDirs.push(dataDir);
    const manager = descriptor({
      agentId: "manager",
      role: "manager",
      managerId: "manager",
      profileId: "profile",
    });
    const descriptors = new Map([[manager.agentId, manager]]);
    const workerFile = getWorkerSessionFilePath(dataDir, "profile", "manager", "worker-1");
    await mkdir(dirname(workerFile), { recursive: true });
    await writeFile(workerFile, [
      JSON.stringify({ type: "session", timestamp: "2026-01-02T03:04:05.000Z", cwd: "/repo" }),
      JSON.stringify({ type: "model_change", timestamp: "2026-01-02T04:00:00.000Z", provider: "openai-codex", modelId: "gpt-5" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
      "",
    ].join("\n"));
    await writeFile(join(dirname(workerFile), "ghost.jsonl.conversation.jsonl"), "{}\n");
    const logDebug = vi.fn();
    const recovery = new WorkerBootRecovery({
      dataDir,
      descriptors,
      upsertDescriptor: (candidate) => descriptors.set(candidate.agentId, candidate),
      logDebug,
    });

    await expect(recovery.recoverMissingDescriptors()).resolves.toEqual(["worker-1"]);
    expect(descriptors.get("worker-1")).toEqual(expect.objectContaining({
      status: "terminated",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T04:00:00.000Z",
      cwd: "/repo",
      model: { provider: "openai-codex", modelId: "gpt-5", thinkingLevel: "high" },
    }));
    expect(descriptors.has("ghost.jsonl.conversation")).toBe(false);
    expect(logDebug).toHaveBeenCalledWith("boot:recover_missing_workers", {
      recoveredCount: 1,
      recoveredIds: ["worker-1"],
      truncated: false,
    });
  });
});

function createHarness(
  order: string[],
  overrides: {
    descriptors?: Map<string, AgentDescriptor>;
    config?: SwarmConfig;
    resolveDefaultCwd?: (cwd: string) => Promise<string>;
    runtime?: Partial<BootRuntimePort>;
    upsertDescriptor?: (descriptor: AgentDescriptor) => void;
  } = {},
) {
  const descriptors = overrides.descriptors ?? new Map<string, AgentDescriptor>();
  const mark = (name: string) => async () => {
    order.push(name);
  };
  const preparation: BootPreparationPort = {
    ensureDirectories: mark("ensureDirectories"),
    migrateSharedConfigLayout: mark("migrateSharedConfigLayout"),
    cleanupOldSharedConfigPaths: mark("cleanupOldSharedConfigPaths"),
    removeRetiredPlanningArtifacts: mark("removeRetiredPlanningArtifacts"),
    ensureCanonicalAuthFilePath: mark("ensureCanonicalAuthFilePath"),
    reloadModelCatalog: mark("reloadModelCatalog"),
    loadSecrets: mark("loadSecrets"),
    loadCompactionSettings: mark("loadCompactionSettings"),
    reloadSkillMetadata: mark("reloadSkillMetadata"),
    resolveDefaultCwd: overrides.resolveDefaultCwd ?? (async (cwd) => {
      order.push("resolveDefaultCwd");
      return cwd;
    }),
    refreshDefaultMemoryTemplate: mark("refreshDefaultMemoryTemplate"),
  };
  const domains: BootDomainPort = {
    normalizeCodexPluginWorkers: () => {
      order.push("normalizeCodexPluginWorkers");
      return false;
    },
    reconcileWorkerSpecialistMetadata: mark("reconcileWorkerSpecialistMetadata"),
    ensureCortexProfile: mark("ensureCortexProfile"),
    loadOnboardingState: mark("loadOnboardingState"),
    ensureLegacyProfileKnowledgeReferenceDocs: mark("ensureLegacyProfileKnowledgeReferenceDocs"),
    reconcileProjectAgentMirror: mark("reconcileProjectAgentMirror"),
    reconcileProjectAgentSharing: mark("reconcileProjectAgentSharing"),
  };
  const sessions: BootSessionStatePort = {
    ensureMemoryFiles: mark("ensureMemoryFiles"),
    rebuildSessionManifest: mark("rebuildSessionManifest"),
    hydrateCompactionCounts: mark("hydrateCompactionCounts"),
    startCompactionCountBackfill: () => order.push("startCompactionCountBackfill"),
    loadConversationHistories: () => order.push("loadConversationHistories"),
  };
  const runtimes: BootRuntimePort = {
    sortedDescriptors: () => [...descriptors.values()],
    shouldRestore: () => false,
    restore: async () => {},
    hasRuntime: () => false,
    restoredAgentIds: () => [],
    emitStatus: () => {},
    ...overrides.runtime,
  };
  const publication: BootPublicationPort = {
    listPrompts: async () => {
      order.push("listPrompts");
      return [
        { category: "archetype", promptId: "researcher" },
        { category: "operational", promptId: "template" },
        { category: "archetype", promptId: "manager" },
      ];
    },
    emitAgentsSnapshot: () => order.push("emitAgentsSnapshot"),
    emitProfilesSnapshot: () => order.push("emitProfilesSnapshot"),
    scheduleProjectExecutableTrustPrompts: () => order.push("scheduleProjectExecutableTrustPrompts"),
    startWorkerHealth: () => order.push("startWorkerHealth"),
    scheduleGoalContinuations: () => order.push("scheduleGoalContinuations"),
  };
  const readyLog = vi.fn();
  const logDebug = vi.fn((message: string, details?: unknown) => {
    if (message === "boot:ready") readyLog(message, details);
  });
  const coordinator = new SwarmBootCoordinator({
    config: overrides.config ?? config(),
    descriptors,
    storeReconciler: {
      loadAndReconcilePersistedStore: mark("loadAndReconcilePersistedStore"),
    } as unknown as BootReconciler,
    restartRecovery: {
      reconcileForBoot: mark("restartRecovery"),
    } as unknown as RestartRecoveryCoordinator,
    workerRecovery: {
      recoverMissingDescriptors: mark("recoverMissingWorkers"),
    } as unknown as WorkerBootRecovery,
    preparation,
    domains,
    sessions,
    secureSessions: {
      initializeForBoot: async () => {
        order.push("initializeSecureSessions");
        return { destroyedSandboxIds: [] };
      },
    },
    runtimes,
    publication,
    store: {
      save: mark("saveStore"),
      upsertDescriptor: overrides.upsertDescriptor ?? ((candidate) => descriptors.set(candidate.agentId, candidate)),
    },
    now: () => "2026-07-13T12:00:00.000Z",
    logDebug,
  });
  return { coordinator, readyLog };
}

function descriptor(overrides: Partial<AgentDescriptor> & Pick<AgentDescriptor, "agentId" | "role" | "managerId">): AgentDescriptor {
  return {
    displayName: overrides.agentId,
    status: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    model: { provider: "openai-codex", modelId: "gpt-5", thinkingLevel: "none" },
    sessionFile: `/tmp/${overrides.agentId}.jsonl`,
    ...overrides,
  };
}

function config(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    host: "127.0.0.1",
    port: 4711,
    debug: false,
    isDesktop: false,
    runtimeTarget: "builder",
    cortexEnabled: false,
    allowNonManagerSubscriptions: false,
    managerDisplayName: "Manager",
    defaultModel: { provider: "openai-codex", modelId: "gpt-5", thinkingLevel: "none" },
    defaultCwd: "/tmp",
    cwdAllowlistRoots: [],
    paths: {
      dataDir: "/tmp/data",
      sharedAuthFile: "/tmp/data/shared/auth/auth.json",
      managerAgentDir: "/tmp/manager",
    } as SwarmConfig["paths"],
    ...overrides,
  };
}
