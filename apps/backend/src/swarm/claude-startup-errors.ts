export const CLAUDE_SDK_AUTH_USER_MESSAGE = [
  "Claude SDK authentication not configured. To use Claude SDK models, open a terminal and run:",
  "",
  "  claude login",
  "",
  "This will authenticate via your browser. Once complete, Claude SDK models will work automatically.",
  "",
  'Alternatively, use the standard "anthropic" provider models which use Pi-based authentication.'
].join("\n");

export function buildClaudeSdkStartupTimeoutUserMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));

  return [
    `Claude SDK failed to start within ${seconds} second${seconds === 1 ? "" : "s"}.`,
    "",
    "If Claude Code is not authenticated yet, open a terminal and run:",
    "",
    "  claude login",
    "",
    "This will authenticate via your browser. Once complete, Claude SDK models will work automatically.",
    "",
    'Alternatively, use the standard "anthropic" provider models which use Pi-based authentication.'
  ].join("\n");
}

export interface ClaudeSdkStartupFailurePresentation {
  technicalMessage: string;
  userFacingMessage?: string;
  isAuthFailure: boolean;
  isStartupTimeout: boolean;
}

const CLAUDE_SDK_AUTH_FAILURE_PATTERNS = [
  /\bauth(?:entication|orization)?\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\b401\b/i,
  /\b403\b/i,
  /\blog(?:in|ged\s+in)?\b/i,
  /\bcredential(?:s)?\b/i,
  /\boauth\b/i,
  /claude[_\s-]*auth/i,
  /could not resolve authentication method/i,
  /not authenticated/i,
  /not logged in/i
];

export function presentClaudeSdkStartupFailure(input: {
  error: unknown;
  stderrLines?: readonly string[];
  timeoutMs?: number;
}): ClaudeSdkStartupFailurePresentation {
  const technicalMessage = toErrorMessage(input.error);
  const timeoutMs =
    typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
      ? Math.round(input.timeoutMs)
      : 30_000;
  const stderrSummary = summarizeClaudeStderr(input.stderrLines ?? []);
  const combined = `${technicalMessage}\n${stderrSummary}`.trim();
  const isStartupTimeout = /claude_startup timed out after \d+ms/i.test(technicalMessage);
  const isAuthFailure = isClaudeSdkAuthFailure(combined);

  if (isAuthFailure) {
    return {
      technicalMessage,
      userFacingMessage: CLAUDE_SDK_AUTH_USER_MESSAGE,
      isAuthFailure: true,
      isStartupTimeout
    };
  }

  if (isStartupTimeout) {
    return {
      technicalMessage,
      userFacingMessage: buildClaudeSdkStartupTimeoutUserMessage(timeoutMs),
      isAuthFailure: false,
      isStartupTimeout: true
    };
  }

  return {
    technicalMessage,
    isAuthFailure: false,
    isStartupTimeout: false
  };
}

function isClaudeSdkAuthFailure(message: string): boolean {
  const normalized = message.trim();
  if (!normalized) {
    return false;
  }

  return CLAUDE_SDK_AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function summarizeClaudeStderr(stderrLines: readonly string[]): string {
  return stderrLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join("\n");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
