export const MANAGER_OUTPUT_HARD_LIMIT_CHARS = 128 * 1024;
export const MANAGER_OUTPUT_REPETITION_MIN_CHARS = 16 * 1024;

const MANAGER_OUTPUT_REPETITION_WINDOW_CHARS = 32 * 1024;
const MANAGER_OUTPUT_REPETITION_MIN_LINES = 256;
const MANAGER_OUTPUT_REPETITION_MAX_UNIQUE_RATIO = 0.06;
const MANAGER_OUTPUT_REPETITION_MIN_IDENTICAL_LINES = 64;

export type ManagerOutputRunawayReason = "hard_limit" | "repetitive_output";

export interface ManagerOutputRunawayDetection {
  reason: ManagerOutputRunawayReason;
  observedChars: number;
}

/**
 * Detects provider output that cannot be a useful Forge manager reply anymore.
 *
 * The hard limit is intentionally generous. The lower repetition threshold
 * catches termination-token loops (for example Done/Stop/End repeated across
 * thousands of lines) without imposing a normal response-length budget.
 */
export function detectManagerOutputRunaway(text: string): ManagerOutputRunawayDetection | undefined {
  if (text.length >= MANAGER_OUTPUT_HARD_LIMIT_CHARS) {
    return {
      reason: "hard_limit",
      observedChars: text.length,
    };
  }

  if (text.length < MANAGER_OUTPUT_REPETITION_MIN_CHARS) {
    return undefined;
  }

  const window = text.slice(-MANAGER_OUTPUT_REPETITION_WINDOW_CHARS);
  const normalizedLines = window
    .split(/\r?\n/u)
    .map(normalizeRepeatedLine)
    .filter((line): line is string => line !== undefined);
  if (normalizedLines.length < MANAGER_OUTPUT_REPETITION_MIN_LINES) {
    return undefined;
  }

  const lineCounts = new Map<string, number>();
  let mostFrequentLineCount = 0;
  for (const line of normalizedLines) {
    const nextCount = (lineCounts.get(line) ?? 0) + 1;
    lineCounts.set(line, nextCount);
    mostFrequentLineCount = Math.max(mostFrequentLineCount, nextCount);
  }

  const uniqueRatio = lineCounts.size / normalizedLines.length;
  if (
    uniqueRatio <= MANAGER_OUTPUT_REPETITION_MAX_UNIQUE_RATIO &&
    mostFrequentLineCount >= MANAGER_OUTPUT_REPETITION_MIN_IDENTICAL_LINES
  ) {
    return {
      reason: "repetitive_output",
      observedChars: text.length,
    };
  }

  return undefined;
}

function normalizeRepeatedLine(line: string): string | undefined {
  const normalized = line.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, 256);
}
