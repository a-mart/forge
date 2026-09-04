import { describe, expect, it, vi } from "vitest";
import {
  mapXaiOAuthCreditsUsage,
  parseXaiOAuthCreditsUsage,
  parseXaiOAuthSettingsPlan,
  XAI_OAUTH_BILLING_ENDPOINT,
  XAI_OAUTH_SETTINGS_ENDPOINT,
  fetchXaiOAuthUsage,
} from "../stats/xai-oauth-usage.js";
import { getForgeAppVersion } from "../utils/app-version.js";

const WEEK_START = "2026-08-06T00:00:00.000Z";
const WEEK_END = "2026-08-13T00:00:00.000Z";

describe("xAI OAuth credits parser", () => {
  it("prefers creditUsagePercent and clamps 0..100", () => {
    const parsed = parseXaiOAuthCreditsUsage({
      config: {
        creditUsagePercent: 104.2,
        currentPeriod: { start: WEEK_START, end: WEEK_END },
        billingPeriodEnd: "2026-08-14T00:00:00.000Z",
        onDemandCap: { val: 1000 },
        onDemandUsed: { val: 10 },
      },
    });

    expect(parsed).toEqual({
      percent: 100,
      resetAtMs: Date.parse(WEEK_END),
      windowSeconds: 7 * 24 * 60 * 60,
    });
    expect(parseXaiOAuthCreditsUsage({
      config: { creditUsagePercent: -3.5 },
    })).toEqual({
      percent: 0,
      resetAtMs: null,
      windowSeconds: null,
    });
  });

  it("falls back to onDemandUsed/onDemandCap when percent is absent", () => {
    expect(parseXaiOAuthCreditsUsage({
      config: {
        onDemandCap: { val: 1000 },
        onDemandUsed: { val: 250.5 },
      },
    })).toEqual({
      percent: 25.05,
      resetAtMs: null,
      windowSeconds: null,
    });
  });

  it("keeps usage unknown when a period is present but no finite percent exists", () => {
    const parsed = parseXaiOAuthCreditsUsage({
      config: {
        currentPeriod: { start: WEEK_START, end: WEEK_END },
        billingPeriodEnd: "2026-08-14T00:00:00.000Z",
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
      },
    });

    expect(parsed).toEqual({
      percent: null,
      resetAtMs: Date.parse(WEEK_END),
      windowSeconds: 7 * 24 * 60 * 60,
    });
    expect(mapXaiOAuthCreditsUsage(parsed!)).toEqual({
      provider: "xai",
      available: true,
    });
  });

  it("uses currentPeriod.end then billingPeriodEnd and derives windowSeconds only from valid start/end", () => {
    expect(parseXaiOAuthCreditsUsage({
      config: {
        creditUsagePercent: 12.5,
        currentPeriod: { start: WEEK_START },
        billingPeriodEnd: WEEK_END,
      },
    })).toEqual({
      percent: 12.5,
      resetAtMs: Date.parse(WEEK_END),
      windowSeconds: null,
    });

    expect(parseXaiOAuthCreditsUsage({
      config: {
        creditUsagePercent: 8,
        currentPeriod: { start: WEEK_START, end: WEEK_END },
      },
    })).toEqual({
      percent: 8,
      resetAtMs: Date.parse(WEEK_END),
      windowSeconds: 7 * 24 * 60 * 60,
    });

    expect(parseXaiOAuthCreditsUsage({
      config: {
        creditUsagePercent: 8,
        currentPeriod: { start: WEEK_END, end: WEEK_START },
        billingPeriodEnd: "not-a-date",
      },
    })).toEqual({
      percent: 8,
      resetAtMs: Date.parse(WEEK_START),
      windowSeconds: null,
    });
  });

  it("rejects malformed payloads and non-finite values without inventing 0%", () => {
    expect(parseXaiOAuthCreditsUsage("not-json")).toBeNull();
    expect(parseXaiOAuthCreditsUsage({})).toBeNull();
    expect(parseXaiOAuthCreditsUsage({ config: {} })).toBeNull();
    expect(parseXaiOAuthCreditsUsage({
      config: { creditUsagePercent: Number.NaN, onDemandCap: { val: Number.POSITIVE_INFINITY } },
    })).toBeNull();
    expect(parseXaiOAuthCreditsUsage({
      config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, subscriptionTier: "SuperGrok Heavy" },
    })).toBeNull();
    expect(parseXaiOAuthCreditsUsage({
      config: { creditUsagePercent: "12", billingPeriodEnd: WEEK_END },
    })).toEqual({
      percent: null,
      resetAtMs: Date.parse(WEEK_END),
      windowSeconds: null,
    });
    expect(parseXaiOAuthCreditsUsage({
      config: { onDemandCap: { val: "1000" }, onDemandUsed: { val: "250" } },
    })).toBeNull();
  });

  it("normalizes settings and billing plan names without requiring settings for usage", () => {
    expect(parseXaiOAuthSettingsPlan({ subscription_tier_display: "supergrok_heavy" })).toBe("SuperGrok Heavy");
    expect(parseXaiOAuthSettingsPlan({ subscription_tier_display: "supergrok" })).toBe("SuperGrok");
    expect(parseXaiOAuthSettingsPlan({ subscription_tier_display: "Custom Team" })).toBe("Custom Team");
    expect(parseXaiOAuthSettingsPlan({})).toBeUndefined();
    expect(parseXaiOAuthCreditsUsage({
      config: { creditUsagePercent: 8, subscriptionTier: "SUPERGROK_HEAVY" },
      subscriptionTier: "SUPERGROK",
    })).toMatchObject({ plan: "SuperGrok Heavy", percent: 8 });
  });
});

