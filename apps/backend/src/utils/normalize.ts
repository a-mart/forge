export function normalizeManagerId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("managerId is required");
  }

  return trimmed;
}
