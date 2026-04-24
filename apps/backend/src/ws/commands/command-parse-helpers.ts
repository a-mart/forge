import type { ChoiceAnswer, ClientCommand, ManagerExactModelSelection } from "@forge/protocol";

export type ParsedClientCommand =
  | { ok: true; command: ClientCommand }
  | { ok: false; error: string };

export type ClientCommandCandidate = Partial<ClientCommand> & { type?: unknown };

export type CommandParser = (command: ClientCommandCandidate) => ParsedClientCommand | undefined;

export function ok(command: ClientCommand): ParsedClientCommand {
  return { ok: true, command };
}

export function fail(error: string): ParsedClientCommand {
  return { ok: false, error };
}

export function isApiProxyMethod(value: unknown): value is "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  return value === "GET" || value === "POST" || value === "PUT" || value === "PATCH" || value === "DELETE";
}

export function isSafeMessageCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  );
}

export function normalizeMessageCount(value: unknown): number | undefined {
  if (!isSafeMessageCount(value)) {
    return undefined;
  }

  return value;
}

export function parseManagerExactModelSelection(
  value: unknown,
  fieldPrefix: string,
): ManagerExactModelSelection | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${fieldPrefix} must be an object`;
  }

  const maybe = value as { provider?: unknown; modelId?: unknown };
  if (typeof maybe.provider !== "string" || maybe.provider.trim().length === 0) {
    return `${fieldPrefix}.provider must be a non-empty string`;
  }
  if (typeof maybe.modelId !== "string" || maybe.modelId.trim().length === 0) {
    return `${fieldPrefix}.modelId must be a non-empty string`;
  }

  return {
    provider: maybe.provider.trim(),
    modelId: maybe.modelId.trim(),
  };
}

export function isValidChoiceAnswer(value: unknown): value is ChoiceAnswer {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Record<string, unknown>;
  if (typeof maybe.questionId !== "string" || maybe.questionId.trim().length === 0) return false;
  if (!Array.isArray(maybe.selectedOptionIds)) return false;
  if (maybe.selectedOptionIds.some((id: unknown) => typeof id !== "string" || id.trim().length === 0)) return false;
  if (maybe.text !== undefined && typeof maybe.text !== "string") return false;
  return true;
}
