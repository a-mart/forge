import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderAccountUsage, ProviderUsageStats } from "@forge/protocol";

const CACHE_TTL_MS = 3 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_AUTH_FILE_PATH = join(homedir(), ".codex", "auth.json");
const ANTHROPIC_SESSION_WINDOW_SECONDS = 5 * 60 * 60;
const ANTHROPIC_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const IS_TEST_ENV = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);

interface OpenAIUsageResponse {
  email?: string;
  plan_type?: string;
  rate_limit?: {
    primary_window?: UsageWindow | null;
    secondary_window?: UsageWindow | null;
  };
}

interface AnthropicUsageResponse {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
}

interface UsageWindow {
  used_percent?: number;
  utilization?: number;
  reset_at?: string | number;
  resets_at?: string;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
  window_seconds?: number;
}

interface CodexAuthFile {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
}

interface ForgeAuthFile {
  anthropic?: {
    access?: string;
    expires?: number;
  };
}

interface CachedProviderUsageEntry {
  data: ProviderAccountUsage;
  fetchedAtMs: number;
  lastAttemptMs: number;
}

interface CachedProviderUsage {
  openai?: CachedProviderUsageEntry;
  anthropic?: CachedProviderUsageEntry;
}

const TEST_PROVIDER_USAGE_SNAPSHOT: ProviderUsageStats = {
  openai: unavailableProviderUsage("openai"),
  anthropic: unavailableProviderUsage("anthropic")
};

export class ProviderUsageService {
  private readonly cache: CachedProviderUsage = {};

  constructor(private readonly sharedAuthFilePath: string) {}

  async getSnapshot(): Promise<ProviderUsageStats> {
    if (IS_TEST_ENV) {
      return TEST_PROVIDER_USAGE_SNAPSHOT;
    }

    const nowMs = Date.now();

    await Promise.all([
      this.refreshOpenAIIfStale(nowMs),
      this.refreshAnthropicIfStale(nowMs)
    ]);

    return {
      openai: this.cache.openai?.data,
      anthropic: this.cache.anthropic?.data
    };
  }

  private async refreshOpenAIIfStale(nowMs: number): Promise<void> {
    if (isFresh(this.cache.openai, nowMs)) {
      return;
    }

    const auth = await this.readOpenAIAuth();
    const accessToken = auth?.tokens?.access_token?.trim();
    if (!accessToken) {
      this.recordFailedAttempt("openai", nowMs);
      return;
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json"
    };

    const accountId = auth?.tokens?.account_id?.trim();
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    try {
      const response = await fetch(OPENAI_USAGE_URL, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });

      if (!response.ok) {
        console.warn(`[provider-usage] OpenAI usage API returned ${response.status}`);
        this.recordFailedAttempt("openai", nowMs);
        return;
      }

      const body = (await response.json()) as OpenAIUsageResponse;
      this.setCached("openai", mapOpenAIResponse(body), nowMs);
    } catch (error) {
      console.warn(`[provider-usage] OpenAI usage fetch failed: ${toErrorMessage(error)}`);
      this.recordFailedAttempt("openai", nowMs);
    }
  }

  private async refreshAnthropicIfStale(nowMs: number): Promise<void> {
    if (isFresh(this.cache.anthropic, nowMs)) {
      return;
    }

    const auth = await this.readAnthropicAuth();
    const accessToken = auth?.anthropic?.access?.trim();
    if (!accessToken) {
      this.recordFailedAttempt("anthropic", nowMs);
      return;
    }

    const expiresMs = auth?.anthropic?.expires;
    if (typeof expiresMs === "number" && Number.isFinite(expiresMs) && Date.now() > expiresMs) {
      console.debug("[provider-usage] Anthropic OAuth token expired");
      this.recordFailedAttempt("anthropic", nowMs);
      return;
    }

    try {
      const response = await fetch(ANTHROPIC_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });

      if (!response.ok) {
        console.warn(`[provider-usage] Anthropic usage API returned ${response.status}`);
        this.recordFailedAttempt("anthropic", nowMs);
        return;
      }

      const body = (await response.json()) as AnthropicUsageResponse;
      this.setCached("anthropic", mapAnthropicResponse(body), nowMs);
    } catch (error) {
      console.warn(`[provider-usage] Anthropic usage fetch failed: ${toErrorMessage(error)}`);
      this.recordFailedAttempt("anthropic", nowMs);
    }
  }

  private async readOpenAIAuth(): Promise<CodexAuthFile | null> {
    try {
      const raw = await readFile(CODEX_AUTH_FILE_PATH, "utf8");
      return JSON.parse(raw) as CodexAuthFile;
    } catch (error) {
      if (isEnoentError(error)) {
        console.debug(`[provider-usage] OpenAI auth file not found at ${CODEX_AUTH_FILE_PATH}`);
      } else {
        console.warn(`[provider-usage] Failed to read OpenAI auth file: ${toErrorMessage(error)}`);
      }

      return null;
    }
  }

  private async readAnthropicAuth(): Promise<ForgeAuthFile | null> {
    try {
      const raw = await readFile(this.sharedAuthFilePath, "utf8");
      return JSON.parse(raw) as ForgeAuthFile;
    } catch (error) {
      if (isEnoentError(error)) {
        console.debug(`[provider-usage] Anthropic auth file not found at ${this.sharedAuthFilePath}`);
      } else {
        console.warn(`[provider-usage] Failed to read Anthropic auth file: ${toErrorMessage(error)}`);
      }

      return null;
    }
  }

  private setCached(provider: keyof CachedProviderUsage, data: ProviderAccountUsage, fetchedAtMs: number): void {
    this.cache[provider] = {
      data,
      fetchedAtMs,
      lastAttemptMs: fetchedAtMs
    };
  }

  private recordFailedAttempt(provider: keyof CachedProviderUsage, nowMs: number): void {
    const existing = this.cache[provider];

    if (existing?.data.available) {
      this.cache[provider] = {
        ...existing,
        lastAttemptMs: nowMs
      };
      return;
    }

    this.cache[provider] = {
      data: unavailableProviderUsage(provider),
      fetchedAtMs: nowMs,
      lastAttemptMs: nowMs
    };
  }
}

