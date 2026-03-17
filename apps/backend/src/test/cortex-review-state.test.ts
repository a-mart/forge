import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionMeta } from "@middleman/protocol";
import { describe, expect, it } from "vitest";
import {
  acquireCortexReviewLock,
  appendCortexReviewLogEntry,
  finalizeCortexReviewCycle,
  readCortexReviewLock,
  releaseCortexReviewLock,
  renewCortexReviewLock,
  writeCortexPromotionManifest
} from "../swarm/scripts/cortex-review-state.js";
import {
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  getSessionMetaPath
} from "../swarm/data-paths.js";
import { readSessionMeta } from "../swarm/session-manifest.js";

describe("cortex-review-state", () => {
  it("acquires, reads, and releases a review lock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));

    const acquired = await acquireCortexReviewLock({
      dataDir,
      ownerId: "cortex",
      reviewId: "review-1",
      now: new Date("2026-03-16T18:00:00.000Z")
    });

    expect(acquired).toMatchObject({
      lockPath: getCortexReviewLockPath(dataDir),
      acquired: true,
      staleReplaced: false,
      lease: {
        ownerId: "cortex",
        reviewId: "review-1"
      }
    });

    expect(await readCortexReviewLock(dataDir)).toMatchObject({
      ownerId: "cortex",
      reviewId: "review-1"
    });

    await expect(releaseCortexReviewLock({ dataDir, ownerId: "other-owner", reviewId: "review-1" })).resolves.toBe(false);
    await expect(releaseCortexReviewLock({ dataDir, ownerId: "cortex", reviewId: "other-review" })).resolves.toBe(false);
    await expect(releaseCortexReviewLock({ dataDir, ownerId: "cortex", reviewId: "review-1" })).resolves.toBe(true);
    await expect(readCortexReviewLock(dataDir)).resolves.toBeNull();
  });

  it("refuses to acquire a non-expired lock owned by another review and replaces stale locks", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));

    await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-a",
      reviewId: "review-a",
      ttlMs: 60_000,
      now: new Date("2026-03-16T18:00:00.000Z")
    });

    const deniedDifferentOwner = await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-b",
      reviewId: "review-b",
      now: new Date("2026-03-16T18:00:30.000Z")
    });
    expect(deniedDifferentOwner.acquired).toBe(false);
    expect(deniedDifferentOwner.lease.ownerId).toBe("owner-a");

    const deniedSameOwnerDifferentReview = await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-a",
      reviewId: "review-c",
      now: new Date("2026-03-16T18:00:45.000Z")
    });
    expect(deniedSameOwnerDifferentReview.acquired).toBe(false);
    expect(deniedSameOwnerDifferentReview.lease.reviewId).toBe("review-a");

    const replaced = await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-b",
      reviewId: "review-b",
      now: new Date("2026-03-16T18:16:00.000Z")
    });
    expect(replaced).toMatchObject({
      acquired: true,
      staleReplaced: true,
      lease: {
        ownerId: "owner-b",
        reviewId: "review-b"
      }
    });
  });

  it("renews only the matching active review lock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));
    await acquireCortexReviewLock({
      dataDir,
      ownerId: "cortex",
      reviewId: "review-1",
      now: new Date("2026-03-16T18:00:00.000Z")
    });

    const denied = await renewCortexReviewLock({
      dataDir,
      ownerId: "cortex",
      reviewId: "review-2",
      now: new Date("2026-03-16T18:05:00.000Z")
    });
    expect(denied.renewed).toBe(false);

    const renewed = await renewCortexReviewLock({
      dataDir,
      ownerId: "cortex",
      reviewId: "review-1",
      ttlMs: 60_000,
      now: new Date("2026-03-16T18:05:00.000Z")
    });
    expect(renewed).toMatchObject({
      renewed: true,
      lease: {
        ownerId: "cortex",
        reviewId: "review-1"
      }
    });
    expect(Date.parse(renewed.lease!.expiresAt)).toBeGreaterThan(Date.parse("2026-03-16T18:05:00.000Z"));
  });

  it("appends review-log entries as jsonl", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));
    const appended = await appendCortexReviewLogEntry({
      dataDir,
      entry: {
        reviewId: "review-1",
        ownerId: "cortex",
        status: "success",
        reviewed: ["alpha/session-1"],
        changedFiles: ["shared/knowledge/common.md"],
        watermarksAdvanced: true
      }
    });

    expect(appended.recordedAt).toMatch(/T/);
    const raw = await readFile(getCortexReviewLogPath(dataDir), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      reviewId: "review-1",
      ownerId: "cortex",
      status: "success",
      reviewed: ["alpha/session-1"],
      changedFiles: ["shared/knowledge/common.md"],
      watermarksAdvanced: true
    });
  });

  it("writes promotion manifests under the dedicated manifests directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));
    const manifestPath = await writeCortexPromotionManifest({
      dataDir,
      reviewId: "review 1",
      content: "# Manifest\n- change"
    });

    expect(manifestPath).toBe(join(getCortexPromotionManifestsDir(dataDir), "review-1.md"));
    await expect(readFile(manifestPath, "utf8")).resolves.toBe("# Manifest\n- change");
  });

  it("finalizes a review cycle by writing manifest, watermarks, log entry, and releasing lock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));
    const profileId = "alpha";
    const sessionId = "alpha--s1";

    await writeSessionMetaFixture(dataDir, {
      sessionId,
      profileId,
      cortexReviewedBytes: 10,
      cortexReviewedAt: "2026-03-16T18:00:00.000Z",
      cortexReviewExcludedAt: "2026-03-16T17:59:00.000Z"
    });

    await acquireCortexReviewLock({
      dataDir,
      ownerId: "cortex",
      reviewId: "review-1",
      now: new Date("2026-03-16T18:05:00.000Z")
    });

    const result = await finalizeCortexReviewCycle({
      dataDir,
      input: {
        reviewId: "review-1",
        ownerId: "cortex",
        status: "success",
        reviewed: [`${profileId}/${sessionId}`],
        changedFiles: ["shared/knowledge/common.md"],
        watermarksAdvanced: true,
        manifestContent: "# Review Manifest\n- planned update",
        watermarkUpdates: [
          {
            profileId,
            sessionId,
            cortexReviewedBytes: 42,
            cortexReviewedAt: "2026-03-16T18:06:00.000Z",
            cortexReviewedMemoryBytes: 12,
            cortexReviewedMemoryAt: "2026-03-16T18:06:00.000Z"
          }
        ],
        releaseLock: true
      }
    });

    expect(result).toMatchObject({
      updatedSessions: [`${profileId}/${sessionId}`],
      lockReleased: true
    });
    await expect(readFile(result.manifestPath!, "utf8")).resolves.toBe("# Review Manifest\n- planned update");

    const meta = await readSessionMeta(dataDir, profileId, sessionId);
    expect(meta).toMatchObject({
      cortexReviewedBytes: 42,
      cortexReviewedAt: "2026-03-16T18:06:00.000Z",
      cortexReviewExcludedAt: null,
      cortexReviewedMemoryBytes: 12,
      cortexReviewedMemoryAt: "2026-03-16T18:06:00.000Z"
    });

    const logLines = (await readFile(getCortexReviewLogPath(dataDir), "utf8")).trim().split("\n");
    expect(JSON.parse(logLines[0])).toMatchObject({
      reviewId: "review-1",
      ownerId: "cortex",
      status: "success",
      watermarksAdvanced: true
    });
    await expect(readCortexReviewLock(dataDir)).resolves.toBeNull();
  });

  it("rejects finalize-review when the lock is missing or owned by someone else", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));
    const profileId = "alpha";
    const sessionId = "alpha--s1";
    await writeSessionMetaFixture(dataDir, { sessionId, profileId });

    await expect(
      finalizeCortexReviewCycle({
        dataDir,
        input: {
          reviewId: "review-1",
          ownerId: "cortex",
          status: "blocked",
          reviewed: [],
          changedFiles: [],
          watermarksAdvanced: false,
          watermarkUpdates: [{ profileId, sessionId, cortexReviewedBytes: 1 }]
        }
      })
    ).rejects.toThrow("Cortex review lock is missing or owned by another review cycle.");

    await acquireCortexReviewLock({ dataDir, ownerId: "other-owner", reviewId: "review-2" });
    await expect(
      finalizeCortexReviewCycle({
        dataDir,
        input: {
          reviewId: "review-1",
          ownerId: "cortex",
          status: "blocked",
          reviewed: [],
          changedFiles: [],
          watermarksAdvanced: false,
          watermarkUpdates: [{ profileId, sessionId, cortexReviewedBytes: 1 }]
        }
      })
    ).rejects.toThrow("Cortex review lock is missing or owned by another review cycle.");
  });
});

async function writeSessionMetaFixture(
  dataDir: string,
  overrides: Partial<SessionMeta> & { profileId: string; sessionId: string }
): Promise<void> {
  const base: SessionMeta = {
    sessionId: overrides.sessionId,
    profileId: overrides.profileId,
    label: null,
    model: { provider: null, modelId: null },
    createdAt: "2026-03-16T18:00:00.000Z",
    updatedAt: "2026-03-16T18:00:00.000Z",
    cwd: null,
    promptFingerprint: null,
    promptComponents: null,
    workers: [],
    stats: {
      totalWorkers: 0,
      activeWorkers: 0,
      totalTokens: { input: null, output: null },
      sessionFileSize: null,
      memoryFileSize: null
    }
  };

  const meta: SessionMeta = { ...base, ...overrides };
  const metaPath = getSessionMetaPath(dataDir, overrides.profileId, overrides.sessionId);
  await mkdir(dirname(metaPath), { recursive: true });
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}
