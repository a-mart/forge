const SUPPORTED_LEGACY_REWRITE: Record<string, string> = {
  "@mariozechner/pi-ai": "@earendil-works/pi-ai/compat",
  "@mariozechner/pi-ai/compat": "@earendil-works/pi-ai/compat",
  "@mariozechner/pi-ai/oauth": "@earendil-works/pi-ai/oauth",
  "@mariozechner/pi-coding-agent": "@earendil-works/pi-coding-agent",
  "@mariozechner/pi-agent-core": "@earendil-works/pi-agent-core",
  "@mariozechner/pi-tui": "@earendil-works/pi-tui",
};

const LEGACY_SPECIFIER_PATTERN = /@mariozechner\/pi-(?:ai|coding-agent|agent-core|tui)(?:\/[A-Za-z0-9._/-]+)?/g;

/**
 * Upstream jiti aliases rewrite `@mariozechner/pi-ai/<unsupported>` onto the
 * `@earendil-works/pi-ai` compat entry before Node resolves. The resulting
 * ERR_MODULE_NOT_FOUND then cites a filesystem path like
 * `.../pi-ai/dist/compat.js/private-subpath` instead of the original specifier.
 */
const ALIASED_UNSUPPORTED_PATH_PATTERNS: Array<{ pattern: RegExp; specifier: string }> = [
  {
    pattern: /(?:@earendil-works\/)?pi-ai(?:\/dist)?\/compat\.js\/private-subpath|pi-ai\/private-subpath/i,
    specifier: "@mariozechner/pi-ai/private-subpath",
  },
];

/**
 * Rewrite path-specific Pi extension module-not-found errors into migration guidance.
 * Forge does not ship @mariozechner/pi-* shims.
 */
export function diagnosePiExtensionModuleNotFound(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const causeMessage =
    error && typeof error === "object" && "cause" in error && (error as { cause?: unknown }).cause instanceof Error
      ? (error as { cause: Error }).cause.message
      : "";
  const combinedMessage = [message, causeMessage].filter(Boolean).join("\n");
  const looksMissing =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (?:package|module)/i.test(combinedMessage) ||
    /ERR_MODULE_NOT_FOUND/.test(combinedMessage) ||
    /Failed to load extension:/i.test(combinedMessage);
  if (!looksMissing) return undefined;

  const matches: string[] = [...(combinedMessage.match(LEGACY_SPECIFIER_PATTERN) ?? [])];
  for (const { pattern, specifier } of ALIASED_UNSUPPORTED_PATH_PATTERNS) {
    if (pattern.test(combinedMessage)) {
      matches.push(specifier);
    }
  }
  if (matches.length === 0) return undefined;

  const unique = [...new Set(matches)];
  const lines = unique.map((specifier) => {
    const replacement = SUPPORTED_LEGACY_REWRITE[specifier];
    if (replacement) {
      return `Legacy Pi extension import ${specifier} must be rewritten to ${replacement}. Forge does not ship @mariozechner/pi-* shims. Run: pnpm pi-extension:migrate -- --write <extension-dir>`;
    }
    return `Unsupported legacy Pi extension import ${specifier}. Migrate to an explicit @earendil-works/* public export. Forge does not ship shims. Run: pnpm pi-extension:migrate -- <extension-dir>`;
  });
  return lines.join("\n");
}

export function formatPiExtensionLoadError(error: unknown, fallbackMessage: string): string {
  return diagnosePiExtensionModuleNotFound(error) ?? fallbackMessage;
}
