interface RateLimitBucket {
  windowStartMs: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  check(key: string, limitPerMinute: number, nowMs: number): RateLimitResult {
    const normalizedKey = key.trim() || "unknown";
    const windowStartMs = Math.floor(nowMs / 60_000) * 60_000;
    const existing = this.buckets.get(normalizedKey);

    if (!existing || existing.windowStartMs !== windowStartMs) {
      this.buckets.set(normalizedKey, { windowStartMs, count: 1 });
      this.cleanupOldBuckets(windowStartMs);
      return { allowed: true };
    }

    if (existing.count >= limitPerMinute) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowStartMs + 60_000 - nowMs) / 1000))
      };
    }

    existing.count += 1;
    return { allowed: true };
  }

  private cleanupOldBuckets(currentWindowStartMs: number): void {
    const oldestWindowStartMs = currentWindowStartMs - 5 * 60_000;
    for (const [key, bucket] of this.buckets.entries()) {
      if (bucket.windowStartMs < oldestWindowStartMs) {
        this.buckets.delete(key);
      }
    }
  }
}

export function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")?.split(",", 1)[0]?.trim()
    ?? "unknown";
}
