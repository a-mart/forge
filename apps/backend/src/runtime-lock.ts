import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
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
 * If a stale lock is found (owner PID is dead or not a node process), it's
 * automatically reclaimed. This prevents leftover lock files from blocking
 * startup after crashes or unclean shutdowns.
 *
 * Throws if another live instance already holds the lock.
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

  // If it's our own PID (e.g. restart within same process), reclaim it
  if (existingPid === process.pid) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // Check if the PID is alive at all
  if (!isPidAlive(existingPid)) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  // PID exists — but is it actually a Forge/node process?
  // On macOS/Linux, a recycled PID could belong to an unrelated process.
  if (!isNodeProcess(existingPid)) {
    clearStaleRuntimeLock(lockFile);
    return true;
  }

  return false;
}

/**
 * Check if a PID is alive. Handles both Unix and Windows.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Any error means the PID is not accessible to us — treat as dead
    return false;
  }
}

/**
 * Check if a PID belongs to a node process. This catches stale locks where
 * the original node process died and the OS recycled the PID for something
 * unrelated. Returns true if we can't determine (fail-open for safety on
 * platforms where we can't inspect process names).
 */
function isNodeProcess(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
        encoding: "utf8",
        timeout: 2000,
      });
      return out.toLowerCase().includes("node");
    }

    // macOS / Linux: check the process command
    const out = execSync(`ps -p ${pid} -o comm=`, {
      encoding: "utf8",
      timeout: 2000,
    });
    return out.toLowerCase().includes("node");
  } catch {
    // If we can't check, assume it's valid (fail-safe: don't steal a live lock)
    return true;
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
