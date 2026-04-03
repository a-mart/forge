import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateHistoricalProviderUsagePace,
  normalizeWeeklyResetAtMs,
  ProviderUsageHistoryStore,
  type ProviderUsageHistoryProvider
} from "./provider-usage-history.js";

type ForgeWeeklyWindow = {
  percent: number;
  resetInfo: string;
  resetAtMs: number;
  windowSeconds: number;
};

type ForgeHistoryRecord = {
  v: 1;
  provider: ProviderUsageHistoryProvider;
  windowKind: "weekly";
  accountKey?: string;
  sampledAtMs: number;
  percent: number;
  resetAtMs: number;
  windowSeconds: number;
};

type CodexbarHistoryRecord = {
  v?: number;
  provider?: string;
  windowKind?: string;
  accountKey?: string | null;
  sampledAt?: string | number | null;
  usedPercent?: number | null;
  resetsAt?: string | number | null;
  windowMinutes?: number | null;
};

type VerificationResult = {
  accountEmail?: string;
  accountKey?: string;
  datasetWeekCount: number;
  priorWeekCount: number;
  pace?: ReturnType<typeof evaluateHistoricalProviderUsagePace>;
};

type ImportSummary = {
  sourcePath: string;
  targetPath: string;
  sourceLineCount: number;
  eligibleSourceRecords: number;
  skippedSourceRecords: number;
  appendedRecords: number;
  duplicateRecords: number;
  before: VerificationResult;
  after: VerificationResult;
};

const DEFAULT_CODEXBAR_HISTORY_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "CodexBar",
  "usage-history.jsonl"
);
const DEFAULT_FORGE_HISTORY_PATH = path.join(os.homedir(), ".forge", "shared", "provider-usage-history.jsonl");
const DEFAULT_FORGE_USAGE_CACHE_PATH = path.join(os.homedir(), ".forge", "shared", "provider-usage-cache.json");
const DEFAULT_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/u;
const CODEXBAR_EMAIL_HASH_PREFIX = "codex:v1:email-hash:";

