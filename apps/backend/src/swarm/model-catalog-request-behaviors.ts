import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getCatalogProvider } from "@forge/protocol";

const RESPONSES_REASONING_INCLUDE = "reasoning.encrypted_content";

/**
 * Create a Pi extension factory that applies catalog-driven request behaviors.
 *
 * Currently handles:
 * - xAI: strip unsupported reasoning fields from Responses payloads
 * - xAI: inject native web_search / x_search tools when enabled
 */
export function createCatalogRequestBehaviorExtensionFactory(options: {
  webSearchEnabled: boolean;
}): ExtensionFactory {
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

      return undefined;
    });
  };
}

function stripReasoningFromResponsesPayload(payload: unknown): unknown {
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

function injectNativeSearchTools(payload: unknown): unknown {
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
