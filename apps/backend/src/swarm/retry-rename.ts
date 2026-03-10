import { rename } from "node:fs/promises";
import { renameSync } from "node:fs";

const DEFAULT_RETRIES = 8;
const DEFAULT_BASE_DELAY_MS = 15;
const DEFAULT_MAX_DELAY_MS = 250;

interface RenameRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface RenameSyncRetryOptions {
  retries?: number;
}

export async function renameWithRetry(
  from: string,
  to: string,
  opts: RenameRetryOptions = {}
): Promise<void> {
  const retries = normalizeRetries(opts.retries, DEFAULT_RETRIES);
  const baseDelayMs = normalizePositiveInteger(opts.baseDelayMs, DEFAULT_BASE_DELAY_MS);
  const maxDelayMs = normalizePositiveInteger(opts.maxDelayMs, DEFAULT_MAX_DELAY_MS);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= retries) {
        throw error;
      }

      const delayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await sleep(delayMs);
    }
  }
}

export function renameSyncWithRetry(
  from: string,
  to: string,
  opts: RenameSyncRetryOptions = {}
): void {
  const retries = normalizeRetries(opts.retries, 5);

  // Immediate retries without delay — sufficient for extremely transient locks.
  // For longer-held locks (antivirus scans), callers should prefer renameWithRetry (async).
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt >= retries) {
        throw error;
      }
    }
  }
}

function normalizeRetries(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.floor(value);
}

function isRetryableRenameError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EPERM", "EBUSY", "EACCES"].includes((error as { code?: string }).code ?? "")
  );
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