export async function importCodexbarProviderUsageHistory(options?: {
  sourcePath?: string;
  targetPath?: string;
  usageCachePath?: string;
}): Promise<ImportSummary> {
  const sourcePath = path.resolve(options?.sourcePath ?? DEFAULT_CODEXBAR_HISTORY_PATH);
  const targetPath = path.resolve(options?.targetPath ?? DEFAULT_FORGE_HISTORY_PATH);
  const usageCachePath = path.resolve(options?.usageCachePath ?? DEFAULT_FORGE_USAGE_CACHE_PATH);

  const before = await verifyHistoricalPace(targetPath, usageCachePath);
  const sourceText = await readFile(sourcePath, "utf8");
  const targetText = await readTextIfExists(targetPath);

  const existingKeys = new Set(
    targetText
      .split(/\r?\n/u)
      .map(parseForgeHistoryRecord)
      .filter((record): record is ForgeHistoryRecord => record !== null)
      .map(toRecordKey)
  );

  let sourceLineCount = 0;
  let eligibleSourceRecords = 0;
  let skippedSourceRecords = 0;
  let duplicateRecords = 0;
  const recordsToAppend: ForgeHistoryRecord[] = [];

  for (const rawLine of sourceText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    sourceLineCount += 1;
    const imported = parseCodexbarHistoryRecord(line);
    if (!imported) {
      skippedSourceRecords += 1;
      continue;
    }

    eligibleSourceRecords += 1;
    const recordKey = toRecordKey(imported);
    if (existingKeys.has(recordKey)) {
      duplicateRecords += 1;
      continue;
    }

    existingKeys.add(recordKey);
    recordsToAppend.push(imported);
  }

  if (recordsToAppend.length > 0) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const payload = `${recordsToAppend.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await appendFile(targetPath, payload, "utf8");
  }

  const after = await verifyHistoricalPace(targetPath, usageCachePath);
  return {
    sourcePath,
    targetPath,
    sourceLineCount,
    eligibleSourceRecords,
    skippedSourceRecords,
    appendedRecords: recordsToAppend.length,
    duplicateRecords,
    before,
    after
  };
}

async function verifyHistoricalPace(targetPath: string, usageCachePath: string): Promise<VerificationResult> {
  const usageCache = await readUsageCache(usageCachePath);
  const entries = isRecord(usageCache?.entries) ? usageCache.entries : undefined;
  const openai = isRecord(entries?.openai) ? entries.openai : undefined;
  const data = isRecord(openai?.data) ? openai.data : undefined;
  const accountEmail = normalizeString(data?.accountEmail)?.toLowerCase();
  const accountKey = accountEmail ? toHistoryAccountKey(accountEmail) : undefined;
  const weeklyUsage = normalizeWeeklyUsage(data?.weeklyUsage);
  const sampledAtMs = normalizeTimestampMs(openai?.fetchedAtMs ?? openai?.lastAttemptMs ?? Date.now());

  const store = new ProviderUsageHistoryStore(targetPath);
  const dataset = await store.loadDataset("openai", accountKey);
  const priorWeekCount = weeklyUsage
    ? (dataset?.weeks.filter((week) => week.windowSeconds === weeklyUsage.windowSeconds && week.resetAtMs < weeklyUsage.resetAtMs)
        .length ?? 0)
    : 0;

  return {
    accountEmail,
    accountKey,
    datasetWeekCount: dataset?.weeks.length ?? 0,
    priorWeekCount,
    pace: weeklyUsage ? evaluateHistoricalProviderUsagePace(weeklyUsage, sampledAtMs, dataset) : undefined
  };
}

async function readUsageCache(usageCachePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(usageCachePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function parseCodexbarHistoryRecord(line: string): ForgeHistoryRecord | null {
  try {
    const parsed = JSON.parse(line) as CodexbarHistoryRecord;
    if (parsed.provider !== "codex" || parsed.windowKind !== "secondary") {
      return null;
    }

    const sampledAtMs = normalizeDateInputMs(parsed.sampledAt);
    const resetAtMs = normalizeResetAtMs(parsed.resetsAt);
    const windowSeconds = normalizeWindowMinutes(parsed.windowMinutes);
    if (sampledAtMs === null || resetAtMs === null || windowSeconds === null) {
      return null;
    }

    const accountKey = normalizeImportedAccountKey(parsed.accountKey);
    if (parsed.accountKey != null && accountKey === undefined) {
      return null;
    }

    return {
      v: 1,
      provider: "openai",
      windowKind: "weekly",
      accountKey,
      sampledAtMs,
      percent: clamp(typeof parsed.usedPercent === "number" ? parsed.usedPercent : 0, 0, 100),
      resetAtMs,
      windowSeconds
    };
  } catch {
    return null;
  }
}

function parseForgeHistoryRecord(line: string): ForgeHistoryRecord | null {
  try {
    const parsed = JSON.parse(line) as Partial<ForgeHistoryRecord>;
    if (parsed.provider !== "openai" && parsed.provider !== "anthropic") {
      return null;
    }

    if (parsed.windowKind !== "weekly") {
      return null;
    }

    const sampledAtMs = normalizeTimestampMs(parsed.sampledAtMs);
    const resetAtMs = normalizeResetAtMs(parsed.resetAtMs);
    const windowSeconds = normalizeWindowSeconds(parsed.windowSeconds ?? DEFAULT_WEEKLY_WINDOW_SECONDS);
    if (resetAtMs === null || windowSeconds === null) {
      return null;
    }

    return {
      v: 1,
      provider: parsed.provider,
      windowKind: "weekly",
      accountKey: normalizeImportedAccountKey(parsed.accountKey),
      sampledAtMs,
      percent: clamp(typeof parsed.percent === "number" ? parsed.percent : 0, 0, 100),
      resetAtMs,
      windowSeconds
    };
  } catch {
    return null;
  }
}

function normalizeImportedAccountKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const lowered = trimmed.toLowerCase();
  if (HEX_64_PATTERN.test(lowered)) {
    return lowered;
  }

  if (lowered.startsWith(CODEXBAR_EMAIL_HASH_PREFIX)) {
    const suffix = lowered.slice(CODEXBAR_EMAIL_HASH_PREFIX.length);
    return HEX_64_PATTERN.test(suffix) ? suffix : undefined;
  }

  return undefined;
}

function normalizeWeeklyUsage(value: unknown): ForgeWeeklyWindow | null {
  if (!isRecord(value)) {
    return null;
  }

  const resetAtMs = normalizeResetAtMs(value.resetAtMs);
  const windowSeconds = normalizeWindowSeconds(value.windowSeconds ?? DEFAULT_WEEKLY_WINDOW_SECONDS);
  if (resetAtMs === null || windowSeconds === null) {
    return null;
  }

  return {
    percent: clamp(typeof value.percent === "number" ? value.percent : 0, 0, 100),
    resetInfo: normalizeString(value.resetInfo) ?? "",
    resetAtMs,
    windowSeconds
  };
}

function toRecordKey(record: ForgeHistoryRecord): string {
  return [
    record.provider,
    record.windowKind,
    record.accountKey ?? "",
    record.sampledAtMs,
    record.percent,
    record.resetAtMs,
    record.windowSeconds
  ].join(":");
}

function toHistoryAccountKey(accountEmail: string): string {
  return createHash("sha256").update(accountEmail).digest("hex");
}

function normalizeWindowMinutes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value * 60);
}

function normalizeWindowSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.round(value);
}

function normalizeDateInputMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }

  return null;
}

function normalizeResetAtMs(value: unknown): number | null {
  const parsed = normalizeDateInputMs(value);
  return parsed === null ? null : normalizeWeeklyResetAtMs(parsed);
}

function normalizeTimestampMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return Date.now();
  }

  return Math.round(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(argv: string[]): { sourcePath?: string; targetPath?: string; usageCachePath?: string } {
  const output: { sourcePath?: string; targetPath?: string; usageCachePath?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") {
      output.sourcePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--target") {
      output.targetPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--cache") {
      output.usageCachePath = argv[index + 1];
      index += 1;
    }
  }
  return output;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  importCodexbarProviderUsageHistory(parseArgs(process.argv.slice(2)))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
