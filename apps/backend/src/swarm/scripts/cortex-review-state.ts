import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionMeta } from "@middleman/protocol";
import {
  getCortexPromotionManifestsDir,
  getCortexReviewLockPath,
  getCortexReviewLogPath,
  sanitizePathSegment
} from "../data-paths.js";
import { readSessionMeta, writeSessionMeta } from "../session-manifest.js";

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

export interface RenewCortexReviewLockResult {
  lockPath: string;
  renewed: boolean;
  lease: CortexReviewLockRecord | null;
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

export interface CortexReviewWatermarkUpdate {
  profileId: string;
  sessionId: string;
  cortexReviewedBytes?: number;
  cortexReviewedAt?: string | null;
  cortexReviewedMemoryBytes?: number;
  cortexReviewedMemoryAt?: string | null;
  cortexReviewedFeedbackBytes?: number;
  cortexReviewedFeedbackAt?: string | null;
}

export interface FinalizeCortexReviewCycleInput extends AppendCortexReviewLogEntryInput {
  manifestContent?: string;
  watermarkUpdates?: CortexReviewWatermarkUpdate[];
  requireLock?: boolean;
  releaseLock?: boolean;
}

export interface FinalizeCortexReviewCycleResult {
  manifestPath?: string;
  logEntry: CortexReviewLogEntry;
  updatedSessions: string[];
  lockReleased: boolean;
}

export async function acquireCortexReviewLock(options: {
  dataDir: string;
  ownerId: string;
  reviewId?: string;
  ttlMs?: number;
  now?: Date;
}): Promise<AcquireCortexReviewLockResult> {
  const dataDir = resolve(options.dataDir);
  const lockPath = getCortexReviewLockPath(dataDir);
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const acquired = await tryWriteExclusiveFile(lockPath, `${JSON.stringify(nextLease, null, 2)}\n`);
    if (acquired) {
      return { lockPath, acquired: true, staleReplaced, lease: nextLease };
    }

    const existing = await readCortexReviewLock(dataDir);
    if (!existing) {
      continue;
    }

    if (!isLockExpired(existing, now)) {
      const sameLease = existing.ownerId === nextLease.ownerId && existing.reviewId === nextLease.reviewId;
      if (!sameLease) {
        return { lockPath, acquired: false, staleReplaced: false, lease: existing };
      }
    }

    staleReplaced =
      staleReplaced ||
      existing.ownerId !== nextLease.ownerId ||
      existing.reviewId !== nextLease.reviewId ||
      isLockExpired(existing, now);
    await rm(lockPath, { force: true });
  }

  const finalLease = (await readCortexReviewLock(dataDir)) ?? nextLease;
  return {
    lockPath,
    acquired: false,
    staleReplaced,
    lease: finalLease
  };
}

export async function releaseCortexReviewLock(options: { dataDir: string; ownerId: string; reviewId: string }): Promise<boolean> {
  const dataDir = resolve(options.dataDir);
  const existing = await readCortexReviewLock(dataDir);
  if (!existing || existing.ownerId !== sanitizePathSegment(options.ownerId)) {
    return false;
  }

  if (existing.reviewId !== options.reviewId.trim()) {
    return false;
  }

  await rm(getCortexReviewLockPath(dataDir), { force: true });
  return true;
}

