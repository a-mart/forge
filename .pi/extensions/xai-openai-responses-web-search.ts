import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getModels } from "@mariozechner/pi-ai";

const XAI_PROVIDER = "xai";
const XAI_BASE_URL = "https://api.x.ai/v1";
const WEB_SEARCH_TOOL = { type: "web_search" } as const;

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
  ...(model.compat ? { compat: model.compat } : {})
}));

function hasWebSearchTool(tool: unknown): boolean {
  return !!tool && typeof tool === "object" && "type" in tool && (tool as { type?: unknown }).type === "web_search";
}

function injectWebSearchTool(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const payloadObject = payload as Record<string, unknown> & { tools?: unknown };
  const tools = Array.isArray(payloadObject.tools) ? [...payloadObject.tools] : [];

  if (tools.some(hasWebSearchTool)) {
    return payload;
  }

  tools.push({ ...WEB_SEARCH_TOOL });

  return {
    ...payloadObject,
    tools
  };
}

export default function registerXaiResponsesWebSearchExtension(pi: ExtensionAPI) {
  pi.registerProvider(XAI_PROVIDER, {
    baseUrl: XAI_BASE_URL,
    apiKey: "XAI_API_KEY",
    api: "openai-responses",
    models: xaiResponsesModels
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== XAI_PROVIDER) {
      return undefined;
    }

    return injectWebSearchTool(event.payload);
  });
}
