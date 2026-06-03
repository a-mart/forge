const TOKEN_LIKE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi,
  /sk-[A-Za-z0-9._~+\-/]{12,}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

export function redactOpenAIAuthBrokerText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return TOKEN_LIKE_PATTERNS.reduce((text, pattern) => text.replace(pattern, "[redacted]"), raw);
}

export function maskOpenAIAuthBrokerSecret(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }

  const suffix = trimmed.slice(-4);
  return `********${suffix}`;
}
