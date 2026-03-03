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
