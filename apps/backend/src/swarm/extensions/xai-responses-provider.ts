import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

const XAI_PROVIDER = "xai";
const XAI_BASE_URL = "https://api.x.ai/v1";
const RESPONSES_REASONING_INCLUDE = "reasoning.encrypted_content";

const xaiResponsesModels = getModels(XAI_PROVIDER).map((model) => ({
  id: model.id,
  name: model.name,
  api: "openai-responses" as const,
  reasoning: model.reasoning,
  input: [...model.input],
  cost: { ...model.cost },
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  ...(model.headers ? { headers: { ...model.headers } } : {}),
  compat: {
    ...(model.compat ?? {}),
    supportsReasoningEffort: false,
  },
}));

export function createXaiResponsesExtensionFactory(options: {
  webSearchEnabled: boolean;
}): ExtensionFactory {
  return (pi) => {
    pi.registerProvider(XAI_PROVIDER, {
      baseUrl: XAI_BASE_URL,
      apiKey: "XAI_API_KEY",
      api: "openai-responses",
      models: xaiResponsesModels,
    });

    pi.on("before_provider_request", (event, ctx) => {
      if (ctx.model?.provider !== XAI_PROVIDER) {
        return undefined;
      }

      let payload = stripReasoningFromResponsesPayload(event.payload);

      if (options.webSearchEnabled) {
        payload = injectNativeSearchTools(payload);
      }

      return payload === event.payload ? undefined : payload;
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