export async function readCortexReviewLock(dataDir: string): Promise<CortexReviewLockRecord | null> {
  const lockPath = getCortexReviewLockPath(resolve(dataDir));
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

export async function renewCortexReviewLock(options: {
  dataDir: string;
  ownerId: string;
  reviewId?: string;
  ttlMs?: number;
  now?: Date;
}): Promise<RenewCortexReviewLockResult> {
  const dataDir = resolve(options.dataDir);
  const lockPath = getCortexReviewLockPath(dataDir);
  const now = options.now ?? new Date();
  const existing = await readCortexReviewLock(dataDir);
  const ownerId = sanitizePathSegment(options.ownerId);
  const reviewId = options.reviewId?.trim() || undefined;

  if (!existing || existing.ownerId !== ownerId || existing.reviewId !== reviewId || isLockExpired(existing, now)) {
    return { lockPath, renewed: false, lease: existing };
  }

  const renewedLease: CortexReviewLockRecord = {
    ...existing,
    expiresAt: new Date(now.getTime() + normalizeTtlMs(options.ttlMs)).toISOString()
  };
  await writeFile(lockPath, `${JSON.stringify(renewedLease, null, 2)}\n`, "utf8");
  return { lockPath, renewed: true, lease: renewedLease };
}

export async function appendCortexReviewLogEntry(options: {
  dataDir: string;
  entry: AppendCortexReviewLogEntryInput;
}): Promise<CortexReviewLogEntry> {
  const logPath = getCortexReviewLogPath(resolve(options.dataDir));
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
  const manifestsDir = getCortexPromotionManifestsDir(resolve(options.dataDir));
  const reviewId = sanitizeReviewId(options.reviewId);
  await mkdir(manifestsDir, { recursive: true });
  const manifestPath = join(manifestsDir, `${reviewId}.md`);
  await writeFile(manifestPath, options.content, "utf8");
  return manifestPath;
}

export async function finalizeCortexReviewCycle(options: {
  dataDir: string;
  input: FinalizeCortexReviewCycleInput;
}): Promise<FinalizeCortexReviewCycleResult> {
  const dataDir = resolve(options.dataDir);
  const input = options.input;
  const ownerId = sanitizePathSegment(input.ownerId);

  if (input.requireLock ?? true) {
    const existingLock = await readCortexReviewLock(dataDir);
    if (!existingLock || existingLock.ownerId !== ownerId || existingLock.reviewId !== input.reviewId.trim()) {
      throw new Error("Cortex review lock is missing or owned by another review cycle.");
    }
  }

  const watermarkPlans = await prepareWatermarkUpdates(dataDir, input.watermarkUpdates ?? []);
  let manifestPath: string | undefined;
  if (typeof input.manifestContent === "string") {
    manifestPath = await writeCortexPromotionManifest({
      dataDir,
      reviewId: input.reviewId,
      content: input.manifestContent
    });
  }

  for (const plan of watermarkPlans) {
    await writeSessionMeta(dataDir, plan.nextMeta);
  }

  const logEntry = await appendCortexReviewLogEntry({
    dataDir,
    entry: {
      reviewId: input.reviewId,
      ownerId,
      status: input.status,
      reviewed: input.reviewed,
      changedFiles: input.changedFiles,
      blockers: input.blockers,
      notes: input.notes,
      watermarksAdvanced: input.watermarksAdvanced,
      recordedAt: input.recordedAt
    }
  });

  const lockReleased = input.releaseLock
    ? await releaseCortexReviewLock({ dataDir, ownerId, reviewId: input.reviewId })
    : false;

  return {
    manifestPath,
    logEntry,
    updatedSessions: watermarkPlans.map((plan) => `${plan.nextMeta.profileId}/${plan.nextMeta.sessionId}`),
    lockReleased
  };
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

async function tryWriteExclusiveFile(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (isEexistError(error)) {
      return false;
    }
    throw error;
  }
}

async function prepareWatermarkUpdates(
  dataDir: string,
  updates: CortexReviewWatermarkUpdate[]
): Promise<Array<{ nextMeta: SessionMeta }>> {
  const plans: Array<{ nextMeta: SessionMeta }> = [];

  for (const update of updates) {
    const profileId = sanitizePathSegment(update.profileId);
    const sessionId = sanitizePathSegment(update.sessionId);
    const existing = await readSessionMeta(dataDir, profileId, sessionId);
    if (!existing) {
      throw new Error(`Session meta not found for ${profileId}/${sessionId}`);
    }

    plans.push({
      nextMeta: {
        ...existing,
        updatedAt: new Date().toISOString(),
        cortexReviewedBytes: update.cortexReviewedBytes ?? existing.cortexReviewedBytes,
        cortexReviewedAt:
          update.cortexReviewedAt === undefined ? existing.cortexReviewedAt : update.cortexReviewedAt ?? undefined,
        cortexReviewedMemoryBytes: update.cortexReviewedMemoryBytes ?? existing.cortexReviewedMemoryBytes,
        cortexReviewedMemoryAt:
          update.cortexReviewedMemoryAt === undefined ? existing.cortexReviewedMemoryAt : update.cortexReviewedMemoryAt,
        cortexReviewedFeedbackBytes:
          update.cortexReviewedFeedbackBytes ?? existing.cortexReviewedFeedbackBytes,
        cortexReviewedFeedbackAt:
          update.cortexReviewedFeedbackAt === undefined
            ? existing.cortexReviewedFeedbackAt
            : update.cortexReviewedFeedbackAt
      }
    });
  }

  return plans;
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

async function main(): Promise<void> {
  const [command, dataDir, arg3, arg4, ...rest] = process.argv.slice(2);
  if (!command || !dataDir) {
    console.error(
      "Usage: node cortex-review-state.js <acquire-lock|renew-lock|release-lock|append-log|write-manifest|finalize-review|read-lock> <data-dir> [...args]"
    );
    process.exitCode = 1;
    return;
  }

  switch (command) {
    case "acquire-lock": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js acquire-lock <data-dir> <ownerId> [reviewId] [ttlMs]");
      }
      const result = await acquireCortexReviewLock({
        dataDir,
        ownerId: arg3,
        reviewId: arg4,
        ttlMs: rest[0] ? Number.parseInt(rest[0], 10) : undefined
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "renew-lock": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js renew-lock <data-dir> <ownerId> [reviewId] [ttlMs]");
      }
      const renewed = await renewCortexReviewLock({
        dataDir,
        ownerId: arg3,
        reviewId: arg4,
        ttlMs: rest[0] ? Number.parseInt(rest[0], 10) : undefined
      });
      console.log(JSON.stringify(renewed, null, 2));
      return;
    }
    case "release-lock": {
      if (!arg3 || !arg4) {
        throw new Error("Usage: node cortex-review-state.js release-lock <data-dir> <ownerId> <reviewId>");
      }
      const released = await releaseCortexReviewLock({ dataDir, ownerId: arg3, reviewId: arg4 });
      console.log(JSON.stringify({ released, lockPath: getCortexReviewLockPath(resolve(dataDir)) }, null, 2));
      return;
    }
    case "read-lock": {
      const lock = await readCortexReviewLock(dataDir);
      console.log(JSON.stringify({ lockPath: getCortexReviewLockPath(resolve(dataDir)), lock }, null, 2));
      return;
    }
    case "append-log": {
      const raw = await readStdin();
      if (!raw.trim()) {
        throw new Error("append-log requires a JSON entry on stdin");
      }
      const entry = JSON.parse(raw) as AppendCortexReviewLogEntryInput;
      const appended = await appendCortexReviewLogEntry({ dataDir, entry });
      console.log(JSON.stringify({ logPath: getCortexReviewLogPath(resolve(dataDir)), entry: appended }, null, 2));
      return;
    }
    case "write-manifest": {
      if (!arg3) {
        throw new Error("Usage: node cortex-review-state.js write-manifest <data-dir> <reviewId>");
      }
      const content = await readStdin();
      const manifestPath = await writeCortexPromotionManifest({ dataDir, reviewId: arg3, content });
      console.log(JSON.stringify({ manifestPath }, null, 2));
      return;
    }
    case "finalize-review": {
      const raw = await readStdin();
      if (!raw.trim()) {
        throw new Error("finalize-review requires a JSON payload on stdin");
      }
      const input = JSON.parse(raw) as FinalizeCortexReviewCycleInput;
      const result = await finalizeCortexReviewCycle({ dataDir, input });
      console.log(JSON.stringify(result, null, 2));
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
