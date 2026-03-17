import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentDescriptor as ProtocolAgentDescriptor,
  CortexReviewRunAxis,
  CortexReviewRunRecord,
  CortexReviewRunScope,
  CortexReviewRunStatus,
  CortexReviewRunTrigger,
  MessageSourceContext
} from "@middleman/protocol";
import { getCortexReviewRunsPath } from "./data-paths.js";
import type { ConversationEntryEvent } from "./types.js";

const CORTEX_REVIEW_RUNS_FILE_VERSION = 1;
const MAX_STORED_CORTEX_REVIEW_RUNS = 60;

interface StoredCortexReviewRunsFile {
  version: number;
  runs: StoredCortexReviewRun[];
}

export interface StoredCortexReviewRun {
  runId: string;
  trigger: CortexReviewRunTrigger;
  scope: CortexReviewRunScope;
  scopeLabel: string;
  requestText: string;
  requestedAt: string;
  sessionAgentId: string | null;
  sourceContext?: MessageSourceContext | null;
  blockedReason?: string | null;
  scheduleName?: string | null;
}

export interface ParsedScheduledTaskEnvelope {
  scheduleName?: string | null;
  scheduleId?: string | null;
  body: string;
}

export function createCortexReviewRunId(): string {
  return `review-${randomUUID()}`;
}

export function buildCortexReviewRunRequestText(scope: CortexReviewRunScope): string {
  if (scope.mode === "all") {
    return "Review all sessions that need attention";
  }

  const axes = (scope.axes ?? []).filter(isCortexReviewAxis);
  if (axes.length === 0) {
    return `Review session ${scope.profileId}/${scope.sessionId}`;
  }

  return `Review session ${scope.profileId}/${scope.sessionId} (${axes.join(", ")} freshness)`;
}

export function buildCortexReviewRunScopeLabel(scope: CortexReviewRunScope): string {
  if (scope.mode === "all") {
    return "All sessions that need attention";
  }

  const axes = (scope.axes ?? []).filter(isCortexReviewAxis);
  if (axes.length === 0) {
    return `${scope.profileId}/${scope.sessionId}`;
  }

  return `${scope.profileId}/${scope.sessionId} (${axes.join(", ")})`;
}

export async function appendCortexReviewRun(
  dataDir: string,
  run: StoredCortexReviewRun
): Promise<void> {
  const path = getCortexReviewRunsPath(dataDir);
  await mkdir(dirname(path), { recursive: true });

  const current = await readCortexReviewRunsFile(dataDir);
  const deduped = current.runs.filter((entry) => entry.runId !== run.runId);
  const next: StoredCortexReviewRunsFile = {
    version: CORTEX_REVIEW_RUNS_FILE_VERSION,
    runs: [run, ...deduped].slice(0, MAX_STORED_CORTEX_REVIEW_RUNS)
  };

  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function readStoredCortexReviewRuns(dataDir: string): Promise<StoredCortexReviewRun[]> {
  const file = await readCortexReviewRunsFile(dataDir);
  return file.runs;
}

export function parseScheduledTaskEnvelope(text: string): ParsedScheduledTaskEnvelope | null {
  const trimmed = text.trim();
  const scheduleHeader = trimmed.match(/^\[Scheduled Task:([^\]]+)\]\n(?:\[scheduleContext\]\s*(.+?)\n)?\n([\s\S]+)$/);
  if (!scheduleHeader) {
    return null;
  }

  const scheduleName = scheduleHeader[1]?.trim() || null;
  const rawContext = scheduleHeader[2]?.trim();
  const body = scheduleHeader[3]?.trim() || "";
  let scheduleId: string | null = null;

  if (rawContext) {
    try {
      const parsed = JSON.parse(rawContext) as { scheduleId?: unknown };
      if (typeof parsed.scheduleId === "string" && parsed.scheduleId.trim().length > 0) {
        scheduleId = parsed.scheduleId.trim();
      }
    } catch {
      // Ignore malformed schedule context — body parsing can still proceed.
    }
  }

  return {
    scheduleName,
    scheduleId,
    body
  };
}

export function parseCortexReviewRunScopeFromText(text: string): CortexReviewRunScope | null {
  const trimmed = text.trim();
  if (/^Review all sessions that need attention$/i.test(trimmed)) {
    return { mode: "all" };
  }

  const sessionMatch = trimmed.match(/^Review session\s+([^/\s]+)\/([^\s()]+)(?:\s+\(([^)]+)\))?$/i);
  if (!sessionMatch) {
    return null;
  }

  const profileId = sessionMatch[1]?.trim();
  const sessionId = sessionMatch[2]?.trim();
  const axesPart = sessionMatch[3]?.trim();
  const axes = parseAxesList(axesPart);

  if (!profileId || !sessionId) {
    return null;
  }

  return axes.length > 0
    ? { mode: "session", profileId, sessionId, axes }
    : { mode: "session", profileId, sessionId };
}

