import { CODEX_SIDECAR_AGENT_ID_SUFFIX } from "./types.js";

export function buildCodexSidecarAgentId(managerAgentId: string): string {
  return `${managerAgentId}${CODEX_SIDECAR_AGENT_ID_SUFFIX}`;
}

export function parseThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseThreadIdFromThreadResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const thread = (result as { thread?: { id?: unknown } }).thread;
  return parseThreadId(thread?.id);
}

export function parseTurnIdFromTurnResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const turn = (result as { turn?: { id?: unknown } }).turn;
  return parseThreadId(turn?.id);
}

export function parseTurnIdFromNotificationParams(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const record = params as {
    turn?: { id?: unknown };
    turnId?: unknown;
    item?: { turnId?: unknown };
  };

  const fromTurn = parseThreadId(record.turn?.id);
  if (fromTurn) {
    return fromTurn;
  }

  const fromTurnId = parseThreadId(record.turnId);
  if (fromTurnId) {
    return fromTurnId;
  }

  return parseThreadId(record.item?.turnId);
}

export function sanitizeCodexStderrLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [redacted]")
    .slice(0, 500);
}
