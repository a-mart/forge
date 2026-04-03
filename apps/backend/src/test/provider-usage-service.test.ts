import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function makeHistoryFilePath(): string {
  return join(tmpdir(), `provider-usage-history-${randomUUID()}.jsonl`);
}

function makeCacheFilePath(): string {
  return join(tmpdir(), `provider-usage-cache-${randomUUID()}.json`);
}

function buildCompleteWeeklyHistoryLines(
  resetTimesMs: number[],
  accountKey: string,
  windowSeconds: number
): string[] {
  const sampleOffsetsMs = [
    1 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    2 * 24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
    4 * 24 * 60 * 60 * 1000,
    (6 * 24 * 60 * 60 * 1000) + (20 * 60 * 60 * 1000)
  ];

  return resetTimesMs.flatMap((resetAtMs, weekIndex) => {
    const windowStartMs = resetAtMs - (windowSeconds * 1000);
    return sampleOffsetsMs.map((offsetMs, sampleIndex) => JSON.stringify({
      v: 1,
      provider: "openai",
      windowKind: "weekly",
      accountKey,
      sampledAtMs: windowStartMs + offsetMs,
      percent: Math.min(100, 8 + weekIndex + (sampleIndex * 14)),
      resetAtMs,
      windowSeconds
    }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ProviderUsageService", () => {
  it("preserves cached good data on failed refresh attempts", async () => {
    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    service.setCached("openai", {
      provider: "openai",
      available: true,
      plan: "Plus"
    }, 1_000);

    service.recordFailedAttempt("openai", 5_000);

    expect(service.cache.openai).toEqual({
      data: {
        provider: "openai",
        available: true,
        plan: "Plus"
      },
      fetchedAtMs: 1_000,
      lastAttemptMs: 5_000
    });
  });

  it("stores unavailable data when no good cache exists", async () => {
    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    service.recordFailedAttempt("anthropic", 8_000);

    expect(service.cache.anthropic).toEqual({
      data: {
        provider: "anthropic",
        available: false
      },
      fetchedAtMs: 8_000,
      lastAttemptMs: 8_000
    });
  });

  it("loads last-known-good data from disk and keeps it through a failed cold-start refresh", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    let nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    let openAiFetchMode: "success" | "failure" = "success";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.includes("chatgpt.com/backend-api/wham/usage")) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      if (openAiFetchMode === "failure") {
        return new Response("temporary outage", { status: 502 });
      }

      return new Response(JSON.stringify({
        email: "adam@example.com",
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 20,
            reset_at: Math.floor((nowMs + 20 * 60 * 1000) / 1000)
          },
          secondary_window: {
            used_percent: 15,
            reset_at: Math.floor((nowMs + (5 * 24 * 60 + 30) * 60 * 1000) / 1000)
          }
        }
      }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const cacheFilePath = makeCacheFilePath();
    const firstService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    vi.spyOn(firstService, "readOpenAIAuth").mockResolvedValue({
      tokens: {
        access_token: "openai-token",
        account_id: "acct-123"
      }
    });
    vi.spyOn(firstService, "readAnthropicAuth").mockResolvedValue(null);

    const firstSnapshot = await firstService.getSnapshot();
    await firstService.persistQueue;

    expect(firstSnapshot.openai).toMatchObject({
      provider: "openai",
      accountEmail: "adam@example.com",
      plan: "pro",
      available: true
    });

    openAiFetchMode = "failure";
    nowMs += 4 * 60 * 1000;

    const secondService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;
    vi.spyOn(secondService, "readOpenAIAuth").mockResolvedValue({
      tokens: {
        access_token: "openai-token",
        account_id: "acct-123"
      }
    });
    vi.spyOn(secondService, "readAnthropicAuth").mockResolvedValue(null);

    const secondSnapshot = await secondService.getSnapshot();

    expect(secondSnapshot.openai).toMatchObject({
      provider: "openai",
      accountEmail: "adam@example.com",
      plan: "pro",
      available: true
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates persisted snapshots when auth is definitively expired", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    let nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const cacheFilePath = makeCacheFilePath();
    const firstService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    firstService.setCached("anthropic", {
      provider: "anthropic",
      available: true,
      sessionUsage: {
        percent: 40,
        resetInfo: "1.5h",
        resetAtMs: nowMs + 90 * 60 * 1000,
        windowSeconds: 5 * 60 * 60
      }
    }, nowMs);
    await firstService.persistQueue;

    nowMs += 4 * 60 * 1000;

    const secondService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;
    vi.spyOn(secondService, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(secondService, "readAnthropicAuth").mockResolvedValue({
      anthropic: {
        access: "anthropic-token",
        expires: nowMs - 1
      }
    });

    const snapshot = await secondService.getSnapshot();

    expect(snapshot.anthropic).toEqual({
      provider: "anthropic",
      available: false
    });
  });

  it("maps current OpenAI and Anthropic usage payloads into sidebar-ready usage windows", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("chatgpt.com/backend-api/wham/usage")) {
        return new Response(JSON.stringify({
          email: "adam@example.com",
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: Math.floor((nowMs + 20 * 60 * 1000) / 1000)
            },
            secondary_window: {
              used_percent: 15,
              reset_at: Math.floor((nowMs + (5 * 24 * 60 + 30) * 60 * 1000) / 1000)
            }
          }
        }), { status: 200 });
      }

      if (url.includes("api.anthropic.com/api/oauth/usage")) {
        return new Response(JSON.stringify({
          five_hour: {
            utilization: 40,
            resets_at: "2026-04-01T01:30:00.000Z"
          },
          seven_day: {
            utilization: 94,
            resets_at: "2026-04-03T03:00:00.000Z"
          }
        }), { status: 200 });
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue({
      tokens: {
        access_token: "openai-token",
        account_id: "acct-123"
      }
    });
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue({
      anthropic: {
        access: "anthropic-token",
        expires: nowMs + 60_000
      }
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.openai).toMatchObject({
      provider: "openai",
      accountEmail: "adam@example.com",
      plan: "pro",
      available: true,
      sessionUsage: {
        percent: 20,
        resetInfo: "20m"
      },
      weeklyUsage: {
        percent: 15,
        resetInfo: "5.0d"
      }
    });
    expect(snapshot.anthropic).toMatchObject({
      provider: "anthropic",
      available: true,
      sessionUsage: {
        percent: 40,
        resetInfo: "1.5h"
      },
      weeklyUsage: {
        percent: 94,
        resetInfo: "2.1d"
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps 07:45 and 07:46 weekly resets as separate historical weeks", async () => {
    const historyFilePath = makeHistoryFilePath();
    const windowSeconds = 7 * 24 * 60 * 60;
    const accountKey = "test-account";
    const resetTimesMs = [
      Date.parse("2026-03-11T07:45:00.000Z"),
      Date.parse("2026-03-11T07:46:00.000Z"),
      Date.parse("2026-03-18T07:45:00.000Z"),
      Date.parse("2026-03-18T07:46:00.000Z"),
      Date.parse("2026-03-25T07:45:00.000Z"),
      Date.parse("2026-03-25T07:46:00.000Z"),
      Date.parse("2026-04-01T07:45:00.000Z"),
      Date.parse("2026-04-01T07:46:00.000Z")
    ];

    await writeFile(
      historyFilePath,
      `${buildCompleteWeeklyHistoryLines(resetTimesMs, accountKey, windowSeconds).join("\n")}\n`,
      "utf8"
    );

    const {
      ProviderUsageHistoryStore,
      evaluateHistoricalProviderUsagePace
    } = await import("../stats/provider-usage-history.js");

    const store = new ProviderUsageHistoryStore(historyFilePath);
    const dataset = await store.loadDataset("openai", accountKey);

    expect(dataset?.weeks).toHaveLength(8);

    const currentResetAtMs = Date.parse("2026-04-08T07:46:00.000Z");
    const nowMs = currentResetAtMs - (2 * 24 * 60 * 60 * 1000);
    const pace = evaluateHistoricalProviderUsagePace({
      percent: 58,
      resetInfo: "2.0d",
      resetAtMs: currentResetAtMs,
      windowSeconds
    }, nowMs, dataset);

    expect(pace).toBeDefined();
    expect(pace?.mode).toBe("historical");
  });

  it("uses the seven-day fallback window and suppresses pace during the first 3 percent of a week", async () => {
    const historyFilePath = makeHistoryFilePath();
    const windowSeconds = 7 * 24 * 60 * 60;
    const accountKey = "test-account";
    const resetTimesMs = [
      Date.parse("2026-03-11T07:46:00.000Z"),
      Date.parse("2026-03-18T07:46:00.000Z"),
      Date.parse("2026-03-25T07:46:00.000Z")
    ];

    await writeFile(
      historyFilePath,
      `${buildCompleteWeeklyHistoryLines(resetTimesMs, accountKey, windowSeconds).join("\n")}\n`,
      "utf8"
    );

    const {
      ProviderUsageHistoryStore,
      evaluateHistoricalProviderUsagePace
    } = await import("../stats/provider-usage-history.js");

    const store = new ProviderUsageHistoryStore(historyFilePath);
    const dataset = await store.loadDataset("openai", accountKey);
    const currentResetAtMs = Date.parse("2026-04-01T07:46:00.000Z");

    const midweekNowMs = currentResetAtMs - (2 * 24 * 60 * 60 * 1000);
    const midweekPace = evaluateHistoricalProviderUsagePace({
      percent: 58,
      resetInfo: "2.0d",
      resetAtMs: currentResetAtMs
    }, midweekNowMs, dataset);

    expect(midweekPace).toBeDefined();
    expect(midweekPace?.mode).toBe("historical");

    const earlyNowMs = currentResetAtMs - windowSeconds * 1000 + (2 * 60 * 60 * 1000);
    const earlyPace = evaluateHistoricalProviderUsagePace({
      percent: 1,
      resetInfo: "6.9d",
      resetAtMs: currentResetAtMs
    }, earlyNowMs, dataset);

    expect(earlyPace).toBeUndefined();
  });
});
