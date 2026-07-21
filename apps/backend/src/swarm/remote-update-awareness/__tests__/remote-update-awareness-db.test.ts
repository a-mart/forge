import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { closeRemoteUpdateAwarenessDb, getOrCreateRemoteUpdateAwarenessDb } from "../remote-update-awareness-db.js";

describe("remote update awareness database factory", () => {
  it("serializes opens, enables WAL/foreign keys, caches success, and closes once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-awareness-db-"));
    const path = join(directory, "nested", "awareness.db");
    const load = vi.fn(async () => Database);
    const config = {
      paths: { remoteUpdateAwarenessDbPath: path },
      remoteUpdateAwarenessModules: { loadDatabaseModule: load }
    } as never;

    const [first, second] = await Promise.all([
      getOrCreateRemoteUpdateAwarenessDb(config),
      getOrCreateRemoteUpdateAwarenessDb(config)
    ]);
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.pragma("foreign_keys", { simple: true })).toBe(1);

    await Promise.all([closeRemoteUpdateAwarenessDb(config), closeRemoteUpdateAwarenessDb(config)]);
    expect(first.open).toBe(false);

    const reopened = await getOrCreateRemoteUpdateAwarenessDb(config);
    expect(reopened).not.toBe(first);
    await closeRemoteUpdateAwarenessDb(config);
  });

  it("does not cache failed module loads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-awareness-db-fail-"));
    const config = {
      paths: { remoteUpdateAwarenessDbPath: join(directory, "awareness.db") },
      remoteUpdateAwarenessModules: { loadDatabaseModule: vi.fn().mockRejectedValueOnce(new Error("load failed")).mockResolvedValue(Database) }
    } as never;
    await expect(getOrCreateRemoteUpdateAwarenessDb(config)).rejects.toThrow("load failed");
    const database = await getOrCreateRemoteUpdateAwarenessDb(config);
    expect(database.open).toBe(true);
    await closeRemoteUpdateAwarenessDb(config);
  });
});
