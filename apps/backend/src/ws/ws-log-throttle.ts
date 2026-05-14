const DEFAULT_WS_LOG_THROTTLE_MS = 30_000;

interface ThrottledWarnState {
  lastLoggedAtMs: number;
  suppressedCount: number;
}

const throttledWarns = new Map<string, ThrottledWarnState>();

export function warnWsThrottled(
  key: string,
  message: string,
  details: Record<string, unknown>,
  options?: { throttleMs?: number; nowMs?: number },
): void {
  const throttleMs = options?.throttleMs ?? DEFAULT_WS_LOG_THROTTLE_MS;
  const nowMs = options?.nowMs ?? Date.now();
  const state = throttledWarns.get(key);

  if (state && nowMs - state.lastLoggedAtMs < throttleMs) {
    state.suppressedCount += 1;
    return;
  }

  const suppressedCount = state?.suppressedCount ?? 0;
  throttledWarns.set(key, {
    lastLoggedAtMs: nowMs,
    suppressedCount: 0,
  });

  console.warn(
    message,
    suppressedCount > 0
      ? {
          ...details,
          suppressedCount,
        }
      : details,
  );
}

export function resetWsLogThrottleForTest(): void {
  throttledWarns.clear();
}
