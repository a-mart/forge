import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { acquireRuntimeLock } from "../runtime-lock.js";

describe("runtime lock", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("acquires and releases lock for a data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);

    const lock = acquireRuntimeLock(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    const raw = await readFile(lockFile, "utf8");
    expect(raw).toContain(String(process.pid));

    lock.release();
    await expect(readFile(lockFile, "utf8")).rejects.toThrow();
  });

  it("throws when another live process owns the lock", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    await writeFile(lockFile, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");

    expect(() => acquireRuntimeLock(dataDir)).toThrow(
      "Another Forge instance is using this data directory. Close it first or use FORGE_DATA_DIR to specify a different directory.",
    );
  });

  it("reclaims stale lock held by dead process", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-lock-"));
    tempRoots.push(dataDir);
    const lockFile = join(dataDir, "runtime.lock");

    const deadPid = 987654321;
    const originalKill = process.kill;
    const esrchError = new Error("Process not found") as NodeJS.ErrnoException;
    esrchError.code = "ESRCH";

    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === deadPid) {
        throw esrchError;
      }

      return originalKill(pid, signal);
    });

    await writeFile(lockFile, `${deadPid}\n${new Date().toISOString()}\n`, "utf8");

    const lock = acquireRuntimeLock(dataDir);
    const raw = await readFile(lockFile, "utf8");
    expect(raw).toContain(String(process.pid));

    lock.release();
  });
});