describe("xAI OAuth usage fetch", () => {
  it("uses Forge proxy identity and rejects oversized billing before settings enrichment", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url === XAI_OAUTH_BILLING_ENDPOINT) {
        return new Response(`{"config":{"creditUsagePercent":12.5},"padding":"${"x".repeat(1_000_000)}"}`);
      }
      throw new Error(`Unexpected URL: ${request.url}`);
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "transient",
    });
    expect(requests.map((request) => request.url)).toEqual([XAI_OAUTH_BILLING_ENDPOINT]);
    expect(Object.fromEntries(requests[0].headers)).toEqual({
      accept: "application/json",
      authorization: "Bearer oauth-token",
      "user-agent": `forge/${getForgeAppVersion()}`,
      "x-authenticateresponse": "authenticate-response",
      "x-grok-client-identifier": "forge",
      "x-grok-client-version": "0.2.112",
      "x-xai-token-auth": "xai-grok-cli",
    });
  });

  it("ignores settings 401/403 after successful billing", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("settings-unauth", { status: 401 });
      }
      if (url === XAI_OAUTH_BILLING_ENDPOINT) {
        return Response.json({
          config: {
            creditUsagePercent: 12.5,
            currentPeriod: { start: WEEK_START, end: WEEK_END },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "ok",
      usage: {
        provider: "xai",
        available: true,
        weeklyUsage: expect.objectContaining({
          percent: 12.5,
          resetAtMs: Date.parse(WEEK_END),
          windowSeconds: 7 * 24 * 60 * 60,
        }),
      },
    });
  });

  it("keeps usable billing when settings enrichment fails", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("settings-secret", { status: 500 });
      }
      if (url === XAI_OAUTH_BILLING_ENDPOINT) {
        return Response.json({
          config: {
            creditUsagePercent: 12.5,
            currentPeriod: { start: WEEK_START, end: WEEK_END },
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "ok",
      usage: {
        provider: "xai",
        available: true,
        weeklyUsage: expect.objectContaining({
          percent: 12.5,
          resetAtMs: Date.parse(WEEK_END),
          windowSeconds: 7 * 24 * 60 * 60,
        }),
      },
    });
  });

  it("treats 401/403 as unavailable and 500 as transient without leaking bodies", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("settings-secret", { status: 500 });
      }
      return new Response("token-leak", { status: 401 });
    });

    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl })).resolves.toEqual({
      status: "unavailable",
    });

    const transientFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === XAI_OAUTH_SETTINGS_ENDPOINT) {
        return new Response("{}", { status: 200 });
      }
      return new Response("upstream-secret", { status: 500 });
    });
    await expect(fetchXaiOAuthUsage({ accessToken: "oauth-token", fetchImpl: transientFetch })).resolves.toEqual({
      status: "transient",
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("treats a stalled billing stream as transient when aborted or timed out", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
      throw new Error("unreachable");
    });

    await expect(fetchXaiOAuthUsage({
      accessToken: "oauth-token",
      fetchImpl,
      timeoutMs: 20,
    })).resolves.toEqual({ status: "transient" });

    const abortController = new AbortController();
    const pending = fetchXaiOAuthUsage({
      accessToken: "oauth-token",
      fetchImpl,
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(pending).resolves.toEqual({ status: "transient" });
  });
});
