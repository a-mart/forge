export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeManagerId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("managerId is required");
  }

  if (/[/\\\x00]/.test(trimmed)) {
    throw new Error(`managerId contains invalid characters: "${trimmed}"`);
  }

  return trimmed;
}
