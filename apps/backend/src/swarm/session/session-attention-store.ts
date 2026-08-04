import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SESSION_ATTENTION_MAX_ID_LENGTH,
  SESSION_ATTENTION_REASONS,
  type SessionAttentionReason,
} from "@forge/protocol";

import { writeJsonFileAtomic } from "../../utils/atomic-files.js";
import { isEnoentError } from "../../utils/fs-errors.js";
import { renameWithRetry } from "../retry-rename.js";
import { getSessionAttentionStorePath } from "../storage/data-paths.js";

const STORE_VERSION = 1;

export interface PersistedSessionAttention {
  attentionId: string;
  reason: SessionAttentionReason;
  raisedAt: string;
  dismissedAt?: string;
}

export interface PersistedSessionAttentionRecord {
  profileId: string;
  epoch: number;
  phase: "working" | "settled";
  workStartedAt: string;
  /** A failure observed during this epoch takes precedence over plan enrichment. */
  hadError?: boolean;
  /**
   * True once this epoch observed an accepted turn still queued. The queue is
   * dequeued on the provider's user message_start, which can precede the
   * manager's own streaming projection, so a drop to zero is NOT permission to
   * settle. Only an authoritative manager streaming transition (continuation
   * really began) or an explicit no-continuation release may clear it.
   */
  awaitingContinuation?: boolean;
  attention?: PersistedSessionAttention;
}

export interface PersistedSessionAttentionState {
  version: 1;
  revision: number;
  sessions: Record<string, PersistedSessionAttentionRecord>;
}

export interface SessionAttentionStoreOptions {
  /** Canonical root used when filePath is not supplied. */
  dataDir?: string;
  /** Test seam; production callers should use dataDir and the canonical path helper. */
  filePath?: string;
  now?: () => string;
  randomId?: () => string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  write?: (path: string, state: PersistedSessionAttentionState) => Promise<void>;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Small, strict, global attention document. Serialization belongs to the
 * coordinator; this adapter only owns validation, atomic replacement, and
 * corrupt-file recovery.
 */
export class SessionAttentionStore {
  readonly filePath: string;

  private readonly now: () => string;
  private readonly randomId: () => string;
  private readonly read: (path: string, encoding: "utf8") => Promise<string>;
  private readonly write: (path: string, state: PersistedSessionAttentionState) => Promise<void>;
  private readonly log: (message: string, details?: Record<string, unknown>) => void;

  constructor(options: SessionAttentionStoreOptions) {
    if (!options.filePath && !options.dataDir) {
      throw new Error("SessionAttentionStore requires dataDir or filePath");
    }

    this.filePath = options.filePath ?? getSessionAttentionStorePath(options.dataDir!);
    this.now = options.now ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.read = options.readFile ?? readFile;
    this.write = options.write ?? writeJsonFileAtomic;
    this.log = options.log ?? (() => undefined);
  }

  async load(): Promise<PersistedSessionAttentionState> {
    let raw: string;
    try {
      raw = await this.read(this.filePath, "utf8");
    } catch (error) {
      if (isEnoentError(error)) {
        return emptySessionAttentionState();
      }
      // No content was read, so this is NOT malformed-file recovery. Starting
      // from an empty baseline would let a later successful write erase durable
      // acknowledgements and armed epochs. Fail closed instead.
      this.log("session-attention:failed_to_read", {
        path: this.filePath,
        message: errorMessage(error),
      });
      throw new Error(`Session attention store is unreadable: ${errorMessage(error)}`);
    }

    try {
      return parsePersistedSessionAttentionState(JSON.parse(raw));
    } catch (error) {
      this.log("session-attention:corrupt_store", {
        path: this.filePath,
        message: errorMessage(error),
      });
      await this.quarantineCorruptFile();
      return emptySessionAttentionState();
    }
  }

  async save(state: PersistedSessionAttentionState): Promise<void> {
    const normalized = parsePersistedSessionAttentionState(state);
    await this.write(this.filePath, normalized);
  }

