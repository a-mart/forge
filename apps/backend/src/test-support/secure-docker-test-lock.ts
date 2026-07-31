import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_DIRECTORY = join(tmpdir(), "forge-secure-docker-e2e.lock");
const OWNER_FILE = join(LOCK_DIRECTORY, "owner.json");
const RETRY_DELAY_MS = 100;
const ACQUIRE_TIMEOUT_MS = 5 * 60 * 1_000;
const EMPTY_LOCK_STALE_MS = 30_000;

interface DockerTestLockOwner {
  pid: number;
}

/**
 * Docker's local daemon is a shared, security-sensitive test resource. The
 * suites deliberately create and destroy runners, fixture images, and
 * heartbeat-bound containers, so file-parallel Vitest workers must not race
 * those lifecycle assertions against one another.
 */
export async function acquireSecureDockerTestLock(): Promise<() => Promise<void>> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(LOCK_DIRECTORY, { mode: 0o700 });
      await writeFile(OWNER_FILE, `${JSON.stringify({ pid: process.pid })}\n`, {
        mode: 0o600,
      });
      return async () => {
        if (await ownsDockerTestLock()) {
          await rm(LOCK_DIRECTORY, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeAbandonedDockerTestLock();
      await delay(RETRY_DELAY_MS);
    }
  }
  throw new Error("Timed out acquiring the Secure Sessions Docker test lock");
}

async function ownsDockerTestLock(): Promise<boolean> {
  const owner = await readDockerTestLockOwner();
  return owner?.pid === process.pid;
}

async function removeAbandonedDockerTestLock(): Promise<void> {
  const owner = await readDockerTestLockOwner();
  if (owner) {
    if (!isProcessRunning(owner.pid)) {
      await rm(LOCK_DIRECTORY, { recursive: true, force: true });
    }
    return;
  }

  try {
    const lockStat = await stat(LOCK_DIRECTORY);
    if (Date.now() - lockStat.mtimeMs > EMPTY_LOCK_STALE_MS) {
      await rm(LOCK_DIRECTORY, { recursive: true, force: true });
    }
  } catch {
    // Another worker released or acquired the lock; retry normally.
  }
}

async function readDockerTestLockOwner(): Promise<DockerTestLockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(OWNER_FILE, "utf8")) as unknown;
    if (
      typeof parsed === "object"
      && parsed !== null
      && "pid" in parsed
      && Number.isInteger(parsed.pid)
      && (parsed.pid as number) > 0
    ) {
      return { pid: parsed.pid as number };
    }
  } catch {
    // A creator may still be writing owner metadata, or a crashed worker left
    // an empty lock. The caller uses the directory mtime before removing it.
  }
  return undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
