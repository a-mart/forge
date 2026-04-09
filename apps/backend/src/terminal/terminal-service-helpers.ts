import { timingSafeEqual } from "node:crypto";
import type { TerminalDescriptor, TerminalMeta } from "@forge/protocol";
import type { ResolvedTerminalSession } from "./terminal-session-resolver.js";
import { TerminalServiceError, type ActiveTerminalRuntime } from "./terminal-service-types.js";

export function cloneDescriptor(descriptor: TerminalDescriptor): TerminalDescriptor {
  return { ...descriptor };
}

function descriptorFromMeta(meta: TerminalMeta): TerminalDescriptor {
  return {
    terminalId: meta.terminalId,
    sessionAgentId: meta.sessionAgentId,
    profileId: meta.profileId,
    name: meta.name,
    shell: meta.shell,
    cwd: meta.cwd,
    cols: meta.cols,
    rows: meta.rows,
    state: meta.state,
    pid: meta.pid,
    exitCode: meta.exitCode,
    exitSignal: meta.exitSignal,
    recoveredFromPersistence: meta.recoveredFromPersistence,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function createInactiveRuntime(
  meta: TerminalMeta,
  session: ResolvedTerminalSession,
): ActiveTerminalRuntime {
  return {
    meta,
    descriptor: descriptorFromMeta(meta),
    session,
    pty: null,
    closing: false,
    closed: false,
    finalizePromise: null,
    snapshotInterval: null,
    lock: Promise.resolve(),
    attachedClients: new Set(),
    journalBytes: 0,
  };
}

export function sanitizeDimension(value: number, minimum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > 1000) {
    throw new TerminalServiceError("INVALID_DIMENSIONS", `Invalid ${label}: ${value}`);
  }
  return value;
}

export function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function toErrorMessage(error: unknown): string {
  return toError(error).message;
}
