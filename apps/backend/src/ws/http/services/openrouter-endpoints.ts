import type { OpenRouterEndpoint, OpenRouterEndpointsResponse } from "@forge/protocol";

const BASE = "https://openrouter.ai/api/v1";
const TTL = 5 * 60_000;
const LIMIT = 100;
type CacheEntry = { rows: Record<string, unknown>[]; at: number };
/** Bounded metadata-only cache. No credentials or generation requests. */
export class OpenRouterEndpointDiscovery {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<{ entry?: CacheEntry; status: OpenRouterEndpointsResponse["status"] }>>();

  private async load(key: string, refresh: boolean): Promise<{ entry?: CacheEntry; status: OpenRouterEndpointsResponse["status"] }> {
    const old = this.cache.get(key);
    if (!refresh && old && Date.now() - old.at < TTL) return { entry: old, status: "fresh" };
    const pending = this.pending.get(key);
    if (pending) return pending;
    // Bound concurrent misses too, not just retained cache entries.
    if (this.pending.size >= LIMIT) return { entry: old, status: old ? "stale" : "unavailable" };
    const request = (async () => {
      try {
        const response = await fetch(`${BASE}/${key}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Endpoint discovery failed: ${response.status}`);
        const payload = await response.json() as { data?: unknown };
        const rows = key === "endpoints/zdr" ? payload.data : asRecord(payload.data)?.endpoints;
        if (!Array.isArray(rows) || rows.some((row) => !asRecord(row) || typeof row.tag !== "string" || typeof row.model_id !== "string")) throw new Error("Malformed endpoint metadata");
        const entry = { rows: rows as Record<string, unknown>[], at: Date.now() };
        this.cache.delete(key);
        this.cache.set(key, entry);
        while (this.cache.size > LIMIT) this.cache.delete(this.cache.keys().next().value!);
        return { entry, status: "fresh" as const };
      } catch {
        return { entry: old, status: old ? "stale" as const : "unavailable" as const };
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, request);
    return request;
  }

  async discover(modelId: string, refresh = false): Promise<OpenRouterEndpointsResponse> {
    const [models, zdr] = await Promise.all([
      this.load(`models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`, refresh),
      this.load("endpoints/zdr", refresh),
    ]);
    const eligible = new Set(zdr.entry?.rows.filter((row) => row.model_id === modelId).map((row) => row.tag));
    const endpoints: OpenRouterEndpoint[] = (models.entry?.rows ?? []).filter((row) => row.model_id === modelId).map((row) => {
      const pricing = asRecord(row.pricing);
      const prompt = price(pricing?.prompt);
      const completion = price(pricing?.completion);
      return {
        tag: row.tag as string,
        providerName: typeof row.provider_name === "string" ? row.provider_name : row.tag as string,
        name: typeof row.name === "string" ? row.name : row.tag as string,
        ...(positive(row.context_length) ? { contextLength: row.context_length as number } : {}),
        ...(positive(row.max_completion_tokens) ? { maxCompletionTokens: row.max_completion_tokens as number } : {}),
        supportedParameters: Array.isArray(row.supported_parameters) ? row.supported_parameters.filter((item): item is string => typeof item === "string") : [],
        ...(prompt !== undefined || completion !== undefined ? { pricing: { ...(prompt !== undefined ? { prompt } : {}), ...(completion !== undefined ? { completion } : {}) } } : {}),
        // Stale authoritative lists cannot support a current eligibility badge.
        zdr: zdr.status !== "fresh" ? "unknown" : eligible.has(row.tag) ? "eligible" : "not-listed",
      };
    });
    return { modelId, endpoints, status: models.status, zdrStatus: zdr.status, ...(models.entry ? { fetchedAt: new Date(models.entry.at).toISOString() } : {}) };
  }
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function positive(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function price(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}
