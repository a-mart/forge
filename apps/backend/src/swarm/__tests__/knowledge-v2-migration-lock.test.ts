import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getKnowledgeMigrationLockPath } from "../data-paths.js";
import {
  acquireKnowledgeMigrationLock,
  readKnowledgeMigrationLock,
} from "../knowledge-v2-migration-lock.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "knowledge-v2-lock-"));
  dirs.push(dir);
  return dir;
}

describe("knowledge v2 migration lock ownership", () => {
  it("does not let an old holder delete a replacement owner's lock", async () => {
    const dataDir = await tempDataDir();
    const releaseOld = await acquireKnowledgeMigrationLock(dataDir, "old-owner");
    const path = getKnowledgeMigrationLockPath(dataDir);
    await rm(path, { recursive: true, force: true });
    await mkdir(path);
    const replacement = {
      migrationId: "replacement",
      startedAt: "2026-01-01T00:00:00.000Z",
      pid: 123,
      ownerToken: "replacement-owner-token",
    };
    await writeFile(join(path, "replacement-owner-token.json"), `${JSON.stringify(replacement)}\n`, "utf8");

    await releaseOld();

    await expect(readKnowledgeMigrationLock(dataDir)).resolves.toMatchObject({
      migrationId: "replacement",
      ownerToken: "replacement-owner-token",
    });
  });

  it("serializes activation and migration acquisition with the same primitive", async () => {
    const dataDir = await tempDataDir();
    const releaseMigration = await acquireKnowledgeMigrationLock(dataDir, "migration");

    await expect(acquireKnowledgeMigrationLock(dataDir, "activation")).rejects.toMatchObject({ code: "EEXIST" });
    await releaseMigration();
    const releaseActivation = await acquireKnowledgeMigrationLock(dataDir, "activation");
    await expect(readKnowledgeMigrationLock(dataDir)).resolves.toMatchObject({ migrationId: "activation" });
    await releaseActivation();
    await expect(readKnowledgeMigrationLock(dataDir)).resolves.toBeNull();
  });
});
