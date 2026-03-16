import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireCortexReviewLock,
  appendCortexReviewLogEntry,
  readCortexReviewLock,
  releaseCortexReviewLock,
  writeCortexPromotionManifest
} from "../swarm/scripts/cortex-review-state.js";
import {
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath
} from "../swarm/data-paths.js";

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

    await expect(releaseCortexReviewLock({ dataDir, ownerId: "other-owner" })).resolves.toBe(false);
    await expect(releaseCortexReviewLock({ dataDir, ownerId: "cortex" })).resolves.toBe(true);
    await expect(readCortexReviewLock(dataDir)).resolves.toBeNull();
  });

  it("refuses to acquire a non-expired lock owned by someone else but replaces stale locks", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cortex-review-state-"));

    await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-a",
      reviewId: "review-a",
      ttlMs: 60_000,
      now: new Date("2026-03-16T18:00:00.000Z")
    });

    const denied = await acquireCortexReviewLock({
      dataDir,
      ownerId: "owner-b",
      reviewId: "review-b",
      now: new Date("2026-03-16T18:00:30.000Z")
    });
    expect(denied.acquired).toBe(false);
    expect(denied.lease.ownerId).toBe("owner-a");

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
});
