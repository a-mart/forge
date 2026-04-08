import { SessionManager } from "@mariozechner/pi-coding-agent";
import { statSync, writeFileSync } from "node:fs";
import { renameSyncWithRetry } from "../retry-rename.js";

export const MAX_SESSION_FILE_BYTES_FOR_OPEN = 256 * 1024 * 1024;

interface OpenSessionManagerWithSizeGuardOptions {
  maxSizeBytes?: number;
  rotateOversizedFile?: boolean;
  context?: string;
  logWarning?: (message: string, details?: Record<string, unknown>) => void;
}

export function openSessionManagerWithSizeGuard(
  sessionFile: string,
  options: OpenSessionManagerWithSizeGuardOptions = {}
): SessionManager | undefined {
  const canOpen = guardSessionFileForOpen(sessionFile, options);
  if (!canOpen) {
    return undefined;
  }

  try {
    return SessionManager.open(sessionFile);
  } catch (error) {
    warn(options, "session:file:open:error", {
      sessionFile,
      context: options.context,
      message: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function guardSessionFileForOpen(
  sessionFile: string,
  options: OpenSessionManagerWithSizeGuardOptions
): boolean {
  const maxSizeBytes = normalizeMaxSizeBytes(options.maxSizeBytes);

  let sizeBytes: number;
  try {
    sizeBytes = statSync(sessionFile).size;
  } catch (error) {
    if (isEnoentError(error)) {
      return true;
    }

    warn(options, "session:file:stat:error", {
      sessionFile,
      context: options.context,
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }

  if (sizeBytes <= maxSizeBytes) {
    return true;
  }

  warn(options, "session:file:oversized", {
    sessionFile,
    context: options.context,
    sizeBytes,
    maxSizeBytes,
    action: options.rotateOversizedFile ? "rotate" : "skip"
  });

  if (!options.rotateOversizedFile) {
    return false;
  }

  const backupFile = buildOversizedBackupPath(sessionFile);

  try {
    renameSyncWithRetry(sessionFile, backupFile, {
      retries: 5
    });
    writeFileSync(sessionFile, "", "utf8");

    warn(options, "session:file:oversized:rotated", {
      sessionFile,
      backupFile,
      context: options.context,
      previousSizeBytes: sizeBytes
    });

    return true;
  } catch (error) {
    warn(options, "session:file:oversized:rotate_error", {
      sessionFile,
      backupFile,
      context: options.context,
      message: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function normalizeMaxSizeBytes(maxSizeBytes: number | undefined): number {
  if (typeof maxSizeBytes !== "number" || !Number.isFinite(maxSizeBytes) || maxSizeBytes <= 0) {
    return MAX_SESSION_FILE_BYTES_FOR_OPEN;
  }

  return Math.floor(maxSizeBytes);
}

function buildOversizedBackupPath(sessionFile: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(16).slice(2, 10);
  return `${sessionFile}.oversize-${timestamp}-${suffix}.bak`;
}

function warn(
  options: OpenSessionManagerWithSizeGuardOptions,
  message: string,
  details?: Record<string, unknown>
): void {
  if (options.logWarning) {
    options.logWarning(message, details);
    return;
  }

  if (details) {
    console.warn(`[swarm] ${message}`, details);
    return;
  }

  console.warn(`[swarm] ${message}`);
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
