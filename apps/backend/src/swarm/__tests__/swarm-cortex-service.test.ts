import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeService, type KnowledgeEntrySource } from "../knowledge-service.js";
import { SwarmCortexService } from "../swarm-cortex-service.js";
import { readCortexConsolidationRuns } from "../cortex-consolidation-runs.js";
import { readCortexReviewLogEntries } from "../scripts/cortex-review-state.js";
import type { AgentDescriptor, SwarmConfig } from "../types.js";
import type { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";

describe("SwarmCortexService consolidation", () => {
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

function createService(dataDir: string, knowledgeService: KnowledgeService): SwarmCortexService {
  return new SwarmCortexService({
    config: { cortexEnabled: true, paths: { dataDir } } as SwarmConfig,
    now: () => "2026-07-05T12:00:00.000Z",
    descriptors: new Map<string, AgentDescriptor>(),
    knowledgeService,
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

function entrySource(session = "s1"): KnowledgeEntrySource {
  return { kind: "observed", session, at: "2026-07-05T12:00:00.000Z" };
}