export function buildLiveCortexReviewRunRecord(options: {
  stored: StoredCortexReviewRun;
  sessionDescriptor?: ProtocolAgentDescriptor;
  activeWorkerCount: number;
  history?: ConversationEntryEvent[];
  queuePosition?: number | null;
}): CortexReviewRunRecord {
  const latestCloseout = findLatestUserVisibleCloseout(options.history ?? []);

  return {
    runId: options.stored.runId,
    trigger: options.stored.trigger,
    scope: options.stored.scope,
    scopeLabel: options.stored.scopeLabel,
    requestText: options.stored.requestText,
    requestedAt: options.stored.requestedAt,
    status: deriveLiveStatus(options.stored, options.sessionDescriptor, options.activeWorkerCount),
    sessionAgentId: options.stored.sessionAgentId,
    activeWorkerCount: options.activeWorkerCount,
    latestCloseout,
    queuePosition: options.queuePosition ?? null,
    blockedReason: options.stored.blockedReason ?? null,
    scheduleName: options.stored.scheduleName ?? null
  };
}

async function readCortexReviewRunsFile(dataDir: string): Promise<StoredCortexReviewRunsFile> {
  const path = getCortexReviewRunsPath(dataDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredCortexReviewRunsFile>;
    if (!parsed || !Array.isArray(parsed.runs)) {
      return { version: CORTEX_REVIEW_RUNS_FILE_VERSION, runs: [] };
    }

    return {
      version: typeof parsed.version === "number" ? parsed.version : CORTEX_REVIEW_RUNS_FILE_VERSION,
      runs: parsed.runs.filter(isStoredCortexReviewRun)
    };
  } catch (error) {
    if (isEnoentError(error)) {
      return { version: CORTEX_REVIEW_RUNS_FILE_VERSION, runs: [] };
    }
    throw error;
  }
}

function deriveLiveStatus(
  stored: StoredCortexReviewRun,
  sessionDescriptor: ProtocolAgentDescriptor | undefined,
  activeWorkerCount: number
): CortexReviewRunStatus {
  if (stored.blockedReason) {
    return "blocked";
  }

  if (!stored.sessionAgentId) {
    return "queued";
  }

  if (!sessionDescriptor) {
    return "completed";
  }

  if (sessionDescriptor.status === "streaming" || activeWorkerCount > 0) {
    return "running";
  }

  if (sessionDescriptor.status === "idle") {
    return "completed";
  }

  return "stopped";
}

function findLatestUserVisibleCloseout(history: ConversationEntryEvent[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry.type !== "conversation_message") {
      continue;
    }
    if (entry.role !== "assistant" || entry.source !== "speak_to_user") {
      continue;
    }

    const text = entry.text.trim();
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function parseAxesList(rawAxesPart: string | undefined): CortexReviewRunAxis[] {
  if (!rawAxesPart) {
    return [];
  }

  const normalized = rawAxesPart
    .replace(/freshness/gi, "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is CortexReviewRunAxis => isCortexReviewAxis(entry));

  return Array.from(new Set(normalized));
}

function isCortexReviewAxis(value: string): value is CortexReviewRunAxis {
  return value === "transcript" || value === "memory" || value === "feedback";
}

function isStoredCortexReviewRun(value: unknown): value is StoredCortexReviewRun {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredCortexReviewRun>;
  return (
    typeof candidate.runId === "string" &&
    isCortexReviewRunTrigger(candidate.trigger) &&
    isCortexReviewRunScope(candidate.scope) &&
    typeof candidate.scopeLabel === "string" &&
    typeof candidate.requestText === "string" &&
    typeof candidate.requestedAt === "string" &&
    (candidate.sessionAgentId === null || typeof candidate.sessionAgentId === "string") &&
    (candidate.sourceContext === undefined || candidate.sourceContext === null || isMessageSourceContext(candidate.sourceContext)) &&
    (candidate.blockedReason === undefined || candidate.blockedReason === null || typeof candidate.blockedReason === "string") &&
    (candidate.scheduleName === undefined || candidate.scheduleName === null || typeof candidate.scheduleName === "string")
  );
}

function isCortexReviewRunTrigger(value: unknown): value is CortexReviewRunTrigger {
  return value === "manual" || value === "scheduled";
}

function isCortexReviewRunScope(value: unknown): value is CortexReviewRunScope {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<CortexReviewRunScope> & {
    profileId?: unknown;
    sessionId?: unknown;
    axes?: unknown;
  };

  if (candidate.mode === "all") {
    return true;
  }

  if (candidate.mode !== "session") {
    return false;
  }

  if (typeof candidate.profileId !== "string" || candidate.profileId.trim().length === 0) {
    return false;
  }

  if (typeof candidate.sessionId !== "string" || candidate.sessionId.trim().length === 0) {
    return false;
  }

  if (candidate.axes === undefined) {
    return true;
  }

  return Array.isArray(candidate.axes) && candidate.axes.every((axis) => isCortexReviewAxis(String(axis)));
}

function isMessageSourceContext(value: unknown): value is MessageSourceContext {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<MessageSourceContext>;
  return candidate.channel === "web" || candidate.channel === "slack" || candidate.channel === "telegram";
}

function isEnoentError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}
