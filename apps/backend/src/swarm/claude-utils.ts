import { isEnoentError } from "../utils/fs-errors.js";
import type { AgentContextUsage } from "./types.js";

export { isEnoentError };

const MAX_REASONABLE_CONTEXT_USAGE_MULTIPLIER = 5;

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function isPlausibleContextUsage(usage: AgentContextUsage | undefined): usage is AgentContextUsage {
  if (!usage) {
    return false;
  }

  return (
    Number.isFinite(usage.tokens)
    && usage.tokens >= 0
    && Number.isFinite(usage.contextWindow)
    && usage.contextWindow > 0
    && usage.tokens <= usage.contextWindow * MAX_REASONABLE_CONTEXT_USAGE_MULTIPLIER
    && Number.isFinite(usage.percent)
    && usage.percent >= 0
    && usage.percent <= 100
  );
}
