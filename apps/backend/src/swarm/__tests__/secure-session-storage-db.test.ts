import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  closeSecureSessionDb,
  getOrCreateSecureSessionDb
} from "../secure-sessions/storage/secure-session-db.js";

describe("secure session database", () => {
  it("serializes opens, configures SQLite, hardens files, and safely reopens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-session-db-"));
    const dbPath = join(directory, "nested", "secure-sessions.db");
    const loadDatabaseModule = vi.fn(async () => Database);
    const options = { dbPath, loadDatabaseModule };

    const [first, second] = await Promise.all([
      getOrCreateSecureSessionDb(options),
      getOrCreateSecureSessionDb(options)
    ]);
    expect(first).toBe(second);
    expect(loadDatabaseModule).toHaveBeenCalledTimes(1);
    expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(first.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(first.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(first.pragma("quick_check", { simple: true })).toBe("ok");

    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      const mode = (await stat(path)).mode & 0o777;
      if (process.platform !== "win32") expect(mode).toBe(0o600);
    }

    await Promise.all([closeSecureSessionDb(dbPath), closeSecureSessionDb(dbPath)]);
    expect(first.open).toBe(false);
    if (process.platform !== "win32") {
      expect((await stat(dbPath)).mode & 0o777).toBe(0o600);
    }

    const reopened = await getOrCreateSecureSessionDb(options);
    expect(reopened).not.toBe(first);
    expect(reopened.pragma("quick_check", { simple: true })).toBe("ok");
    await closeSecureSessionDb(dbPath);
  });

  it("does not cache a failed module load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "forge-secure-session-db-fail-"));
    const options = {
      dbPath: join(directory, "secure-sessions.db"),
      loadDatabaseModule: vi.fn()
        .mockRejectedValueOnce(new Error("load failed"))
        .mockResolvedValue(Database)
    };
    await expect(getOrCreateSecureSessionDb(options)).rejects.toThrow("load failed");
    const database = await getOrCreateSecureSessionDb(options);
    expect(database.open).toBe(true);
    await closeSecureSessionDb(options.dbPath);
  });
});
