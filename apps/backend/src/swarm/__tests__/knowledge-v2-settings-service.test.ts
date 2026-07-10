import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { getKnowledgeMigrationManifestPath } from "../data-paths.js";
import { acquireKnowledgeMigrationLock } from "../knowledge-v2-migration-lock.js";
import {
  KnowledgeV2MigrationRequiredError,
  KnowledgeV2SettingsService,
} from "../knowledge-v2-settings-service.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createService(): Promise<{ dataDir: string; service: KnowledgeV2SettingsService }> {
  const dataDir = await mkdtemp(join(tmpdir(), "knowledge-v2-settings-"));
  dirs.push(dataDir);
  const service = new KnowledgeV2SettingsService({ dataDir });
  await service.load();
  return { dataDir, service };
}

async function writeCompletedManifest(dataDir: string): Promise<void> {
  await writeJsonFileAtomic(getKnowledgeMigrationManifestPath(dataDir), {
    version: 1,
    migrationId: "knowledge-v2-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    classifier: "offline-heuristic-v1",
    force: false,
    preMigrationVersioningSha: null,
    settingsBefore: {
      enabled: false,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 1500, profile: 800 },
      updatedAt: null,
    },
    settingsAfter: {
      enabled: true,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 1500, profile: 800 },
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
    files: [],
    legacyBackups: [],
    entries: [],
    discards: [],
    indexResults: [],
  });
}

describe("KnowledgeV2SettingsService activation guard", () => {
  it("rejects false-to-true activation without a completed migration manifest", async () => {
    const { service } = await createService();

    await expect(service.update({ enabled: true })).rejects.toBeInstanceOf(KnowledgeV2MigrationRequiredError);
    expect(service.getSettings().enabled).toBe(false);
    await expect(service.getActivationCapability()).resolves.toEqual({
      canEnable: false,
      reason: "migration_required",
    });
  });

  it("does not authorize activation while the migration transaction lock is active", async () => {
    const { dataDir, service } = await createService();
    await writeCompletedManifest(dataDir);
    const release = await acquireKnowledgeMigrationLock(dataDir, "knowledge-v2-test");

    await expect(service.update({ enabled: true })).rejects.toBeInstanceOf(KnowledgeV2MigrationRequiredError);
    await release();
    await expect(service.update({ enabled: true })).resolves.toMatchObject({ enabled: true });
  });

  it("accepts false-to-true activation with a valid completed manifest", async () => {
    const { dataDir, service } = await createService();
    await writeCompletedManifest(dataDir);

    await expect(service.update({ enabled: true })).resolves.toMatchObject({ enabled: true });
    await expect(service.getActivationCapability()).resolves.toEqual({ canEnable: true, reason: null });
  });

  it.each([
    ["partial", { version: 1, migrationId: "knowledge-v2-test" }],
    ["unknown classifier", { classifier: "unknown-v2" }],
    ["reversed timestamps", {
      startedAt: "2026-01-01T00:02:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    }],
    ["corrupt member", { files: [{ relativePath: "x", scope: "global" }] }],
  ])("rejects a %s manifest", async (_label, override) => {
    const { dataDir, service } = await createService();
    await writeCompletedManifest(dataDir);
    const path = getKnowledgeMigrationManifestPath(dataDir);
    const base = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeJsonFileAtomic(path, _label === "partial" ? override : { ...base, ...override });

    await expect(service.update({ enabled: true })).rejects.toBeInstanceOf(KnowledgeV2MigrationRequiredError);
  });

  it("allows true-to-false and already-true non-enable patches", async () => {
    const { dataDir, service } = await createService();
    await writeCompletedManifest(dataDir);
    await service.update({ enabled: true });
    await rm(getKnowledgeMigrationManifestPath(dataDir));

    await expect(service.update({ indexCaps: { global: 1600 } })).resolves.toMatchObject({
      enabled: true,
      indexCaps: { global: 1600 },
    });
    await expect(service.update({ enabled: false })).resolves.toMatchObject({ enabled: false });
  });
});
