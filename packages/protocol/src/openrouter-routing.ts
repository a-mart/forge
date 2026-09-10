/** OpenRouter request provider policy. Prices are USD per million tokens. */
export const OPENROUTER_QUANTIZATIONS = ["int4", "int8", "fp4", "fp6", "fp8", "fp16", "bf16", "fp32", "unknown"] as const;
export interface OpenRouterRoutingPolicy {
  zdr?: boolean;
  data_collection?: "allow" | "deny";
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  sort?: "price" | "throughput" | "latency";
  max_price?: { prompt?: number; completion?: number };
  quantizations?: Array<(typeof OPENROUTER_QUANTIZATIONS)[number]>;
}
/** Absent field inherits; null clears the entire field; arrays and max_price replace. */
export type OpenRouterRoutingConfig = { [K in keyof OpenRouterRoutingPolicy]?: OpenRouterRoutingPolicy[K] | null };
export interface OpenRouterRoutingSettingsResponse {
  revision: string;
  defaults: OpenRouterRoutingConfig;
  modelId?: string;
  routing?: OpenRouterRoutingConfig;
  effective: OpenRouterRoutingPolicy;
}
/** PUT replaces the selected scope's entire configuration, not a patch. */
export interface UpdateOpenRouterRoutingRequest { revision: string; routing: OpenRouterRoutingConfig }
export interface OpenRouterEndpoint {
  tag: string;
  providerName: string;
  name: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  supportedParameters: string[];
  pricing?: { prompt?: number; completion?: number };
  zdr: "eligible" | "not-listed" | "unknown";
}
export interface OpenRouterEndpointsResponse {
  modelId: string;
  endpoints: OpenRouterEndpoint[];
  status: "fresh" | "stale" | "unavailable";
  zdrStatus: "fresh" | "stale" | "unavailable";
  fetchedAt?: string;
}
const keys = new Set(["zdr", "data_collection", "order", "only", "ignore", "allow_fallbacks", "require_parameters", "sort", "max_price", "quantizations"]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function parseOpenRouterRoutingConfig(value: unknown): OpenRouterRoutingConfig {
  if (!record(value)) throw new Error("OpenRouter routing must be an object");
  for (const [key, item] of Object.entries(value)) {
    if (!keys.has(key)) throw new Error(`Unknown OpenRouter routing field: ${key}`);
    if (item === null) continue;
    let valid = false;
    if (["zdr", "allow_fallbacks", "require_parameters"].includes(key)) valid = typeof item === "boolean";
    if (key === "data_collection") valid = item === "allow" || item === "deny";
    if (key === "sort") valid = ["price", "throughput", "latency"].includes(item as string);
    if (["order", "only", "ignore", "quantizations"].includes(key)) {
      valid = Array.isArray(item) && item.length > 0 && item.length <= 100 && new Set(item).size === item.length && item.every((entry) =>
        typeof entry === "string" && entry.length <= 200 && (key === "quantizations"
          ? (OPENROUTER_QUANTIZATIONS as readonly string[]).includes(entry)
          : /^[a-z0-9][a-z0-9._/-]*$/i.test(entry)));
    }
    if (key === "max_price") valid = record(item) && Object.keys(item).length > 0 && Object.entries(item).every(([part, price]) =>
      ["prompt", "completion"].includes(part) && typeof price === "number" && Number.isFinite(price) && price >= 0);
    if (!valid) throw new Error(`Invalid OpenRouter routing field: ${key}`);
  }
  const config = JSON.parse(JSON.stringify(value)) as OpenRouterRoutingConfig;
  checkContradictions(config);
  return config;
}
function checkContradictions(policy: OpenRouterRoutingConfig): void {
  if (policy.order && policy.sort) throw new Error("OpenRouter order and sort are mutually exclusive");
  if (policy.only?.some((slug) => policy.ignore?.some((excluded) => slug === excluded || slug.startsWith(`${excluded}/`)))) {
    throw new Error("OpenRouter allowed providers conflict with excluded providers");
  }
}
/** The sole policy resolver. Global privacy is a floor; no caller may weaken it. */
export function resolveOpenRouterRouting(defaults: OpenRouterRoutingConfig = {}, overrides: OpenRouterRoutingConfig = {}): OpenRouterRoutingPolicy {
  const base = parseOpenRouterRoutingConfig(defaults);
  const local = parseOpenRouterRoutingConfig(overrides);
  const merged = { ...base, ...local };
  if (base.zdr === true) merged.zdr = true;
  if (base.data_collection === "deny") merged.data_collection = "deny";
  const effective = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)) as OpenRouterRoutingPolicy;
  checkContradictions(effective);
  return effective;
}
