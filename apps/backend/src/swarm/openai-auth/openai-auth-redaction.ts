const TOKEN_LIKE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi,
  /sk-[A-Za-z0-9._~+\-/]{12,}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

export function redactOpenAIAuthBrokerText(value: unknown, exactSecrets: readonly (string | undefined)[] = []): string {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const exactRedacted = exactSecrets.reduce<string>((text, secret) => {
    const trimmed = typeof secret === "string" ? secret.trim() : "";
    return trimmed ? text.replaceAll(trimmed, "[redacted]") : text;
  }, raw);
  return TOKEN_LIKE_PATTERNS.reduce<string>((text, pattern) => text.replace(pattern, "[redacted]"), exactRedacted);
}

export function maskOpenAIAuthBrokerSecret(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return undefined;
  }

  const suffix = trimmed.slice(-4);
  return `********${suffix}`;
}
