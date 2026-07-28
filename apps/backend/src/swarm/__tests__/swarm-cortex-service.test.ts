import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KnowledgeService, type KnowledgeEntrySource } from "../knowledge-service.js";
import { SwarmCortexService } from "../swarm-cortex-service.js";
import { readCortexConsolidationRuns } from "../cortex-consolidation-runs.js";
import { readCortexReviewLogEntries } from "../scripts/cortex-review-state.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";

describe("SwarmCortexService consolidation", () => {
  it("skips disabled consolidation and records failed runs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-disabled-"));
    const knowledgeService = createKnowledgeService(dataDir);
    const disabled = createService(dataDir, knowledgeService, { cortexEnabled: false });
    await expect(disabled.runConsolidation("manual")).resolves.toBeNull();
    expect(await readCortexConsolidationRuns(dataDir)).toEqual([]);

    const failingDataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-failed-"));
    const failingKnowledge = createKnowledgeService(failingDataDir);
    vi.spyOn(failingKnowledge, "listEntries").mockRejectedValue(new Error("index unavailable"));
    const failing = createService(failingDataDir, failingKnowledge);
    await expect(failing.runConsolidation("threshold")).rejects.toThrow("index unavailable");
    await expect(readCortexConsolidationRuns(failingDataDir)).resolves.toMatchObject([
      { status: "failed", trigger: "threshold", error: "index unavailable" },
    ]);
  });

  it("routes manual requests only from the interactive Cortex root and captures idle transitions", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-routing-"));
    const knowledgeService = createKnowledgeService(dataDir);
    const capture = vi.fn();
    const service = createService(dataDir, knowledgeService, { handleCaptureCascade: capture });
    const cortex = descriptor("cortex", "cortex");
    const worker = { ...cortex, agentId: "cortex--worker", role: "worker" as const, managerId: "cortex" };
    expect(await service.maybeRunConsolidationFromIncomingMessage("consolidate", worker, { channel: "web" })).toBe(false);
    expect(await service.maybeRunConsolidationFromIncomingMessage("hello", cortex, { channel: "web" })).toBe(false);
    expect(await service.maybeRunConsolidationFromIncomingMessage("reindex now", cortex, { channel: "web" })).toBe(true);
    service.handleManagerStatusTransition(cortex, "idle", 0);
    service.handleManagerStatusTransition(cortex, "idle", 1);
    expect(capture).toHaveBeenCalledWith(cortex, "idle");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("builds a promotion queue from three profile-scoped confirmations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-snapshot-"));
    const knowledgeService = createKnowledgeService(dataDir);
    const baseEntry = await knowledgeService.upsertEntry({
      type: "convention",
      scope: "profile:a",
      title: "Shared release convention",
      body: "Use the release checklist.",
      evidenceTier: "explicit_user",
      sources: [entrySource("promotion-0")],
    });
    const entries = ["profile:a", "profile:b", "profile:c"].map((scope, index) => ({
      ...baseEntry,
      frontmatter: { ...baseEntry.frontmatter, id: `promotion-${index}`, scope },
    }));
    vi.spyOn(knowledgeService, "listEntries").mockResolvedValue(entries);
    const snapshot = await createService(dataDir, knowledgeService).getConsolidationSnapshot();
    expect(snapshot.promotionQueue).toEqual([expect.objectContaining({
      id: "shared-release-convention",
      profileScopes: ["profile:a", "profile:b", "profile:c"],
      supportCount: 3,
    })]);
  });

  it("merges duplicates, supersedes contradictions, archives decayed entries, and records a run", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "swarm-cortex-service-"));
    const knowledgeService = createKnowledgeService(dataDir);
    const source = entrySource();

    const duplicateA = await knowledgeService.upsertEntry({
      type: "preference",
      scope: "global",
      title: "Use pnpm for installs",
      body: "Use pnpm for installs.",
      evidenceTier: "explicit_user",
      sources: [source],
      supportCount: 2,
      lastConfirmed: "2026-07-01T00:00:00.000Z",
    });
    const duplicateB = await knowledgeService.upsertEntry({
      type: "preference",
      scope: "global",
      title: "Use pnpm for installs",
      body: "Use pnpm for installs.",
      evidenceTier: "agent_inference",
      sources: [entrySource("s2")],
      supportCount: 3,
      lastConfirmed: "2026-07-03T00:00:00.000Z",
    });
    const winner = await knowledgeService.upsertEntry({
      type: "convention",
      scope: "global",
      title: "Use lint before merge",
      body: "Always use lint before merge.",
      evidenceTier: "repeated_pattern",
      sources: [entrySource("s3")],
      supportCount: 4,
    });
    const loser = await knowledgeService.upsertEntry({
      type: "convention",
      scope: "global",
      title: "Do not use lint before merge",
      body: "Do not use lint before merge.",
      evidenceTier: "agent_inference",
      sources: [entrySource("s4")],
      supportCount: 1,
    });
    const stale = await knowledgeService.upsertEntry({
      type: "gotcha",
      scope: "global",
      title: "Old setup gotcha",
      body: "This old setup gotcha is no longer useful.",
      evidenceTier: "agent_inference",
      sources: [entrySource("s5")],
      lastConfirmed: "2025-01-01T00:00:00.000Z",
    });

    const service = createService(dataDir, knowledgeService);
    const run = await service.runConsolidation("manual");

    expect(run).toMatchObject({ status: "completed", merged: 1, superseded: 1, archived: 1 });
    const duplicateEntries = await Promise.all([
      knowledgeService.readEntry(duplicateA.frontmatter.id),
      knowledgeService.readEntry(duplicateB.frontmatter.id),
    ]);
    const mergedDuplicate = duplicateEntries.find((entry) => entry.frontmatter.status === "active");
    const supersededDuplicate = duplicateEntries.find((entry) => entry.frontmatter.status === "superseded");
    expect(mergedDuplicate).toMatchObject({
      frontmatter: { support_count: 5, source_entry_ids: expect.arrayContaining([duplicateA.frontmatter.id, duplicateB.frontmatter.id]) },
    });
    expect(supersededDuplicate?.frontmatter.supersedes).toEqual([mergedDuplicate?.frontmatter.id]);
    await expect(knowledgeService.readEntry(loser.frontmatter.id)).resolves.toMatchObject({
      frontmatter: { status: "superseded", supersedes: [winner.frontmatter.id] },
    });
    await expect(knowledgeService.readEntry(stale.frontmatter.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await readCortexConsolidationRuns(dataDir)).toHaveLength(1);
    expect((await readCortexReviewLogEntries(dataDir)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(["merged", "superseded", "archived", "reindexed"]),
    );
  });
});

