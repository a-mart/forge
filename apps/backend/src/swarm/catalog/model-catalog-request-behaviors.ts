import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getCatalogProvider, getEffectiveForgeServiceTier, type ForgeServiceTier } from "@forge/protocol";
import { toOpenAICodexPayloadServiceTier } from "./service-tier-policy.js";

const RESPONSES_REASONING_INCLUDE = "reasoning.encrypted_content";

interface CatalogRequestBehaviorOptions {
  agentId?: string;
  providerId?: string;
  modelId?: string;
  webSearchEnabled: boolean;
  serviceTier?: ForgeServiceTier;
  codexTierVocabulary?: "priority" | "fast";
}

/**
 * Create a Pi extension factory that applies catalog-driven request behaviors.
 *
 * Currently handles:
 * - xAI: strip unsupported reasoning fields from Responses payloads
 * - xAI: inject native web_search / x_search tools when enabled
 * - OpenAI Codex: inject service_tier for Fast mode runtimes
 */
export function createCatalogRequestBehaviorExtensionFactory(options: CatalogRequestBehaviorOptions): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      if (!ctx.model) {
        return undefined;
      }

      const provider = getCatalogProvider(ctx.model.provider);
      if (!provider) {
        return undefined;
      }

      if (provider.requestBehaviorId === "xai-responses") {
        let payload = stripReasoningFromResponsesPayload(event.payload);

        if (options.webSearchEnabled) {
          payload = injectNativeSearchTools(payload);
        }

        return payload === event.payload ? undefined : payload;
      }

      if (provider.requestBehaviorId === "openai-codex-service-tier") {
        if (options.providerId && options.providerId !== ctx.model.provider) {
          return undefined;
        }
        if (options.modelId && "id" in ctx.model && options.modelId !== ctx.model.id) {
          return undefined;
        }
        const tier = getEffectiveForgeServiceTier({ serviceTier: options.serviceTier });
        const payload = injectOpenAICodexServiceTier(
          event.payload,
          tier,
          options.codexTierVocabulary ?? "priority",
        );
        return payload === event.payload ? undefined : payload;
      }

      return undefined;
    });
  };
}

export function injectOpenAICodexServiceTier(
  payload: unknown,
  tier: ForgeServiceTier | undefined,
  vocabulary: "priority" | "fast" = "priority",
): unknown {
  const payloadTier = toOpenAICodexPayloadServiceTier(tier, vocabulary);
  if (!payloadTier || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const objectPayload = payload as Record<string, unknown>;
  if (objectPayload.service_tier === payloadTier) {
    return payload;
  }

  return { ...objectPayload, service_tier: payloadTier };
}

export function stripReasoningFromResponsesPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const objectPayload = payload as Record<string, unknown>;
  let changed = false;
  const nextPayload: Record<string, unknown> = { ...objectPayload };

  if ("reasoning" in objectPayload) {
    delete nextPayload.reasoning;
    changed = true;
  }

  if (Array.isArray(objectPayload.include)) {
    const include = objectPayload.include.filter(
      (entry) => entry !== RESPONSES_REASONING_INCLUDE,
    );
    if (include.length !== objectPayload.include.length) {
      changed = true;
      if (include.length > 0) {
        nextPayload.include = include;
      } else {
        delete nextPayload.include;
      }
    }
  }

  return changed ? nextPayload : payload;
}

export function injectNativeSearchTools(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const objectPayload = payload as Record<string, unknown>;
  const tools = Array.isArray(objectPayload.tools) ? [...objectPayload.tools] : [];

  const hasToolType = (type: string) =>
    tools.some(
      (tool) =>
        typeof tool === "object" &&
        tool !== null &&
        "type" in tool &&
        (tool as { type?: unknown }).type === type,
    );

  let changed = false;

  if (!hasToolType("web_search")) {
    tools.push({ type: "web_search" });
    changed = true;
  }

  if (!hasToolType("x_search")) {
    tools.push({ type: "x_search" });
    changed = true;
  }

  return changed ? { ...objectPayload, tools } : payload;
}
