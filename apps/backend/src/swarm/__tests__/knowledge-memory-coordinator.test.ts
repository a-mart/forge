import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as piAiCompat from "../pi/pi-ai-compat.js";
import * as piModelRegistry from "../pi-model-registry.js";
import {
  createLiveCompactionRuntimeSettingsProvider,
} from "../compaction-runtime-settings-provider.js";
import type { CompactionSettingsService } from "../compaction-settings-service.js";
import {
  getCommonKnowledgePath,
  getCortexConsolidationRunsPath,
  getCortexReviewLogPath,
  getProfileMemoryPath,
  getProfileMergeAuditLogPath,
  getSessionMemoryPath,
} from "../data-paths.js";
import {
  KnowledgeMemoryCoordinator,
  type KnowledgeMemoryCoordinatorOptions,
} from "../knowledge-memory-coordinator.js";
import type { KnowledgeEntry, KnowledgeService } from "../knowledge-service.js";
import type { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";
import type {
  AgentDescriptor,
  ManagerProfile,
  SwarmConfig,
} from "../types.js";

const NOW = "2026-07-13T21:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("KnowledgeMemoryCoordinator", () => {
  it("enforces knowledge policy and advances capture only after a saved learning", async () => {
    const harness = await createHarness();
    const manager = makeManager("session", "profile");
    const worker = makeWorker("worker", manager);
    harness.descriptors.set(manager.agentId, manager);
    harness.descriptors.set(worker.agentId, worker);

    await harness.coordinator.searchKnowledge(worker.agentId, {
      query: "testing",
      scope: "profile",
      limit: 3,
    });
    expect(harness.services.knowledge.searchEntries).toHaveBeenCalledWith({
      query: "testing",
      scope: "profile",
      profileId: "profile",
      limit: 3,
    });

    await expect(
      harness.coordinator.saveLearning(manager.agentId, {
        type: "convention",
        scope: "profile:profile",
        title: "Run focused tests",
        body: "Use direct Vitest paths.",
        evidence: "user-stated",
      }),
    ).resolves.toEqual(harness.knowledgeEntry);
    expect(harness.services.knowledge.saveLearning).toHaveBeenCalledWith({
      type: "convention",
      scope: "profile:profile",
      title: "Run focused tests",
      body: "Use direct Vitest paths.",
      evidence: "user-stated",
      sessionId: "session",
    });
    expect(harness.services.capture.noteLearningSaved).toHaveBeenCalledWith("session");

    harness.knowledgeEnabled = false;
    await expect(
      harness.coordinator.readKnowledgeEntry(manager.agentId, "entry-1"),
    ).rejects.toThrow("Knowledge v2 is disabled in Settings.");
    expect(harness.services.knowledge.readEntry).not.toHaveBeenCalled();

    harness.knowledgeEnabled = true;
    await expect(
      harness.coordinator.saveLearning(worker.agentId, {
        type: "pointer",
        scope: "global",
        title: "Pointer",
        body: "Body",
        evidence: "observed",
      }),
    ).rejects.toThrow("save_learning is manager-only.");
  });

  it("keeps mutable Builder validation ahead of session-memory merge", async () => {
    const harness = await createHarness();
    const manager = makeManager("session", "profile");
    harness.descriptors.set(manager.agentId, manager);
    harness.options.sessions.requireBuilderSession = vi.fn(() => manager);
    harness.options.sessions.assertMutable = vi.fn();

    await expect(harness.coordinator.mergeSessionMemory("session")).resolves.toEqual({
      agentId: "session",
      status: "merged",
      strategy: "llm",
      mergedAt: NOW,
      auditPath: "/audit",
    });
    expect(harness.options.sessions.requireBuilderSession).toHaveBeenCalledWith(
      "session",
      "merge Builder session memory",
    );
    expect(harness.options.sessions.assertMutable).toHaveBeenCalledWith(manager);
    expect(harness.services.memory.mergeSessionMemory).toHaveBeenCalledWith("session");

    harness.options.sessions.assertMutable = vi.fn(() => {
      throw new Error("archived");
    });
    await expect(harness.coordinator.mergeSessionMemory("session")).rejects.toThrow("archived");
    expect(harness.services.memory.mergeSessionMemory).toHaveBeenCalledTimes(1);
  });

  it("owns memory-path policy and fork-header persistence for managers and workers", async () => {
    const harness = await createHarness();
    const source = makeManager("source", "profile");
    source.sessionLabel = "Source session";
    const fork = makeManager("fork", "profile");
    const worker = makeWorker("worker", source);
    harness.descriptors.set(source.agentId, source);
    harness.descriptors.set(fork.agentId, fork);
    harness.descriptors.set(worker.agentId, worker);
    harness.options.cortexBootstrap.resolvePromptWithFallback = vi.fn(async () => [
      "# Fork",
      "$" + "{SOURCE_LABEL}",
      "$" + "{FORK_TIMESTAMP}",
    ].join("\n"));

    expect(harness.coordinator.getAgentMemoryPath(source.agentId)).toBe(
      getSessionMemoryPath(harness.dataDir, "profile", "source"),
    );
    expect(harness.coordinator.getAgentMemoryPath(worker.agentId)).toBe(
      getSessionMemoryPath(harness.dataDir, "profile", "source"),
    );
    expect(harness.coordinator.resolveMemoryOwnerAgentId(worker)).toBe("source");
    expect(harness.coordinator.resolveSessionProfileId(source.agentId)).toBe("profile");

    await harness.coordinator.writeForkedSessionMemoryHeader(source, fork.agentId, "message-7");
    const forkedMemory = await readFile(
      getSessionMemoryPath(harness.dataDir, "profile", "fork"),
      "utf8",
    );
    expect(forkedMemory).toContain("Source session");
    expect(forkedMemory).toContain(NOW);
    expect(forkedMemory).toContain("message-7");
    expect(harness.services.sessionMeta.refreshSessionMetaStatsBySessionId)
      .toHaveBeenCalledWith("fork");

    await harness.coordinator.appendSessionMemoryMergeAuditEntry({
      attemptId: "attempt-1",
      timestamp: NOW,
      sessionAgentId: "source",
      profileId: "profile",
      status: "merged",
      strategy: "llm",
      llmMergeSucceeded: true,
      usedFallbackAppend: false,
      appliedChange: true,
      model: "openai/gpt-5",
      sessionContentHash: "session-hash",
      profileContentHashBefore: "before",
      profileContentHashAfter: "after",
    });
    expect(await readFile(getProfileMergeAuditLogPath(harness.dataDir, "profile"), "utf8"))
      .toContain('"attemptId":"attempt-1"');
  });

  it("delegates compaction and Cortex operations without reimplementing their algorithms", async () => {
    const harness = await createHarness();
    const manager = makeManager("session", "profile");

    await harness.coordinator.compact("session", { trigger: "api" });
    await harness.coordinator.smartCompact("session", { trigger: "slash_command" });
    await harness.coordinator.listCortexConsolidationRuns();
    await harness.coordinator.getCortexConsolidationSnapshot();
    await harness.coordinator.runCortexConsolidation("manual");
    await harness.coordinator.maybeRunCortexConsolidationFromIncomingMessage(
      "consolidate",
      manager,
      { channel: "web" },
    );

    expect(harness.services.compaction.compact).toHaveBeenCalledWith("session", { trigger: "api" });
    expect(harness.services.compaction.smartCompact).toHaveBeenCalledWith("session", {
      trigger: "slash_command",
    });
    expect(harness.services.cortex.runConsolidation).toHaveBeenCalledWith("manual");
    expect(harness.services.cortex.maybeRunConsolidationFromIncomingMessage).toHaveBeenCalledWith(
      "consolidate",
      manager,
      { channel: "web" },
    );
  });

  it("runs the capture judge through candidate, auth, and response extraction paths", async () => {
    const harness = await createHarness();
    const model = { provider: "openai-codex", id: "gpt-5.4-mini" };
    const registry = {
      find: vi.fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(model),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
    };
    vi.spyOn(piModelRegistry, "createPiModelRegistry").mockReturnValue(registry as never);
    vi.spyOn(piAiCompat, "getModel").mockReturnValue(undefined as never);
    vi.spyOn(piAiCompat, "complete").mockResolvedValue({
      content: [{ type: "thinking", thinking: "ignored" }, { type: "text", text: "YES" }, { type: "text", text: "\n" }],
    } as never);

    await expect(harness.coordinator.executeCaptureJudgePrompt("candidate prompt")).resolves.toBe("YES");
    expect(registry.find).toHaveBeenNthCalledWith(1, "openai-codex", "gpt-5.4-mini");
    expect(registry.find).toHaveBeenNthCalledWith(2, "openai-codex", "gpt-5.4");
    expect(registry.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
    expect(piAiCompat.complete).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ messages: [{ role: "user", timestamp: expect.any(Number), content: [{ type: "text", text: "candidate prompt" }] }] }),
      { apiKey: "test-key" },
    );
  });

  it("fails closed when every capture judge candidate is unavailable", async () => {
    const harness = await createHarness();
    const registry = {
      find: vi.fn().mockReturnValue(undefined),
      getApiKeyAndHeaders: vi.fn(),
    };
    vi.spyOn(piModelRegistry, "createPiModelRegistry").mockReturnValue(registry as never);
    vi.spyOn(piAiCompat, "getModel").mockReturnValue(undefined as never);
    await expect(harness.coordinator.executeCaptureJudgePrompt("candidate prompt"))
      .rejects.toThrow("No configured cheap model is available");
    expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });

  it("skips an unauthorized candidate and uses the next configured model", async () => {
    const harness = await createHarness();
    const firstModel = { provider: "openai-codex", id: "gpt-5.4-mini" };
    const secondModel = { provider: "openai-codex", id: "gpt-5.4" };
    const registry = {
      find: vi.fn().mockReturnValueOnce(firstModel).mockReturnValueOnce(secondModel),
      getApiKeyAndHeaders: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "not configured" })
        .mockResolvedValueOnce({ ok: true, headers: { Authorization: "Bearer test" } }),
    };
    vi.spyOn(piModelRegistry, "createPiModelRegistry").mockReturnValue(registry as never);
    vi.spyOn(piAiCompat, "getModel").mockReturnValue(undefined as never);
    vi.spyOn(piAiCompat, "complete").mockResolvedValue({ content: [{ type: "text", text: "NO" }] } as never);
    await expect(harness.coordinator.executeCaptureJudgePrompt("candidate prompt")).resolves.toBe("NO");
    expect(piAiCompat.complete).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-5.4" }), expect.anything(), { headers: { Authorization: "Bearer test" } });
  });

  it("loads Builder compaction settings once and attaches only the selected live provider", async () => {
    const harness = await createHarness();
    const load = vi.fn(async () => undefined);
    const service = {
      load,
      getSettings: () => ({
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low" as const,
        timeoutMs: 123_000,
        updatedAt: null,
      }),
    } as unknown as CompactionSettingsService;
    harness.options.compactionSettings.createService = vi.fn(() => service);

    await harness.coordinator.loadCompactionSettingsForRuntime();
    await harness.coordinator.loadCompactionSettingsForRuntime();

    expect(load).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.getCompactionSettingsService()).toBe(service);
    expect(harness.coordinator.getCompactionRuntimeSettingsProvider().getCompactionRuntimeSettings())
      .toEqual({
        model: { provider: "openai-codex", modelId: "gpt-5.5" },
        reasoningLevel: "low",
        timeoutMs: 123_000,
      });

    const collaborationHarness = await createHarness({ runtimeTarget: "collaboration-server" });
    const createService = vi.fn(() => service);
    collaborationHarness.options.compactionSettings.createService = createService;
    await collaborationHarness.coordinator.loadCompactionSettingsForRuntime();
    expect(createService).not.toHaveBeenCalled();
    expect(collaborationHarness.coordinator.getCompactionSettingsService()).toBeNull();
  });

  it("materializes the Cortex system profile and operational files in a stable order", async () => {
    const harness = await createHarness();
    const calls: string[] = [];
    harness.options.cortexBootstrap.upsertDescriptor = (descriptor) => {
      calls.push("descriptor");
      harness.descriptors.set(descriptor.agentId, descriptor);
    };
    harness.options.cortexBootstrap.upsertProfile = (profile) => {
      calls.push("profile");
      harness.profiles.set(profile.profileId, profile);
    };
    harness.options.cortexBootstrap.ensureProfileDirectories = vi.fn(async () => {
      calls.push("profile-directories");
    });
    harness.options.cortexBootstrap.ensureSessionFileParent = vi.fn(async () => {
      calls.push("session-parent");
    });
    harness.services.memory.ensureAgentMemoryFile = vi.fn(async () => {
      calls.push("memory-file");
    });
    harness.services.sessionMeta.writeInitialSessionMeta = vi.fn(async () => {
      calls.push("initial-meta");
    });
    harness.services.sessionMeta.refreshSessionMetaStats = vi.fn(async () => {
      calls.push("refresh-meta");
    });

    await harness.coordinator.ensureCortexProfileForBoot();

    expect(harness.descriptors.get("cortex")).toMatchObject({
      role: "manager",
      profileId: "cortex",
      archetypeId: "cortex",
      cwd: "/workspace",
      modelOrigin: "profile_default",
    });
    expect(harness.profiles.get("cortex")).toMatchObject({
      defaultSessionAgentId: "cortex",
      profileType: "system",
    });
    expect(calls).toEqual([
      "descriptor",
      "profile",
      "profile-directories",
      "session-parent",
      "memory-file",
      "memory-file",
      "initial-meta",
      "refresh-meta",
    ]);
    expect(await readFile(getCommonKnowledgePath(harness.dataDir), "utf8"))
      .toBe("# Project common knowledge\n");
    expect(await readFile(getCortexReviewLogPath(harness.dataDir), "utf8")).toBe("");
    expect(JSON.parse(await readFile(getCortexConsolidationRunsPath(harness.dataDir), "utf8")))
      .toEqual({ version: 1, runs: [] });
    expect(harness.services.memory.ensureAgentMemoryFile).toHaveBeenNthCalledWith(
      2,
      getProfileMemoryPath(harness.dataDir, "cortex"),
      "cortex",
    );

    await harness.coordinator.ensureCortexProfileForBoot();
    expect(harness.services.memory.ensureAgentMemoryFile).toHaveBeenCalledTimes(2);
  });

  it("keeps post-store memory and session-meta boot steps on their focused services", async () => {
    const harness = await createHarness();
    const calls: string[] = [];
    harness.services.memory.ensureMemoryFilesForBoot = vi.fn(async () => calls.push("memory"));
    harness.services.sessionMeta.rebuildSessionManifestForBoot = vi.fn(async () => calls.push("rebuild"));
    harness.services.sessionMeta.hydrateCompactionCountsForBoot = vi.fn(async () => calls.push("hydrate"));
    harness.services.sessionMeta.startCompactionCountBackfill = vi.fn(() => calls.push("backfill"));

    await harness.coordinator.ensureMemoryFilesForBoot();
    await harness.coordinator.rebuildSessionManifestForBoot();
    await harness.coordinator.hydrateCompactionCountsForBoot();
    harness.coordinator.startCompactionCountBackfill();

    expect(calls).toEqual(["memory", "rebuild", "hydrate", "backfill"]);
  });
});

