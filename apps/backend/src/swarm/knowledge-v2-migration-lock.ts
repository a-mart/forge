import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
}

export async function acquireKnowledgeMigrationLock(dataDir: string, migrationId: string): Promise<() => Promise<void>> {
  const lockPath = getKnowledgeMigrationLockPath(dataDir);
  await mkdir(dirname(lockPath), { recursive: true });
  const state: KnowledgeMigrationLockState = {
    migrationId,
    startedAt: new Date().toISOString(),
    pid: process.pid,
  };
  await writeFile(lockPath, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  return async () => {
    await rm(lockPath, { force: true });
  };
}

export async function readKnowledgeMigrationLock(dataDir: string): Promise<KnowledgeMigrationLockState | null> {
  try {
    const raw = await readFile(getKnowledgeMigrationLockPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<KnowledgeMigrationLockState>;
    if (typeof parsed.migrationId === "string" && typeof parsed.startedAt === "string") {
      return {
        migrationId: parsed.migrationId,
        startedAt: parsed.startedAt,
        pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      };
    }
    return null;
  } catch (error) {
    if (isEnoentError(error)) return null;
    throw error;
  }
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
