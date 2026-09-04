import type { ProviderAccountUsage, ProviderUsageWindow } from "@forge/protocol";
import { getForgeXaiOAuthProxyHeaders } from "../swarm/catalog/xai-oauth-proxy-compat.js";

export const XAI_OAUTH_BILLING_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const XAI_OAUTH_SETTINGS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/settings";

const MAX_USAGE_BYTES = 1_000_000;
const SETTINGS_TIMEOUT_MS = 2_000;

export interface ParsedXaiOAuthCredits {
  percent: number | null;
  resetAtMs: number | null;
  windowSeconds: number | null;
  plan?: string;
}

export type XaiOAuthUsageFetchResult =
  | { status: "ok"; usage: ProviderAccountUsage }
  | { status: "unavailable" }
  | { status: "transient" };

export async function fetchXaiOAuthUsage(options: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<XaiOAuthUsageFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    ...getForgeXaiOAuthProxyHeaders(),
  };

  try {
    const billingResult = await fetchJsonPayload(
      fetchImpl,
      XAI_OAUTH_BILLING_ENDPOINT,
      headers,
      options.timeoutMs ?? 10_000,
      options.signal,
    );
    if (billingResult.status !== "ok") {
      return { status: billingResult.status };
    }
    if (options.signal?.aborted) {
      return { status: "transient" };
    }

    const parsed = parseXaiOAuthCreditsUsage(billingResult.payload);
    if (!parsed) {
      return { status: "transient" };
    }

    const settingsPlan = await fetchSettingsPlan(fetchImpl, headers, options.signal);
    if (options.signal?.aborted) {
      return { status: "transient" };
    }
    return {
      status: "ok",
      usage: mapXaiOAuthCreditsUsage({
        ...parsed,
        plan: settingsPlan ?? parsed.plan,
      }),
    };
  } catch {
    return { status: "transient" };
  }
}

/**
 * Fail-closed parser for the private CLI proxy credits envelope.
 * Missing percentages stay unknown; 0 is only returned when the wire published a finite 0.
 */
export function parseXaiOAuthCreditsUsage(payload: unknown): ParsedXaiOAuthCredits | null {
  const envelope = readRecord(payload);
  const config = readRecord(envelope?.config);
  if (!envelope || !config) {
    return null;
  }

  const creditUsagePercent = readFiniteNumber(config.creditUsagePercent);
  let percent = creditUsagePercent !== null ? clampPercent(creditUsagePercent) : null;
  if (percent === null) {
    const cap = readCreditsAmount(config.onDemandCap);
    const used = readCreditsAmount(config.onDemandUsed);
    if (cap !== null && cap > 0 && used !== null) {
      percent = clampPercent((used / cap) * 100);
    }
  }

  const currentPeriod = readRecord(config.currentPeriod);
  const startMs = parseTimestamp(currentPeriod?.start);
  const periodEndMs = parseTimestamp(currentPeriod?.end);
  const billingEndMs = parseTimestamp(config.billingPeriodEnd);
  const resetAtMs = periodEndMs ?? billingEndMs;
  const windowSeconds = resolveWindowSeconds(startMs, periodEndMs);
  const plan = displayXaiPlanName(config.subscriptionTier ?? envelope.subscriptionTier);

  if (percent === null && resetAtMs === null) {
    return null;
  }

  return {
    percent,
    resetAtMs,
    windowSeconds,
    ...(plan ? { plan } : {}),
  };
}

export function parseXaiOAuthSettingsPlan(payload: unknown): string | undefined {
  return displayXaiPlanName(readRecord(payload)?.subscription_tier_display);
}

export function mapXaiOAuthCreditsUsage(parsed: ParsedXaiOAuthCredits): ProviderAccountUsage {
  const weeklyUsage = mapWeeklyUsage(parsed);
  return {
    provider: "xai",
    available: true,
    ...(parsed.plan ? { plan: parsed.plan } : {}),
    ...(weeklyUsage ? { weeklyUsage } : {}),
  };
}

async function fetchSettingsPlan(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await fetchJsonPayload(
      fetchImpl,
      XAI_OAUTH_SETTINGS_ENDPOINT,
      headers,
      SETTINGS_TIMEOUT_MS,
      signal,
    );
    if (result.status !== "ok") {
      return undefined;
    }
    return parseXaiOAuthSettingsPlan(result.payload);
  } catch {
    return undefined;
  }
}

async function fetchJsonPayload(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<{ status: "ok"; payload: unknown } | { status: "unavailable" } | { status: "transient" }> {
  if (externalSignal?.aborted) {
    return { status: "transient" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers,
    });

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "unavailable" };
    }
    if (!response.ok || response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "transient" };
    }

    const raw = await readBoundedResponseText(response);
    if (raw === undefined) {
      return { status: "transient" };
    }

    try {
      return { status: "ok", payload: JSON.parse(raw) as unknown };
    } catch {
      return { status: "transient" };
    }
  } catch {
    return { status: "transient" };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function mapWeeklyUsage(parsed: ParsedXaiOAuthCredits): ProviderUsageWindow | undefined {
  if (parsed.percent === null) {
    return undefined;
  }

  return {
    percent: parsed.percent,
    resetInfo: parsed.resetAtMs !== null ? formatResetInfo(parsed.resetAtMs) : "",
    ...(parsed.resetAtMs !== null ? { resetAtMs: parsed.resetAtMs } : {}),
    ...(parsed.windowSeconds !== null ? { windowSeconds: parsed.windowSeconds } : {}),
  };
}

function resolveWindowSeconds(startMs: number | null, endMs: number | null): number | null {
  if (startMs === null || endMs === null || endMs <= startMs) {
    return null;
  }

  const windowSeconds = (endMs - startMs) / 1000;
  return Number.isFinite(windowSeconds) && windowSeconds > 0 ? Math.round(windowSeconds) : null;
}

function displayXaiPlanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const compact = trimmed.toLowerCase().replace(/[^a-z]/gu, "");
  if (compact === "supergrokheavy" || compact === "heavy") {
    return "SuperGrok Heavy";
  }
  if (compact === "supergrok") {
    return "SuperGrok";
  }
  return trimmed;
}

function readCreditsAmount(value: unknown): number | null {
  return readFiniteNumber(readRecord(value)?.val);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
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

async function readBoundedResponseText(response: Response): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_USAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }

  if (!response.body) {
    const raw = await response.text();
    return new TextEncoder().encode(raw).byteLength <= MAX_USAGE_BYTES ? raw : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_USAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
