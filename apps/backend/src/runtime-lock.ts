import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeLock {
  release(): void;
}

const RUNTIME_LOCK_FILE = "runtime.lock";
const LOCK_CONTENT_SEP = "\n";
const LOCK_IN_USE_ERROR =
  "Another Forge instance is using this data directory. " +
  "Close it first or use FORGE_DATA_DIR to specify a different directory.";

/**
 * Acquire an exclusive lock on the Forge data directory.
 * Throws if another instance already holds the lock.
 */
export function acquireRuntimeLock(dataDir: string): RuntimeLock {
  mkdirSync(dataDir, { recursive: true });

  const lockFile = join(dataDir, RUNTIME_LOCK_FILE);

  while (true) {
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(fd, `${process.pid}${LOCK_CONTENT_SEP}${new Date().toISOString()}${LOCK_CONTENT_SEP}`);
      } finally {
        closeSync(fd);
      }

      return {
        release() {
          try {
            unlinkSync(lockFile);
          } catch (error) {
            if (!(isErrorWithCode(error, "ENOENT"))) {
              throw error;
            }
          }
        },
      };
    } catch (error) {
      if (!isErrorWithCode(error, "EEXIST")) {
        throw error;
      }

      const stale = isStaleRuntimeLock(lockFile);
      if (!stale) {
        throw new Error(LOCK_IN_USE_ERROR);
      }
    }
  }
}

function isStaleRuntimeLock(lockFile: string): boolean {
  const existingPid = readRuntimeLockPid(lockFile);
  if (existingPid === null) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  try {
    process.kill(existingPid, 0);
    return false;
  } catch (error) {
    if (isErrorWithCode(error, "ESRCH")) {
      clearStaleRuntimeLock(lockFile);
      return true;
    }

    return false;
  }
}

function readRuntimeLockPid(lockFile: string): number | null {
  let raw: string;

  try {
    raw = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }

  const firstLine = raw.split(LOCK_CONTENT_SEP, 2)[0]?.trim();
  if (!firstLine) {
    return null;
  }

  const pid = Number.parseInt(firstLine, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function clearStaleRuntimeLock(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}
