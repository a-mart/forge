import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { isEnoentError } from "../utils/fs-errors.js";
import {
  getCommonKnowledgePath,
  getKnowledgeMigrationLockPath,
  getProfileMemoryPath,
} from "./data-paths.js";

export class KnowledgeMigrationBusyError extends Error {
  constructor(message = "Knowledge v2 migration is running; legacy knowledge writes are temporarily busy.") {
    super(message);
    this.name = "KnowledgeMigrationBusyError";
  }
}

export interface KnowledgeMigrationLockState {
  migrationId: string;
  startedAt: string;
  pid: number;
  ownerToken: string;
}

/**
 * Acquires the shared migration/activation lock.
 *
 * The canonical lock path is an atomic ownership directory. Each holder writes
 * a token-named state file, so release can remove only its own file; an old
 * holder cannot delete a replacement owner's lock. Locks never auto-expire.
 * Legacy file locks and abandoned directories remain busy until explicitly
 * removed by an operator.
 */
export async function acquireKnowledgeMigrationLock(dataDir: string, migrationId: string): Promise<() => Promise<void>> {
  const lockPath = getKnowledgeMigrationLockPath(dataDir);
  await mkdir(dirname(lockPath), { recursive: true });
  await mkdir(lockPath);
  const state: KnowledgeMigrationLockState = {
    migrationId,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    ownerToken: randomUUID(),
  };
  const ownerPath = join(lockPath, `${state.ownerToken}.json`);
  try {
    await writeFile(ownerPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    await rmdir(lockPath).catch(() => undefined);
    throw error;
  }

  return async () => {
    // Removing this token-specific path is ownership-safe even if the entire
    // lock directory was replaced after acquisition.
    await rm(ownerPath, { force: true });
    try {
      await rmdir(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  };
}

export async function readKnowledgeMigrationLock(dataDir: string): Promise<KnowledgeMigrationLockState | null> {
  const lockPath = getKnowledgeMigrationLockPath(dataDir);
  try {
    const lockStat = await stat(lockPath);
    if (!lockStat.isDirectory()) {
      // Legacy ownerless file locks remain busy and cannot be released by the
      // ownership-safe primitive.
      return parseLockState(await readFile(lockPath, "utf8"), "");
    }
    const ownerFiles = (await readdir(lockPath)).filter((name) => name.endsWith(".json"));
    if (ownerFiles.length !== 1) {
      return { migrationId: "unknown-stale-lock", startedAt: "", pid: 0, ownerToken: "" };
    }
    const ownerToken = ownerFiles[0]!.slice(0, -".json".length);
    return parseLockState(await readFile(join(lockPath, ownerFiles[0]!), "utf8"), ownerToken);
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
}

function parseLockState(raw: string, ownerTokenFallback: string): KnowledgeMigrationLockState {
  try {
    const parsed = JSON.parse(raw) as Partial<KnowledgeMigrationLockState>;
    if (typeof parsed.migrationId === "string" && typeof parsed.startedAt === "string") {
      return {
        migrationId: parsed.migrationId,
        startedAt: parsed.startedAt,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
        ownerToken: typeof parsed.ownerToken === "string" ? parsed.ownerToken : ownerTokenFallback,
      };
    }
  } catch {
    // Invalid lock state remains conservatively busy.
  }
  return { migrationId: "unknown-stale-lock", startedAt: "", pid: 0, ownerToken: ownerTokenFallback };
}

export async function assertKnowledgeMigrationNotBusy(dataDir: string): Promise<void> {
  if (await readKnowledgeMigrationLock(dataDir)) {
    throw new KnowledgeMigrationBusyError();
  }
}

export async function isLegacyKnowledgeWritePath(dataDir: string, filePath: string): Promise<boolean> {
  const normalized = resolve(filePath);
  if (normalized === resolve(getCommonKnowledgePath(dataDir))) {
    return true;
  }

  const profilesDir = resolve(dataDir, "profiles");
  if (!normalized.startsWith(`${profilesDir}/`)) {
    return false;
  }

  const rest = normalized.slice(profilesDir.length + 1);
  const segments = rest.split("/");
  return segments.length === 2 && segments[1] === "memory.md" && normalized === resolve(getProfileMemoryPath(dataDir, segments[0]));
}
