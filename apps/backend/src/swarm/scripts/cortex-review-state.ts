import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  sanitizePathSegment
} from "../data-paths.js";

const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;

export interface CortexReviewLockRecord {
  ownerId: string;
  reviewId?: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireCortexReviewLockResult {
  lockPath: string;
  acquired: boolean;
  staleReplaced: boolean;
  lease: CortexReviewLockRecord;
}

export interface AppendCortexReviewLogEntryInput {
  reviewId: string;
  ownerId: string;
  status: "success" | "no-op" | "blocked" | "failed";
  reviewed: string[];
  changedFiles: string[];
  blockers?: string[];
  notes?: string[];
  watermarksAdvanced: boolean;
  recordedAt?: string;
}

export interface CortexReviewLogEntry extends AppendCortexReviewLogEntryInput {
  recordedAt: string;
}

export async function acquireCortexReviewLock(options: {
  dataDir: string;
  ownerId: string;
  reviewId?: string;
  ttlMs?: number;
  now?: Date;
}): Promise<AcquireCortexReviewLockResult> {
  const lockPath = getCortexReviewLockPath(options.dataDir);
  const now = options.now ?? new Date();
  const ttlMs = normalizeTtlMs(options.ttlMs);
  const nextLease: CortexReviewLockRecord = {
    ownerId: sanitizePathSegment(options.ownerId),
    reviewId: options.reviewId?.trim() || undefined,
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString()
  };

  await mkdir(dirname(lockPath), { recursive: true });

  let staleReplaced = false;
  try {
    const existing = await readCortexReviewLock(options.dataDir);
    if (existing) {
      if (!isLockExpired(existing, now) && existing.ownerId !== nextLease.ownerId) {
        return { lockPath, acquired: false, staleReplaced: false, lease: existing };
      }
      staleReplaced = existing.ownerId !== nextLease.ownerId;
    }
  } catch (error) {
    if (!isEnoentError(error)) {
      throw error;
    }
  }

  await writeFile(lockPath, `${JSON.stringify(nextLease, null, 2)}\n`, "utf8");
  return { lockPath, acquired: true, staleReplaced, lease: nextLease };
}

export async function releaseCortexReviewLock(options: { dataDir: string; ownerId: string }): Promise<boolean> {
  const existing = await readCortexReviewLock(options.dataDir);
  if (!existing || existing.ownerId !== sanitizePathSegment(options.ownerId)) {
    return false;
  }

  await rm(getCortexReviewLockPath(options.dataDir), { force: true });
  return true;
}

export async function readCortexReviewLock(dataDir: string): Promise<CortexReviewLockRecord | null> {
  const lockPath = getCortexReviewLockPath(dataDir);
  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CortexReviewLockRecord>;
    if (typeof parsed.ownerId !== "string" || typeof parsed.acquiredAt !== "string" || typeof parsed.expiresAt !== "string") {
      return null;
    }

    return {
      ownerId: parsed.ownerId,
      reviewId: typeof parsed.reviewId === "string" ? parsed.reviewId : undefined,
      acquiredAt: parsed.acquiredAt,
      expiresAt: parsed.expiresAt
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return null;
    }
    throw error;
  }
}

export async function appendCortexReviewLogEntry(options: { dataDir: string; entry: AppendCortexReviewLogEntryInput }): Promise<CortexReviewLogEntry> {
  const logPath = getCortexReviewLogPath(options.dataDir);
  const entry: CortexReviewLogEntry = {
    ...options.entry,
    ownerId: sanitizePathSegment(options.entry.ownerId),
    reviewId: options.entry.reviewId.trim(),
    recordedAt: options.entry.recordedAt ?? new Date().toISOString(),
    blockers: options.entry.blockers ?? [],
    notes: options.entry.notes ?? []
  };

  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function writeCortexPromotionManifest(options: {
  dataDir: string;
  reviewId: string;
  content: string;
}): Promise<string> {
  const manifestsDir = getCortexPromotionManifestsDir(options.dataDir);
  const reviewId = sanitizeReviewId(options.reviewId);
  await mkdir(manifestsDir, { recursive: true });
  const manifestPath = join(manifestsDir, `${reviewId}.md`);
  await writeFile(manifestPath, options.content, "utf8");
  return manifestPath;
}

function sanitizeReviewId(reviewId: string): string {
  return sanitizePathSegment(reviewId.replace(/\s+/g, "-"));
}

function normalizeTtlMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOCK_TTL_MS;
  }

  return Math.max(1000, Math.floor(value));
}

function isLockExpired(lock: CortexReviewLockRecord, now: Date): boolean {
  const expiresAt = Date.parse(lock.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function main(): Promise<void> {
  const [command, dataDir, arg3, arg4, ...rest] = process.argv.slice(2);
  if (!command || !dataDir) {
    console.error("Usage: node cortex-review-state.js <acquire-lock|release-lock|append-log|write-manifest|read-lock> <data-dir> [...args]");
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "acquire-lock": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js acquire-lock <data-dir> <ownerId> [reviewId] [ttlMs]");
      }
      const result = await acquireCortexReviewLock({
        dataDir: resolve(dataDir),
        ownerId: arg3,
        reviewId: arg4,
        ttlMs: rest[0] ? Number.parseInt(rest[0], 10) : undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "release-lock": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js release-lock <data-dir> <ownerId>");
      }
      const released = await releaseCortexReviewLock({ dataDir: resolve(dataDir), ownerId: arg3 });
      console.log(JSON.stringify({ released, lockPath: getCortexReviewLockPath(resolve(dataDir)) }, null, 2));
      return;
    }
    case "read-lock": {
      const lock = await readCortexReviewLock(resolve(dataDir));
      console.log(JSON.stringify({ lockPath: getCortexReviewLockPath(resolve(dataDir)), lock }, null, 2));
      return;
    }
    case "append-log": {
      const raw = await readStdin();
      if (!raw.trim()) {
        throw new Error("append-log requires a JSON entry on stdin");
      }
      const entry = JSON.parse(raw) as AppendCortexReviewLogEntryInput;
      const appended = await appendCortexReviewLogEntry({ dataDir: resolve(dataDir), entry });
      console.log(JSON.stringify({ logPath: getCortexReviewLogPath(resolve(dataDir)), entry: appended }, null, 2));
      return;
    }
    case "write-manifest": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js write-manifest <data-dir> <reviewId>");
      }
      const content = await readStdin();
      const manifestPath = await writeCortexPromotionManifest({ dataDir: resolve(dataDir), reviewId: arg3, content });
      console.log(JSON.stringify({ manifestPath }, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown command '${command}'`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