  private async quarantineCorruptFile(): Promise<void> {
    const suffix = `${safeFileSegment(this.now())}-${safeFileSegment(this.randomId())}`;
    const target = `${this.filePath}.corrupt-${suffix}`;
    try {
      await renameWithRetry(this.filePath, target, { retries: 8, baseDelayMs: 15 });
    } catch (error) {
      if (!isEnoentError(error)) {
        this.log("session-attention:failed_to_quarantine_corrupt_store", {
          path: this.filePath,
          message: errorMessage(error),
        });
      }
    }
  }
}

export function emptySessionAttentionState(): PersistedSessionAttentionState {
  return { version: STORE_VERSION, revision: 0, sessions: {} };
}

export function cloneSessionAttentionState(
  state: PersistedSessionAttentionState,
): PersistedSessionAttentionState {
  return {
    version: STORE_VERSION,
    revision: state.revision,
    sessions: Object.fromEntries(
      Object.entries(state.sessions).map(([sessionAgentId, record]) => [
        sessionAgentId,
        {
          ...record,
          ...(record.attention ? { attention: { ...record.attention } } : {}),
        },
      ]),
    ),
  };
}

export function parsePersistedSessionAttentionState(value: unknown): PersistedSessionAttentionState {
  const state = requiredRecord(value, "session attention state");
  if (state.version !== STORE_VERSION) {
    throw new Error("Unsupported session attention store version");
  }

  const revision = nonNegativeInteger(state.revision, "session attention revision");
  const sessions = requiredRecord(state.sessions, "session attention sessions");
  const normalizedSessions: Record<string, PersistedSessionAttentionRecord> = {};

  for (const [sessionAgentId, rawRecord] of Object.entries(sessions)) {
    if (!isNonEmptyString(sessionAgentId, SESSION_ATTENTION_MAX_ID_LENGTH)) {
      throw new Error("Invalid session attention session id");
    }
    normalizedSessions[sessionAgentId] = parseRecord(rawRecord);
  }

  return { version: STORE_VERSION, revision, sessions: normalizedSessions };
}

function parseRecord(value: unknown): PersistedSessionAttentionRecord {
  const record = requiredRecord(value, "session attention record");
  const profileId = requiredString(record.profileId, "session attention profile id", SESSION_ATTENTION_MAX_ID_LENGTH);
  const epoch = positiveInteger(record.epoch, "session attention epoch");
  const workStartedAt = requiredString(record.workStartedAt, "session attention work start", 128);
  const hadError = record.hadError === undefined ? undefined : requiredBoolean(record.hadError, "session attention hadError");
  const awaitingContinuation = record.awaitingContinuation === undefined
    ? undefined
    : requiredBoolean(record.awaitingContinuation, "session attention awaitingContinuation");

  if (record.phase === "working") {
    if (record.attention !== undefined) {
      throw new Error("Working session attention record cannot contain attention");
    }
    return {
      profileId,
      epoch,
      phase: "working",
      workStartedAt,
      ...(hadError ? { hadError: true } : {}),
      // Preserved across restart: a continuation barrier must survive a crash,
      // otherwise boot could settle an epoch whose continuation never ran.
      ...(awaitingContinuation ? { awaitingContinuation: true } : {}),
    };
  }

  if (record.phase !== "settled") {
    throw new Error("Invalid session attention phase");
  }

  return {
    profileId,
    epoch,
    phase: "settled",
    workStartedAt,
    ...(hadError ? { hadError: true } : {}),
    attention: parseAttention(record.attention),
  };
}

function parseAttention(value: unknown): PersistedSessionAttention {
  const attention = requiredRecord(value, "session attention occurrence");
  const reason = attention.reason;
  if (!(SESSION_ATTENTION_REASONS as readonly unknown[]).includes(reason)) {
    throw new Error("Invalid session attention reason");
  }

  return {
    attentionId: requiredString(attention.attentionId, "session attention id", SESSION_ATTENTION_MAX_ID_LENGTH),
    reason: reason as SessionAttentionReason,
    raisedAt: requiredString(attention.raisedAt, "session attention raised at", 128),
    ...(attention.dismissedAt === undefined
      ? {}
      : { dismissedAt: requiredString(attention.dismissedAt, "session attention dismissed at", 128) }),
  };
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxLength: number): string {
  if (!isNonEmptyString(value, maxLength)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  // See positiveInteger: unsafe integers break monotonic revision increments.
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  // Safe-integer bound matters: beyond it, `n + 1 === n`, which would silently
  // break monotonic revisions and epoch increments. Treat it as malformed.
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value as number;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^0-9A-Za-z.-]/g, "-").slice(0, 128) || "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
