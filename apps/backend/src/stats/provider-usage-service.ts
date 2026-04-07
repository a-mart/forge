import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderAccountUsage, ProviderUsageStats } from "@forge/protocol";
import type { CredentialPoolService } from "../swarm/credential-pool.js";
import {
  evaluateHistoricalProviderUsagePace,
  ProviderUsageHistoryStore,
  type ProviderUsageHistoryProvider
} from "./provider-usage-history.js";

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
  openai?: CachedProviderUsageEntry[];
  anthropic?: CachedProviderUsageEntry;
}

interface PersistedProviderUsageCache {
  version: number;
  entries: CachedProviderUsage;
}

const TEST_PROVIDER_USAGE_SNAPSHOT: ProviderUsageStats = {
  openai: [unavailableProviderUsage("openai")],
  anthropic: unavailableProviderUsage("anthropic")
};

const PERSISTED_CACHE_VERSION = 2;

export class ProviderUsageService {
  private readonly cache: CachedProviderUsage = {};
  private readonly historyStore: ProviderUsageHistoryStore;
  private persistentCacheLoaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private credentialPoolGetter?: () => CredentialPoolService;

  constructor(
    private readonly sharedAuthFilePath: string,
    historyFilePath: string,
    private readonly cacheFilePath?: string
  ) {
    this.historyStore = new ProviderUsageHistoryStore(historyFilePath);
  }

  setCredentialPoolGetter(getter: () => CredentialPoolService): void {
    this.credentialPoolGetter = getter;
  }

  async getSnapshot(): Promise<ProviderUsageStats> {
    if (IS_TEST_ENV) {
      return TEST_PROVIDER_USAGE_SNAPSHOT;
    }

    await this.ensurePersistentCacheLoaded();

    const nowMs = Date.now();

    await Promise.all([
      this.refreshOpenAIIfStale(nowMs),
      this.refreshAnthropicIfStale(nowMs)
    ]);

    return {
      openai: this.cache.openai?.map(e => e.data),
      anthropic: this.cache.anthropic?.data
    };
  }

  private async refreshOpenAIIfStale(nowMs: number): Promise<void> {
    if (this.cache.openai?.length && this.cache.openai.every(e => isFresh(e, nowMs))) {
      return;
    }

    // Multi-account path: fetch usage for each pooled credential
    const pool = this.credentialPoolGetter?.();
    if (pool) {
      try {
        const poolState = await pool.listPool("openai-codex");
        if (poolState.credentials.length > 1) {
          const entries: CachedProviderUsageEntry[] = [];
          for (const cred of poolState.credentials) {
            try {
              const authData = await pool.buildRuntimeAuthData("openai-codex", cred.id);
              const codexAuth = authData["openai-codex"] as CodexAuthFile | undefined;
              const accessToken = codexAuth?.tokens?.access_token?.trim();
              if (!accessToken) {
                entries.push({ data: { ...unavailableProviderUsage("openai"), accountId: cred.id, accountLabel: cred.label }, fetchedAtMs: nowMs, lastAttemptMs: nowMs });
                continue;
              }
              const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
              const acctId = codexAuth?.tokens?.account_id?.trim();
              if (acctId) headers["ChatGPT-Account-Id"] = acctId;
              const response = await fetch(OPENAI_USAGE_URL, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
              if (!response.ok) {
                entries.push({ data: { ...unavailableProviderUsage("openai"), accountId: cred.id, accountLabel: cred.label }, fetchedAtMs: nowMs, lastAttemptMs: nowMs });
                continue;
              }
              const body = (await response.json()) as OpenAIUsageResponse;
              const usage = await this.withHistoricalPace("openai", mapOpenAIResponse(body), nowMs);
              usage.accountId = cred.id;
              usage.accountLabel = cred.label;
              entries.push({ data: usage, fetchedAtMs: nowMs, lastAttemptMs: nowMs });
            } catch {
              entries.push({ data: { ...unavailableProviderUsage("openai"), accountId: cred.id, accountLabel: cred.label }, fetchedAtMs: nowMs, lastAttemptMs: nowMs });
            }
          }
          this.cache.openai = entries;
          this.queuePersistCacheWrite();
          return;
        }
      } catch {
        // fall through to single-account path
      }
    }

    // Single-account path
    const auth = await this.readOpenAIAuth();
    const accessToken = auth?.tokens?.access_token?.trim();
    if (!accessToken) {
      if (auth) {
        this.invalidateOpenAI(nowMs);
      } else {
        this.recordOpenAIFailedAttempt(nowMs);
      }
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
        if (response.status === 401 || response.status === 403) {
          this.invalidateOpenAI(nowMs);
        } else {
          this.recordOpenAIFailedAttempt(nowMs);
        }
        return;
      }

      const body = (await response.json()) as OpenAIUsageResponse;
      const usage = await this.withHistoricalPace("openai", mapOpenAIResponse(body), nowMs);
      this.cache.openai = [{ data: usage, fetchedAtMs: nowMs, lastAttemptMs: nowMs }];
      this.queuePersistCacheWrite();
    } catch (error) {
      console.warn(`[provider-usage] OpenAI usage fetch failed: ${toErrorMessage(error)}`);
      this.recordOpenAIFailedAttempt(nowMs);
    }
  }

