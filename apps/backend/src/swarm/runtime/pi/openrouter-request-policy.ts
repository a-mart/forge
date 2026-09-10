import { isDeepStrictEqual } from "node:util";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { OpenRouterRoutingPolicy } from "@forge/protocol";
import { modelCatalogService } from "../../model-catalog-service.js";

type StreamFn = AgentSession["agent"]["streamFn"];
type RoutingResolver = (modelId: string) => OpenRouterRoutingPolicy;
const resolveRouting: RoutingResolver = (id) => modelCatalogService.getEffectiveOpenRouterRouting(id);

/** Resolve at dispatch, not runtime creation: existing sessions, retries and summaries share this boundary. */
export function withOpenRouterRequestPolicy(
  stream: StreamFn,
  resolve: RoutingResolver = resolveRouting,
): StreamFn {
  return (model, context, options) => {
    if (model.provider !== "openrouter") return stream(model, context, options);
    // A custom endpoint/API cannot be assumed to implement OpenRouter's privacy filters.
    const endpoint = new URL(model.baseUrl);
    if (endpoint.protocol !== "https:" || endpoint.hostname !== "openrouter.ai" || model.api !== "openai-completions") {
      throw new Error("OpenRouter routing cannot be enforced on this endpoint/API; use the OpenRouter HTTPS completions endpoint");
    }
    const policy = structuredClone(resolve(model.id));
    const requestModel = { ...model, compat: { ...model.compat, openRouterRouting: structuredClone(policy) } };
    const onPayload = options?.onPayload;
    return stream(requestModel, context, {
      ...options,
      onPayload: async (payload, callbackModel) => {
        const next = await onPayload?.(payload, callbackModel) ?? payload;
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          throw new Error("OpenRouter routing rejected an invalid provider request payload");
        }
        const body = next as Record<string, unknown>;
        if (body.model !== model.id || "models" in body || "route" in body) {
          throw new Error("OpenRouter routing rejected an extension model/fallback override");
        }
        // Compat starts from fresh catalog policy, not a stale runtime model. Keep additional
        // extension restrictions, but never let a payload hook weaken Forge's requirements.
        return { ...body, provider: protectRoutingPolicy(body.provider, policy) };
      },
    });
  };
}

function protectRoutingPolicy(value: unknown, policy: OpenRouterRoutingPolicy): Record<string, unknown> {
  if (value != null && (typeof value !== "object" || Array.isArray(value))) {
    throw new Error("OpenRouter routing rejected an invalid extension provider policy");
  }
  const extension = (value ?? {}) as Record<string, unknown>;
  // Neither side can safely replace a different hard filter from the other. Do not
  // invent intersections or compare endpoint equivalence: require the author to resolve it.
  for (const key of ["only", "ignore", "max_price", "quantizations"] as const) {
    if (policy[key] !== undefined && extension[key] !== undefined && !isDeepStrictEqual(policy[key], extension[key])) {
      throw new Error(`OpenRouter routing conflicts with extension provider.${key}; align the extension and Forge routing settings`);
    }
  }
  const merged: Record<string, unknown> = { ...extension, ...structuredClone(policy) };
  // These fields have an unambiguous stricter value. Preserve it from either source,
  // including when Forge explicitly leaves ZDR/collection unrestricted.
  if (extension.zdr === true || policy.zdr === true) merged.zdr = true;
  if (extension.data_collection === "deny" || policy.data_collection === "deny") merged.data_collection = "deny";
  if (extension.require_parameters === true || policy.require_parameters === true) merged.require_parameters = true;
  if (extension.allow_fallbacks === false || policy.allow_fallbacks === false) merged.allow_fallbacks = false;
  if (merged.order != null && merged.sort != null) {
    throw new Error("OpenRouter routing conflicts with extension provider order/sort; align the extension and Forge routing settings");
  }
  return merged;
}

export function installOpenRouterRequestPolicy(session: AgentSession): void {
  session.agent.streamFn = withOpenRouterRequestPolicy(session.agent.streamFn.bind(session.agent));
}

/** Forge fallback has no equivalent-policy contract across models/providers. Fail closed for hard filters. */
export function blocksOpenRouterFallback(model: { provider: string; modelId: string }): boolean {
  if (model.provider.trim().toLowerCase() !== "openrouter") return false;
  try {
    const policy = resolveRouting(model.modelId);
    return policy.zdr === true || policy.data_collection === "deny" ||
      policy.only !== undefined || policy.ignore !== undefined || policy.max_price !== undefined ||
      policy.quantizations !== undefined || policy.require_parameters === true || policy.allow_fallbacks === false;
  } catch {
    return true;
  }
}