interface Harness {
  coordinator: KnowledgeMemoryCoordinator;
  options: KnowledgeMemoryCoordinatorOptions;
  services: KnowledgeMemoryCoordinatorOptions["services"];
  descriptors: Map<string, AgentDescriptor>;
  profiles: Map<string, ManagerProfile>;
  dataDir: string;
  knowledgeEntry: KnowledgeEntry;
  knowledgeEnabled: boolean;
}

async function createHarness(
  overrides: { runtimeTarget?: "builder" | "collaboration-server"; cortexEnabled?: boolean } = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), "knowledge-memory-coordinator-"));
  tempDirs.push(dataDir);
  const descriptors = new Map<string, AgentDescriptor>();
  const profiles = new Map<string, ManagerProfile>();
  const knowledgeEntry = makeKnowledgeEntry();
  const liveProvider = createLiveCompactionRuntimeSettingsProvider();
  let knowledgeEnabled = true;
  const services = {
    capture: {
      handleFeedbackSignal: vi.fn(async () => undefined),
      noteLearningSaved: vi.fn(async () => undefined),
    },
    compaction: {
      compact: vi.fn(async () => ({ compacted: true })),
      smartCompact: vi.fn(async () => ({ compacted: true } as const)),
    },
    cortex: {
      getConsolidationSnapshot: vi.fn(async () => ({
        lastRun: null,
        nextTrigger: { thresholdNewOrUpdatedEntries: 15, dailyCadenceHours: 24 },
        promotionQueue: [],
      })),
      listConsolidationRuns: vi.fn(async () => []),
      maybeRunConsolidationFromIncomingMessage: vi.fn(async () => true),
      runConsolidation: vi.fn(async () => null),
    },
    knowledge: {
      readEntry: vi.fn(async () => knowledgeEntry),
      saveLearning: vi.fn(async () => knowledgeEntry),
      searchEntries: vi.fn(async () => []),
    } as unknown as KnowledgeService,
    knowledgeSettings: {
      getSettings: vi.fn(() => ({ enabled: knowledgeEnabled })),
    } as unknown as KnowledgeV2SettingsService,
    memory: {
      ensureAgentMemoryFile: vi.fn(async () => undefined),
      ensureMemoryFilesForBoot: vi.fn(async () => undefined),
      mergeSessionMemory: vi.fn(async () => ({
        agentId: "session",
        status: "merged" as const,
        strategy: "llm" as const,
        mergedAt: NOW,
        auditPath: "/audit",
      })),
      refreshDefaultMemoryTemplateNormalizedLines: vi.fn(async () => undefined),
    },
    sessionMeta: {
      captureSessionRuntimePromptMeta: vi.fn(async () => undefined),
      hydrateCompactionCountsForBoot: vi.fn(async () => undefined),
      incrementSessionCompactionCount: vi.fn(async () => 2),
      readSessionMetaForDescriptor: vi.fn(async () => undefined),
      rebuildSessionManifestForBoot: vi.fn(async () => undefined),
      refreshSessionMetaStats: vi.fn(async () => undefined),
      refreshSessionMetaStatsBySessionId: vi.fn(async () => undefined),
      startCompactionCountBackfill: vi.fn(),
      updateSessionMetaForWorkerDescriptor: vi.fn(async () => undefined),
      writeInitialSessionMeta: vi.fn(async () => undefined),
      writeSessionMemoryMergeAttemptMeta: vi.fn(async () => undefined),
    },
  } satisfies KnowledgeMemoryCoordinatorOptions["services"];
  const options: KnowledgeMemoryCoordinatorOptions = {
    config: {
      runtimeTarget: overrides.runtimeTarget ?? "builder",
      cortexEnabled: overrides.cortexEnabled ?? true,
      defaultCwd: "/workspace",
      defaultModel: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
      paths: {
        dataDir,
        sharedAuthFile: join(dataDir, "shared", "auth.json"),
        authFile: join(dataDir, "auth.json"),
      } as SwarmConfig["paths"],
    },
    descriptors,
    profiles,
    services,
    compactionSettings: {
      runtimeProvider: liveProvider,
      liveProvider,
      getProviderAvailability: vi.fn(async () => new Map()),
    },
    sessions: {
      requireBuilderSession: vi.fn((agentId) => {
        const descriptor = descriptors.get(agentId);
        if (!descriptor || descriptor.role !== "manager" || !descriptor.profileId) {
          throw new Error("missing");
        }
        return descriptor as AgentDescriptor & { role: "manager"; profileId: string };
      }),
      assertMutable: vi.fn(),
      resolvePreferredManagerId: vi.fn(() => undefined),
    },
    cortexBootstrap: {
      sortedProfiles: () => Array.from(profiles.values()),
      upsertDescriptor: (descriptor) => descriptors.set(descriptor.agentId, descriptor),
      upsertProfile: (profile) => profiles.set(profile.profileId, profile),
      ensureProfileDirectories: vi.fn(async () => undefined),
      ensureSessionFileParent: vi.fn(async () => undefined),
      getAgentMemoryPath: (agentId) => join(dataDir, "memory", `${agentId}.md`),
      resolvePromptWithFallback: vi.fn(async () => "# Project common knowledge\n"),
    },
    getPiModelsJsonPath: () => join(dataDir, "models.json"),
    now: () => NOW,
    logDebug: vi.fn(),
  };
  const harness: Harness = {
    coordinator: new KnowledgeMemoryCoordinator(options),
    options,
    services,
    descriptors,
    profiles,
    dataDir,
    knowledgeEntry,
    get knowledgeEnabled() {
      return knowledgeEnabled;
    },
    set knowledgeEnabled(value: boolean) {
      knowledgeEnabled = value;
    },
  };
  return harness;
}

function makeManager(agentId: string, profileId: string): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId,
    status: "idle",
    createdAt: NOW,
    updatedAt: NOW,
    cwd: "/workspace",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "high" },
    sessionFile: `/sessions/${agentId}.jsonl`,
  };
}

function makeWorker(agentId: string, manager: AgentDescriptor): AgentDescriptor {
  return {
    ...makeManager(agentId, manager.profileId ?? manager.agentId),
    role: "worker",
    managerId: manager.agentId,
  };
}

function makeKnowledgeEntry(): KnowledgeEntry {
  return {
    frontmatter: {
      id: "entry-1",
      version: 1,
      type: "convention",
      scope: "profile:profile",
      status: "active",
      first_seen: NOW,
      last_confirmed: NOW,
      support_count: 1,
      sources: [{ kind: "user-stated", session: "session", at: NOW }],
      evidence_tier: "explicit_user",
      supersedes: [],
      source_entry_ids: [],
      importance: "normal",
      decay_after_days: null,
      title: "Run focused tests",
    },
    body: "Use direct Vitest paths.",
    path: "/knowledge/entry-1.md",
  };
}
