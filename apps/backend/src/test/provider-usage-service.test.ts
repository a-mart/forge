import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

    service.cache.openai = [{
      data: { provider: "openai", available: true, plan: "Plus" },
      fetchedAtMs: 1_000,
      lastAttemptMs: 1_000
    }];

    service.recordOpenAIFailedAttempt(5_000);

    expect(service.cache.openai).toEqual([{
      data: {
        provider: "openai",
        available: true,
        plan: "Plus"
      },
      fetchedAtMs: 1_000,
      lastAttemptMs: 5_000
    }]);
  });

  it("stores unavailable anthropic data as an array when no good cache exists", async () => {
    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    service.recordFailedAttempt("anthropic", 8_000);

    expect(service.cache.anthropic).toEqual([{
      data: {
        provider: "anthropic",
        available: false
      },
      fetchedAtMs: 8_000,
      lastAttemptMs: 8_000
    }]);
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

    expect(firstSnapshot.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          accountEmail: "adam@example.com",
          plan: "pro",
          available: true
        })
      ])
    );

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

    expect(secondSnapshot.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          accountEmail: "adam@example.com",
          plan: "pro",
          available: true
        })
      ])
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates persisted anthropic snapshots when auth is definitively expired", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    let nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const cacheFilePath = makeCacheFilePath();
    const firstService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    firstService.setCached("anthropic", [{
      provider: "anthropic",
      available: true,
      sessionUsage: {
        percent: 40,
        resetInfo: "1.5h",
        resetAtMs: nowMs + 90 * 60 * 1000,
        windowSeconds: 5 * 60 * 60
      }
    }], nowMs);
    await firstService.persistQueue;

    nowMs += 4 * 60 * 1000;

    const secondService = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;
    vi.spyOn(secondService, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(secondService, "readAnthropicAuth").mockResolvedValue({
      type: "oauth",
      access: "anthropic-token",
      expires: nowMs - 1
    });

    const snapshot = await secondService.getSnapshot();

    expect(snapshot.anthropic).toEqual([{
      provider: "anthropic",
      available: false
    }]);
  });

  it("clears persisted provider cache entries when explicitly invalidated", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const cacheFilePath = makeCacheFilePath();
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    service.cache.openai = [{
      data: { provider: "openai", available: true, plan: "pro" },
      fetchedAtMs: 1_000,
      lastAttemptMs: 1_000,
    }];
    await service.invalidateProvider("openai");
    await service.persistQueue;

    expect(service.cache.openai).toBeUndefined();
    const persisted = JSON.parse(await readFile(cacheFilePath, "utf8"));
    expect(persisted.entries.openai).toBeUndefined();
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
      type: "oauth",
      access: "anthropic-token",
      expires: nowMs + 60_000
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.openai).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "openai",
          accountEmail: "adam@example.com",
          plan: "pro",
          available: true,
          sessionUsage: expect.objectContaining({
            percent: 20,
            resetInfo: "20m"
          }),
          weeklyUsage: expect.objectContaining({
            percent: 15,
            resetInfo: "5.0d"
          })
        })
      ])
    );
    expect(snapshot.anthropic).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        available: true,
        sessionUsage: {
          percent: 40,
          resetInfo: "1.5h",
          resetAtMs: Date.parse("2026-04-01T01:30:00.000Z"),
          windowSeconds: 5 * 60 * 60
        },
        weeklyUsage: {
          percent: 94,
          resetInfo: "2.1d",
          resetAtMs: Date.parse("2026-04-03T03:00:00.000Z"),
          windowSeconds: 7 * 24 * 60 * 60
        }
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetches pooled anthropic usage for multiple accounts and keys history by credential id", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const historyFilePath = makeHistoryFilePath();
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const authHeader = headers?.Authorization;
      if (authHeader === "Bearer anthropic-token-1") {
        return new Response(JSON.stringify({
          five_hour: {
            utilization: 25,
            resets_at: "2026-04-01T02:00:00.000Z"
          },
          seven_day: {
            utilization: 61,
            resets_at: "2026-04-06T00:00:00.000Z"
          }
        }), { status: 200 });
      }

      if (authHeader === "Bearer anthropic-token-2") {
        return new Response(JSON.stringify({
          five_hour: {
            utilization: 55,
            resets_at: "2026-04-01T03:00:00.000Z"
          },
          seven_day: {
            utilization: 72,
            resets_at: "2026-04-07T00:00:00.000Z"
          }
        }), { status: 200 });
      }

      throw new Error(`Unexpected authorization header: ${String(authHeader)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", historyFilePath) as any;
    const pool = {
      listPool: vi.fn(async (provider: string) => {
        if (provider === "anthropic") {
          return {
            strategy: "fill_first",
            credentials: [
              { id: "cred_a", label: "Anthropic A", isPrimary: true, health: "healthy", requestCount: 0, createdAt: "2026-04-01T00:00:00.000Z" },
              { id: "cred_b", label: "Anthropic B", isPrimary: false, health: "healthy", requestCount: 0, createdAt: "2026-04-01T00:00:00.000Z" }
            ]
          };
        }

        return { strategy: "fill_first", credentials: [] };
      }),
      buildRuntimeAuthData: vi.fn(async (provider: string, credentialId: string) => {
        if (provider !== "anthropic") {
          throw new Error(`Unexpected provider: ${provider}`);
        }

        return {
          anthropic: {
            type: "oauth",
            access: credentialId === "cred_a" ? "anthropic-token-1" : "anthropic-token-2",
            refresh: `refresh-${credentialId}`,
            expires: nowMs + 60_000
          }
        };
      })
    };

    service.setCredentialPoolGetter(() => pool as any);
    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    const readAnthropicAuthSpy = vi.spyOn(service, "readAnthropicAuth").mockResolvedValue(null);

    const snapshot = await service.getSnapshot();

    expect(snapshot.anthropic).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        accountId: "cred_a",
        accountLabel: "Anthropic A",
        available: true,
        sessionUsage: expect.objectContaining({ percent: 25 }),
        weeklyUsage: expect.objectContaining({ percent: 61 })
      }),
      expect.objectContaining({
        provider: "anthropic",
        accountId: "cred_b",
        accountLabel: "Anthropic B",
        available: true,
        sessionUsage: expect.objectContaining({ percent: 55 }),
        weeklyUsage: expect.objectContaining({ percent: 72 })
      })
    ]);
    expect(pool.listPool).toHaveBeenCalledWith("anthropic");
    expect(pool.buildRuntimeAuthData).toHaveBeenCalledTimes(2);
    expect(readAnthropicAuthSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const historyLines = (await readFile(historyFilePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { accountKey?: string });
    const distinctAccountKeys = new Set(historyLines.map(line => line.accountKey).filter(Boolean));
    expect(distinctAccountKeys.size).toBe(2);
  });

  it("falls back to single-account anthropic auth when only one pooled credential exists", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string> | undefined;
      if (!url.includes("api.anthropic.com/api/oauth/usage")) {
        throw new Error(`Unexpected fetch URL: ${url}`);
      }

      expect(headers?.Authorization).toBe("Bearer shared-auth-token");
      return new Response(JSON.stringify({
        five_hour: {
          utilization: 33,
          resets_at: "2026-04-01T01:00:00.000Z"
        },
        seven_day: {
          utilization: 66,
          resets_at: "2026-04-05T00:00:00.000Z"
        }
      }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;
    const pool = {
      listPool: vi.fn(async (provider: string) => {
        if (provider === "anthropic") {
          return {
            strategy: "fill_first",
            credentials: [
              { id: "cred_only", label: "Only Account", isPrimary: true, health: "healthy", requestCount: 0, createdAt: "2026-04-01T00:00:00.000Z" }
            ]
          };
        }

        return { strategy: "fill_first", credentials: [] };
      }),
      buildRuntimeAuthData: vi.fn()
    };

    service.setCredentialPoolGetter(() => pool as any);
    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    const readAnthropicAuthSpy = vi.spyOn(service, "readAnthropicAuth").mockResolvedValue({
      type: "oauth",
      access: "shared-auth-token",
      expires: nowMs + 60_000
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.anthropic).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        available: true,
        sessionUsage: expect.objectContaining({ percent: 33 }),
        weeklyUsage: expect.objectContaining({ percent: 66 })
      })
    ]);
    expect(pool.listPool).toHaveBeenCalledWith("anthropic");
    expect(pool.buildRuntimeAuthData).not.toHaveBeenCalled();
    expect(readAnthropicAuthSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns Anthropic usage as unavailable without fetching for API-key auth", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue({
      type: "api_key",
      key: "sk-ant-api-key",
      access: "sk-ant-api-key"
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.anthropic).toEqual([{
      provider: "anthropic",
      available: false
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Anthropic usage"));
  });

  it("returns Anthropic usage as unavailable without fetching for malformed OAuth auth", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const fetchMock = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetchMock);

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath()) as any;

    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue({
      type: "oauth",
      refreshToken: "refresh-only-token"
    });

    const snapshot = await service.getSnapshot();

    expect(snapshot.anthropic).toEqual([{
      provider: "anthropic",
      available: false
    }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Anthropic usage"));
  });

  it("loads legacy v2 anthropic cache entries and rewrites them as v3 arrays", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VITEST", "");

    const nowMs = Date.parse("2026-04-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    const cacheFilePath = makeCacheFilePath();
    await writeFile(cacheFilePath, JSON.stringify({
      version: 2,
      entries: {
        anthropic: {
          data: {
            provider: "anthropic",
            available: true,
            accountId: "cred_legacy",
            accountLabel: "Legacy Account",
            sessionUsage: {
              percent: 42,
              resetInfo: "2.0h",
              resetAtMs: nowMs + 2 * 60 * 60 * 1000,
              windowSeconds: 5 * 60 * 60
            }
          },
          fetchedAtMs: nowMs - 60_000,
          lastAttemptMs: nowMs - 60_000
        }
      }
    }), "utf8");

    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json", makeHistoryFilePath(), cacheFilePath) as any;

    vi.spyOn(service, "readOpenAIAuth").mockResolvedValue(null);
    vi.spyOn(service, "readAnthropicAuth").mockResolvedValue(null);

    const snapshot = await service.getSnapshot();

    expect(snapshot.anthropic).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        available: true,
        accountId: "cred_legacy",
        accountLabel: "Legacy Account"
      })
    ]);

    service.setCached("anthropic", snapshot.anthropic, nowMs);
    await service.persistQueue;

    const persisted = JSON.parse(await readFile(cacheFilePath, "utf8")) as {
      version: number;
      entries: { anthropic?: unknown };
    };
    expect(persisted.version).toBe(3);
    expect(Array.isArray(persisted.entries.anthropic)).toBe(true);
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
