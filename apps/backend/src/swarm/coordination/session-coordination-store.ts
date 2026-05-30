import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SessionTaskDiagnosticState } from "@forge/protocol";
import { getSessionTasksPath } from "../storage/data-paths.js";
import { renameWithRetry } from "../storage/retry-rename.js";
import {
  cloneSessionCoordinationState,
  createEmptySessionCoordinationState,
  normalizeSessionCoordinationState,
  SessionCoordinationStateValidationError,
  type SessionCoordinationState
} from "./session-coordination-state.js";

export interface SessionCoordinationDiagnostics {
  state: SessionTaskDiagnosticState;
  message?: string;
}

export interface SessionCoordinationStoreLoadResult {
  state: SessionCoordinationState;
  diagnostics: SessionCoordinationDiagnostics;
}

export interface SessionCoordinationStoreMutationOptions {
  expectedStateRevision?: number;
}

export interface SessionCoordinationStoreMutationResult extends SessionCoordinationStoreLoadResult {
  previousRevision: number;
}

interface SessionCoordinationStoreDeps {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rm: typeof rm;
  renameWithRetry: typeof renameWithRetry;
  now: () => Date;
  randomId: () => string;
  logWarn: (message: string, meta?: Record<string, unknown>) => void;
}

const DEFAULT_DEPS: SessionCoordinationStoreDeps = {
  mkdir,
  readFile,
  writeFile,
  rm,
  renameWithRetry,
  now: () => new Date(),
  randomId: () => randomUUID(),
  logWarn: (message, meta) => {
    console.warn(message, meta);
  }
};

const coordinationStoreLocks = new Map<string, Promise<void>>();

