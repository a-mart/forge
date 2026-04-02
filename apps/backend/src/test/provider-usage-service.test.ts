import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("ProviderUsageService", () => {
  it("preserves cached good data on failed refresh attempts", async () => {
    const { ProviderUsageService } = await import("../stats/provider-usage-service.js");
    const service = new ProviderUsageService("/tmp/shared-auth.json") as any;

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
    const service = new ProviderUsageService("/tmp/shared-auth.json") as any;

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
    const service = new ProviderUsageService("/tmp/shared-auth.json") as any;

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
        resetInfo: "120.5h"
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
        resetInfo: "51.0h"
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