function createService(
  dataDir: string,
  knowledgeService: KnowledgeService,
  overrides: Partial<Pick<SwarmConfig, "cortexEnabled">> & { handleCaptureCascade?: (descriptor: AgentDescriptor, trigger: "idle") => void } = {},
): SwarmCortexService {
  return new SwarmCortexService({
    config: { cortexEnabled: overrides.cortexEnabled ?? true, paths: { dataDir } } as SwarmConfig,
    now: () => "2026-07-05T12:00:00.000Z",
    descriptors: new Map<string, AgentDescriptor>(),
    knowledgeService,
    handleCaptureCascade: overrides.handleCaptureCascade,
    knowledgeV2SettingsService: {
      getSettings: () => ({
        enabled: true,
        legacyCleanupConfirmed: false,
        indexCaps: { global: 1_500, profile: 800 },
        updatedAt: null,
      }),
    } as KnowledgeV2SettingsService,
    logDebug: () => undefined,
  });
}

function createKnowledgeService(dataDir: string): KnowledgeService {
  return new KnowledgeService({
    dataDir,
    settingsService: {
      getSettings: () => ({
        enabled: true,
        legacyCleanupConfirmed: false,
        indexCaps: { global: 1_500, profile: 800 },
        updatedAt: null,
      }),
    } as KnowledgeV2SettingsService,
    now: () => new Date("2026-07-05T12:00:00.000Z"),
  });
}

function descriptor(agentId: string, archetypeId = "cortex"): AgentDescriptor {
  return {
    agentId,
    displayName: agentId,
    role: "manager",
    managerId: agentId,
    profileId: "cortex",
    archetypeId,
    status: "idle",
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    cwd: "/workspace",
    model: { provider: "openai", modelId: "gpt-5", thinkingLevel: "none" },
    sessionFile: `/sessions/${agentId}.jsonl`,
  };
}

function entrySource(session = "s1"): KnowledgeEntrySource {
  return { kind: "observed", session, at: "2026-07-05T12:00:00.000Z" };
}