function isFresh(entry: CachedProviderUsageEntry | undefined, nowMs: number): boolean {
  return Boolean(entry && nowMs - entry.lastAttemptMs < CACHE_TTL_MS);
}

function mapOpenAIResponse(body: OpenAIUsageResponse): ProviderAccountUsage {
  return {
    provider: "openai",
    accountEmail: normalizeString(body.email),
    plan: normalizeString(body.plan_type),
    sessionUsage: mapUsageWindow(body.rate_limit?.primary_window),
    weeklyUsage: mapUsageWindow(body.rate_limit?.secondary_window),
    available: true
  };
}

function mapAnthropicResponse(body: AnthropicUsageResponse): ProviderAccountUsage {
  return {
    provider: "anthropic",
    sessionUsage: mapUsageWindow(body.five_hour, ANTHROPIC_SESSION_WINDOW_SECONDS),
    weeklyUsage: mapUsageWindow(body.seven_day, ANTHROPIC_WEEKLY_WINDOW_SECONDS),
    available: true
  };
}

function mapUsageWindow(
  window: UsageWindow | null | undefined,
  defaultWindowSeconds?: number
): ProviderAccountUsage["sessionUsage"] {
  if (!window) {
    return undefined;
  }

  const percent = normalizePercent(window.used_percent ?? window.utilization);
  const resetMs = resolveResetTimestamp(window);

  if (percent === null || resetMs === null) {
    return undefined;
  }

  const windowSeconds = resolveWindowSeconds(window, defaultWindowSeconds);

  return {
    percent,
    resetInfo: formatResetInfo(resetMs),
    resetAtMs: resetMs,
    windowSeconds
  };
}

function formatResetInfo(resetMs: number): string {
  if (!Number.isFinite(resetMs)) {
    return "soon";
  }

  const remainingMs = Math.max(0, resetMs - Date.now());
  if (remainingMs <= 0) {
    return "soon";
  }

  const totalMinutes = remainingMs / 60_000;

  if (totalMinutes < 60) {
    return `${Math.round(totalMinutes)}m`;
  }

  const totalHours = totalMinutes / 60;
  return `${totalHours.toFixed(1)}h`;
}

function resolveWindowSeconds(window: UsageWindow, defaultWindowSeconds?: number): number | undefined {
  const rawWindowSeconds = window.limit_window_seconds ?? window.window_seconds ?? defaultWindowSeconds;
  return typeof rawWindowSeconds === "number" && Number.isFinite(rawWindowSeconds) && rawWindowSeconds > 0
    ? rawWindowSeconds
    : undefined;
}

function normalizePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

function resolveResetTimestamp(window: UsageWindow): number | null {
  if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at)) {
    return window.reset_at * 1_000;
  }

  if (typeof window.reset_at === "string") {
    const parsed = Date.parse(window.reset_at);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (typeof window.resets_at === "string") {
    const parsed = Date.parse(window.resets_at);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  if (typeof window.reset_after_seconds === "number" && Number.isFinite(window.reset_after_seconds)) {
    return Date.now() + (window.reset_after_seconds * 1_000);
  }

  return null;
}

function unavailableProviderUsage(provider: string): ProviderAccountUsage {
  return {
    provider,
    available: false
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