export class SessionCoordinationStateRevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Session coordination state revision conflict: expected ${expectedRevision}, got ${actualRevision}`);
    this.name = "SessionCoordinationStateRevisionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SessionCoordinationStoreUnavailableError extends Error {
  constructor(message = "Session coordination state is unavailable") {
    super(message);
    this.name = "SessionCoordinationStoreUnavailableError";
  }
}

export class SessionCoordinationStore {
  readonly filePath: string;
  private readonly lockKey: string;
  private readonly deps: SessionCoordinationStoreDeps;

  constructor(options: {
    dataDir: string;
    profileId: string;
    sessionAgentId: string;
    deps?: Partial<SessionCoordinationStoreDeps>;
  }) {
    this.filePath = resolve(getSessionTasksPath(options.dataDir, options.profileId, options.sessionAgentId));
    this.lockKey = this.filePath;
    this.deps = { ...DEFAULT_DEPS, ...options.deps };
  }

  async load(): Promise<SessionCoordinationStoreLoadResult> {
    const loaded = await this.readStateFromDisk();
    return {
      state: cloneSessionCoordinationState(loaded.state),
      diagnostics: loaded.diagnostics
    };
  }

  async replace(
    nextState: SessionCoordinationState,
    options: SessionCoordinationStoreMutationOptions = {}
  ): Promise<SessionCoordinationStoreMutationResult> {
    return this.update(() => nextState, options);
  }

  async update(
    updater: (current: SessionCoordinationState) => SessionCoordinationState | Promise<SessionCoordinationState>,
    options: SessionCoordinationStoreMutationOptions = {}
  ): Promise<SessionCoordinationStoreMutationResult> {
    const expectedRevision = normalizeExpectedRevision(options.expectedStateRevision);

    return withCoordinationStoreLock(this.lockKey, async () => {
      const loaded = await this.readStateFromDisk();
      if (loaded.diagnostics.state === "unavailable") {
        throw new SessionCoordinationStoreUnavailableError(loaded.diagnostics.message);
      }

      if (expectedRevision !== undefined && loaded.state.revision !== expectedRevision) {
        throw new SessionCoordinationStateRevisionConflictError(expectedRevision, loaded.state.revision);
      }

      const previousRevision = loaded.state.revision;
      const timestamp = this.deps.now().toISOString();
      const proposed = await updater(cloneSessionCoordinationState(loaded.state));
      const normalized = normalizeSessionCoordinationState({
        ...proposed,
        revision: previousRevision,
        updatedAt: proposed.updatedAt ?? loaded.state.updatedAt ?? timestamp
      });
      const nextState: SessionCoordinationState = {
        ...normalized,
        revision: previousRevision + 1,
        updatedAt: timestamp
      };

      await this.writeStateAtomically(nextState);

      return {
        state: cloneSessionCoordinationState(nextState),
        diagnostics: { state: "ok" },
        previousRevision
      };
    });
  }

  private async readStateFromDisk(): Promise<SessionCoordinationStoreLoadResult> {
    let raw: string;
    try {
      raw = await this.deps.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return {
          state: createEmptySessionCoordinationState(),
          diagnostics: { state: "defaulted" }
        };
      }

      this.deps.logWarn("[swarm] coordination:failed_to_read", {
        path: this.filePath,
        message: error instanceof Error ? error.message : String(error)
      });
      return {
        state: createEmptySessionCoordinationState(),
        diagnostics: {
          state: "unavailable",
          message: "Session coordination state could not be read."
        }
      };
    }

    try {
      return {
        state: normalizeSessionCoordinationState(JSON.parse(raw)),
        diagnostics: { state: "ok" }
      };
    } catch (error) {
      this.deps.logWarn("[swarm] coordination:failed_to_load", {
        path: this.filePath,
        message: error instanceof Error ? error.message : String(error)
      });
      const recovered = await this.recoverCorruptFile();
      if (!recovered) {
        return {
          state: createEmptySessionCoordinationState(),
          diagnostics: {
            state: "unavailable",
            message: "Session coordination state could not be recovered safely."
          }
        };
      }

      return {
        state: createEmptySessionCoordinationState(),
        diagnostics: {
          state: "corrupt_recovered",
          message: "Recovered malformed session coordination state."
        }
      };
    }
  }

  private async recoverCorruptFile(): Promise<boolean> {
    const backupPath = createCorruptBackupPath(this.filePath, this.deps.now(), this.deps.randomId());

    try {
      await this.deps.renameWithRetry(this.filePath, backupPath, { retries: 8, baseDelayMs: 15 });
      return true;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        return true;
      }

      this.deps.logWarn("[swarm] coordination:failed_to_backup_corrupt", {
        path: this.filePath,
        backupPath,
        message: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  private async writeStateAtomically(nextState: SessionCoordinationState): Promise<void> {
    const filePath = this.filePath;
    const targetDir = dirname(filePath);
    const tempPath = join(targetDir, `${basename(filePath)}.${process.pid}.${this.deps.randomId()}.tmp`);

    await this.deps.mkdir(targetDir, { recursive: true });

    try {
      await this.deps.writeFile(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
      await this.deps.renameWithRetry(tempPath, filePath, { retries: 8, baseDelayMs: 15 });
    } catch (error) {
      await this.deps.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

async function withCoordinationStoreLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  const previous = coordinationStoreLocks.get(lockKey) ?? Promise.resolve();
  let releaseCurrentLock: (() => void) | undefined;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrentLock = resolveCurrent;
  });
  const nextLock = previous.catch(() => {}).then(() => current);
  coordinationStoreLocks.set(lockKey, nextLock);

  await previous.catch(() => {});

  try {
    return await operation();
  } finally {
    releaseCurrentLock?.();
    if (coordinationStoreLocks.get(lockKey) === nextLock) {
      coordinationStoreLocks.delete(lockKey);
    }
  }
}

function normalizeExpectedRevision(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new SessionCoordinationStateValidationError("expectedStateRevision must be a non-negative integer");
  }

  return value;
}

function createCorruptBackupPath(filePath: string, now: Date, randomId: string): string {
  const timestamp = now.toISOString().replace(/[:]/g, "-");
  return `${filePath}.corrupt.${timestamp}.${randomId}`;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
}