  private async refreshAnthropicIfStale(nowMs: number): Promise<void> {
    if (isFresh(this.cache.anthropic, nowMs)) {
      return;
    }

    const auth = await this.readAnthropicAuth();
    const accessToken = auth?.anthropic?.access?.trim();
    if (!accessToken) {
      if (auth) {
        this.invalidateProvider("anthropic", nowMs);
      } else {
        this.recordFailedAttempt("anthropic", nowMs);
      }
      return;
    }

    const expiresMs = auth?.anthropic?.expires;
    if (typeof expiresMs === "number" && Number.isFinite(expiresMs) && Date.now() > expiresMs) {
      console.debug("[provider-usage] Anthropic OAuth token expired");
      this.invalidateProvider("anthropic", nowMs);
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
        if (response.status === 401 || response.status === 403) {
          this.invalidateProvider("anthropic", nowMs);
        } else {
          this.recordFailedAttempt("anthropic", nowMs);
        }
        return;
      }

      const body = (await response.json()) as AnthropicUsageResponse;
      const usage = await this.withHistoricalPace("anthropic", mapAnthropicResponse(body), nowMs);
      this.setCached("anthropic", usage, nowMs);
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

  private setCached(provider: "anthropic", data: ProviderAccountUsage, fetchedAtMs: number): void {
    this.cache[provider] = {
      data,
      fetchedAtMs,
      lastAttemptMs: fetchedAtMs
    };
    this.queuePersistCacheWrite();
  }

  private invalidateOpenAI(nowMs: number): void {
    this.cache.openai = [{ data: unavailableProviderUsage("openai"), fetchedAtMs: nowMs, lastAttemptMs: nowMs }];
    this.queuePersistCacheWrite();
  }

  private recordOpenAIFailedAttempt(nowMs: number): void {
    const existing = this.cache.openai;
    if (existing?.length && existing[0].data.available) {
      this.cache.openai = existing.map(e => ({ ...e, lastAttemptMs: nowMs }));
    } else {
      this.cache.openai = [{ data: unavailableProviderUsage("openai"), fetchedAtMs: nowMs, lastAttemptMs: nowMs }];
    }
    this.queuePersistCacheWrite();
  }

  private async withHistoricalPace(
    provider: ProviderUsageHistoryProvider,
    data: ProviderAccountUsage,
    sampledAtMs: number
  ): Promise<ProviderAccountUsage> {
    const weeklyUsage = data.weeklyUsage;
    if (!data.available || !weeklyUsage?.resetAtMs || !weeklyUsage.windowSeconds || weeklyUsage.windowSeconds <= 0) {
      return data;
    }

    const accountKey = toHistoryAccountKey(data.accountEmail);
    const dataset = await this.historyStore.recordWeeklyWindow({
      provider,
      window: weeklyUsage,
      sampledAtMs,
      accountKey
    });
    const pace = evaluateHistoricalProviderUsagePace(weeklyUsage, sampledAtMs, dataset);
    if (!pace) {
      return data;
    }

    return {
      ...data,
      weeklyUsage: {
        ...weeklyUsage,
        pace
      }
    };
  }

  private recordFailedAttempt(provider: "anthropic", nowMs: number): void {
    const existing = this.cache[provider];

    if (existing?.data.available) {
      this.cache[provider] = {
        ...existing,
        lastAttemptMs: nowMs
      };
      this.queuePersistCacheWrite();
      return;
    }

    this.cache[provider] = {
      data: unavailableProviderUsage(provider),
      fetchedAtMs: nowMs,
      lastAttemptMs: nowMs
    };
    this.queuePersistCacheWrite();
  }

  private invalidateProvider(provider: "anthropic", nowMs: number): void {
    this.cache[provider] = {
      data: unavailableProviderUsage(provider),
      fetchedAtMs: nowMs,
      lastAttemptMs: nowMs
    };
    this.queuePersistCacheWrite();
  }

  private async ensurePersistentCacheLoaded(): Promise<void> {
    if (this.persistentCacheLoaded || !this.cacheFilePath) {
      return;
    }

    this.persistentCacheLoaded = true;

    try {
      const raw = await readFile(this.cacheFilePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedProviderUsageCache;
      if (!isRecord(parsed) || parsed.version !== PERSISTED_CACHE_VERSION || !isRecord(parsed.entries)) {
        return;
      }

      const openaiRaw = parsed.entries.openai;
      if (Array.isArray(openaiRaw)) {
        const openaiEntries = openaiRaw.map(parseCachedProviderUsageEntry).filter((e): e is CachedProviderUsageEntry => e !== null);
        if (openaiEntries.length > 0) {
          this.cache.openai = openaiEntries;
        }
      } else if (openaiRaw) {
        const single = parseCachedProviderUsageEntry(openaiRaw);
        if (single) {
          this.cache.openai = [single];
        }
      }

      const anthropic = parseCachedProviderUsageEntry(parsed.entries.anthropic);
      if (anthropic) {
        this.cache.anthropic = anthropic;
      }
    } catch (error) {
      if (!isEnoentError(error)) {
        console.warn(`[provider-usage] Failed to read persisted provider usage cache: ${toErrorMessage(error)}`);
      }
    }
  }

  private queuePersistCacheWrite(): void {
    const cacheFilePath = this.cacheFilePath;
    if (!cacheFilePath) {
      return;
    }

    this.persistQueue = this.persistQueue
      .then(async () => {
        const payload: PersistedProviderUsageCache = {
          version: PERSISTED_CACHE_VERSION,
          entries: this.cache
        };

        await mkdir(dirname(cacheFilePath), { recursive: true });
        await writeFile(cacheFilePath, JSON.stringify(payload), "utf8");
      })
      .catch((error) => {
        console.warn(`[provider-usage] Failed to persist provider usage cache: ${toErrorMessage(error)}`);
      });
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
  if (totalHours < 24) {
    return `${totalHours.toFixed(1)}h`;
  }

  const totalDays = totalHours / 24;
  return `${totalDays.toFixed(1)}d`;
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

function toHistoryAccountKey(accountEmail: string | undefined): string | undefined {
  const normalized = normalizeString(accountEmail)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return createHash("sha256").update(normalized).digest("hex");
}

function parseCachedProviderUsageEntry(value: unknown): CachedProviderUsageEntry | null {
  if (!isRecord(value) || !isRecord(value.data)) {
    return null;
  }

  const provider = normalizeString(value.data.provider);
  const available = value.data.available;
  const fetchedAtMs = toSafeNumber(value.fetchedAtMs);
  const lastAttemptMs = toSafeNumber(value.lastAttemptMs, fetchedAtMs);

  if (!provider || typeof available !== "boolean" || fetchedAtMs <= 0 || lastAttemptMs <= 0) {
    return null;
  }

  return {
    data: value.data as unknown as ProviderAccountUsage,
    fetchedAtMs,
    lastAttemptMs
  };
}

function toSafeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
