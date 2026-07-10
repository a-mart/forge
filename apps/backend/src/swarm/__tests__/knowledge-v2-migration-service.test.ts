import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getCommonKnowledgePath,
  getKnowledgeEntriesDir,
  getKnowledgeIndexPath,
  getKnowledgeMigrationManifestPath,
  getProfileKnowledgeEntriesDir,
  getProfileKnowledgeIndexPath,
  getProfileMemoryPath,
} from "../data-paths.js";
import { KnowledgeService, estimateTokens } from "../knowledge-service.js";
import { KnowledgeV2SettingsService } from "../knowledge-v2-settings-service.js";
import {
  cleanupLegacyKnowledgeFiles,
  rollbackKnowledgeV2Migration,
  runKnowledgeV2Migration,
} from "../knowledge-v2-migration-service.js";
import {
  acquireKnowledgeMigrationLock,
  assertKnowledgeMigrationNotBusy,
} from "../knowledge-v2-migration-lock.js";
import { renderOnboardingCommonKnowledge, saveOnboardingPreferences } from "../onboarding-state.js";

describe("knowledge v2 migration service", () => {
  it("migrates fixture legacy knowledge into typed entries, discards task-local items, pointerizes large topics, and flips the switch", async () => {
    const harness = await createHarness();
    await writeFixtureLegacyKnowledge(harness.dataDir);

    const manifest = await runKnowledgeV2Migration(harness);

    expect(harness.settingsService.getSettings().enabled).toBe(true);
    expect(manifest.version).toBe(2);
    expect(manifest.preMigrationVersioningSha).toBeNull();
    expect(manifest.files).toHaveLength(3);
    expect(manifest.discards).toEqual([
      expect.objectContaining({ reason: "task-local", text: expect.stringContaining("This task") }),
    ]);
    expect(manifest.entries.some((entry) => entry.type === "pointer")).toBe(true);
    expect(manifest.entries.some((entry) => entry.type === "gotcha")).toBe(true);
    expect(manifest.entries.some((entry) => entry.type === "preference")).toBe(true);
    expect(manifest.indexResults.every((index) => index.tokenEstimate <= index.tokenCap)).toBe(true);

    const globalIndex = await readFile(getKnowledgeIndexPath(harness.dataDir), "utf8");
    const alphaIndex = await readFile(getProfileKnowledgeIndexPath(harness.dataDir, "alpha"), "utf8");
    expect(globalIndex).toContain("Prefer concise closeouts");
    expect(alphaIndex).toContain("pnpm");
    expect(alphaIndex).not.toContain("This task");

    const alphaEntries = await readdir(getProfileKnowledgeEntriesDir(harness.dataDir, "alpha"));
    const pointer = alphaEntries.find((name) => name.includes("architecture-reference"));
    expect(pointer).toBeDefined();
    expect(await readFile(join(getProfileKnowledgeEntriesDir(harness.dataDir, "alpha"), pointer!), "utf8")).toContain("legacy: true");
  });

  it("does not durably enable when the completed manifest write fails", async () => {
    const harness = await createHarness();

    await expect(runKnowledgeV2Migration({
      ...harness,
      writeManifest: async () => { throw new Error("manifest write failed"); },
    })).rejects.toThrow("manifest write failed");

    expect(harness.settingsService.getSettings().enabled).toBe(false);
  });

  it("is idempotent on force re-run and keeps the same entry file set", async () => {
    const harness = await createHarness();
    await writeFixtureLegacyKnowledge(harness.dataDir);

    await runKnowledgeV2Migration(harness);
    const firstGlobalEntries = (await readdir(getKnowledgeEntriesDir(harness.dataDir))).sort();
    const firstAlphaEntries = (await readdir(getProfileKnowledgeEntriesDir(harness.dataDir, "alpha"))).sort();

    await harness.settingsService.update({ enabled: false });
    await runKnowledgeV2Migration({ ...harness, force: true });

    expect((await readdir(getKnowledgeEntriesDir(harness.dataDir))).sort()).toEqual(firstGlobalEntries);
    expect((await readdir(getProfileKnowledgeEntriesDir(harness.dataDir, "alpha"))).sort()).toEqual(firstAlphaEntries);
  });

  it("rolls back the kill switch and restores legacy files byte-identically", async () => {
    const harness = await createHarness();
    const original = await writeFixtureLegacyKnowledge(harness.dataDir);
    const currentManifest = await runKnowledgeV2Migration(harness);
    const { activation: _activation, ...commonManifest } = currentManifest;
    const legacyV1Manifest = {
      ...commonManifest,
      version: 1,
      settingsAfter: {
        ...currentManifest.settingsBefore,
        enabled: true,
        updatedAt: currentManifest.completedAt,
      },
    };
    await writeFile(
      getKnowledgeMigrationManifestPath(harness.dataDir),
      JSON.stringify(legacyV1Manifest),
      "utf8",
    );

    await writeFile(getCommonKnowledgePath(harness.dataDir), "# Common Knowledge\n\nchanged\n", "utf8");
    await writeFile(getProfileMemoryPath(harness.dataDir, "alpha"), "# Swarm Memory\n\nchanged\n", "utf8");

    const result = await rollbackKnowledgeV2Migration(harness);

    expect(result.restartRequired).toBe(true);
    expect(harness.settingsService.getSettings().enabled).toBe(false);
    expect(await readFile(getCommonKnowledgePath(harness.dataDir), "utf8")).toBe(original.common);
    expect(await readFile(getProfileMemoryPath(harness.dataDir, "alpha"), "utf8")).toBe(original.alpha);
  });

  it("rejects invalid manifests and traversal paths during rollback", async () => {
    const harness = await createHarness();
    await writeFixtureLegacyKnowledge(harness.dataDir);
    const manifest = await runKnowledgeV2Migration(harness);
    const manifestPath = getKnowledgeMigrationManifestPath(harness.dataDir);

    await writeFile(manifestPath, JSON.stringify({ version: 1 }), "utf8");
    await expect(rollbackKnowledgeV2Migration(harness)).rejects.toThrow("manifest is invalid");

    manifest.legacyBackups[0]!.relativePath = "../../outside.md";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(rollbackKnowledgeV2Migration(harness)).rejects.toThrow("escapes the data directory");
  });

  it("blocks legacy writers during migration lock and cleanup archives legacy paths after confirmation", async () => {
    const harness = await createHarness();
    await writeFixtureLegacyKnowledge(harness.dataDir);

    const release = await acquireKnowledgeMigrationLock(harness.dataDir, "test-lock");
    await expect(assertKnowledgeMigrationNotBusy(harness.dataDir)).rejects.toThrow("Knowledge v2 migration is running");
    await expect(renderOnboardingCommonKnowledge(harness.dataDir, {
      status: "pending",
      completedAt: null,
      skippedAt: null,
      preferences: null,
    })).rejects.toThrow("Knowledge v2 migration is running");
    await release();

    await runKnowledgeV2Migration(harness);
    const cleanup = await cleanupLegacyKnowledgeFiles({
      dataDir: harness.dataDir,
      settingsService: harness.settingsService,
      confirm: true,
      now: () => new Date("2026-07-06T12:00:00.000Z"),
    });
    expect(cleanup.archivedPaths).toContain("shared/knowledge/common.md");
    await expect(readFile(getCommonKnowledgePath(harness.dataDir), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("emits onboarding preferences as knowledge entries when knowledge v2 is enabled", async () => {
    const harness = await createHarness();
    await runKnowledgeV2Migration(harness);
    const snapshot = await saveOnboardingPreferences(harness.dataDir, {
      preferredName: "Ada",
      technicalLevel: "developer",
      additionalPreferences: "Prefer plain language.",
    });

    await renderOnboardingCommonKnowledge(harness.dataDir, snapshot, {
      knowledgeService: harness.knowledgeService,
      settingsService: harness.settingsService,
    });

    const results = await harness.knowledgeService.searchEntries({ query: "onboarding", scope: "global", limit: 10 });
    expect(results.map((result) => result.id)).toEqual(
      expect.arrayContaining([
        "preference-onboarding-preferred-name",
        "preference-onboarding-technical-level",
        "preference-onboarding-additional-preferences",
      ]),
    );
  });
});

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "knowledge-v2-migration-"));
  const settingsService = new KnowledgeV2SettingsService({ dataDir });
  await settingsService.load();
  await settingsService.update({ indexCaps: { global: 120, profile: 120 } });
  const knowledgeService = new KnowledgeService({
    dataDir,
    settingsService,
    now: () => new Date("2026-07-06T12:00:00.000Z"),
  });
  return { dataDir, settingsService, knowledgeService };
}

async function writeFixtureLegacyKnowledge(dataDir: string): Promise<{ common: string; alpha: string; beta: string }> {
  const common = [
    "# Common Knowledge",
    "",
    "## User Preferences",
    "- Prefer concise closeouts in final replies.",
    "- This task decided to validate a temporary WP-C2 fixture today.",
    "",
  ].join("\n");
  const alphaLongBody = Array.from({ length: 100 }, (_, index) => `detail${index}`).join(" ");
  const alpha = [
    "# Swarm Memory",
    "",
    "## Conventions",
    "- Always use pnpm for package commands.",
    "## Gotchas",
    "- Avoid sharing default ~/.forge between dev instances.",
    "## Reference",
    `- Architecture reference ${alphaLongBody}`,
    "",
  ].join("\n");
  const beta = [
    "# Swarm Memory",
    "",
    "## Preferences",
    "- User prefers plain language for explanations.",
    "",
  ].join("\n");
  await writeText(getCommonKnowledgePath(dataDir), common);
  await writeText(getProfileMemoryPath(dataDir, "alpha"), alpha);
  await writeText(getProfileMemoryPath(dataDir, "beta"), beta);
  expect(estimateTokens(alphaLongBody)).toBeGreaterThan(90);
  return { common, alpha, beta };
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
