import { afterEach, describe, expect, it } from "vitest";
import { createCatalogRequestBehaviorExtensionFactory } from "../model-catalog-request-behaviors.js";
import { modelCatalogService } from "../model-catalog-service.js";
import { parseXaiOAuthModelCatalog } from "../catalog/xai-oauth-model-discovery.js";

function installExtension(webSearchEnabled: boolean) {
  const handlers = new Map<string, (...args: any[]) => unknown>();

  createCatalogRequestBehaviorExtensionFactory({ webSearchEnabled })({
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    },
  } as any);

  return {
    beforeProviderRequest: handlers.get("before_provider_request"),
  };
}

afterEach(() => modelCatalogService.setXaiOAuthDiscoveredModels(null));

describe("createCatalogRequestBehaviorExtensionFactory", () => {
  it("strips reasoning payload fields for xAI responses requests", () => {
    const { beforeProviderRequest } = installExtension(false);

    expect(beforeProviderRequest).toBeTypeOf("function");

    const result = beforeProviderRequest?.(
      {
        payload: {
          input: "hello",
          reasoning: { effort: "high", summary: "auto" },
          include: ["reasoning.encrypted_content", "output_text.sources"],
        },
      },
      {
        model: { provider: "xai", id: "grok-4.20-0309-reasoning" },
      },
    );

    expect(result).toEqual({
      input: "hello",
      include: ["output_text.sources"],
    });
  });

  it.each(["low", "medium", "high", "xhigh"])("preserves Grok 4.5 reasoning effort %s", (effort) => {
    const { beforeProviderRequest } = installExtension(false);
    const payload = {
      input: "hello",
      reasoning: { effort, summary: "auto" },
      include: ["reasoning.encrypted_content"],
    };

    expect(beforeProviderRequest?.(
      { payload },
      { model: { provider: "xai", id: "grok-4.5" } },
    )).toBeUndefined();
  });

  it("preserves reasoning for an authenticated discovered dynamic xAI model", () => {
    modelCatalogService.setXaiOAuthDiscoveredModels(parseXaiOAuthModelCatalog({
      data: [{
        id: "grok-build",
        context_window: 400_000,
        max_output_tokens: 40_000,
        supported_reasoning_levels: ["low", "medium", "high"],
      }],
    }));
    const { beforeProviderRequest } = installExtension(false);
    const payload = { input: "hello", reasoning: { effort: "medium" } };

    expect(beforeProviderRequest?.(
      { payload },
      { model: { provider: "xai", id: "grok-build" } },
    )).toBeUndefined();
  });

  it("strips reasoning and injects native search tools when enabled", () => {
    const { beforeProviderRequest } = installExtension(true);

    expect(beforeProviderRequest).toBeTypeOf("function");

    const result = beforeProviderRequest?.(
      {
        payload: {
          input: "hello",
          reasoning: { effort: "high", summary: "auto" },
          include: ["reasoning.encrypted_content"],
          tools: [{ type: "function", name: "existing_tool" }],
        },
      },
      {
        model: { provider: "xai", id: "grok-4.20-0309-reasoning" },
      },
    );

    expect(result).toEqual({
      input: "hello",
      tools: [
        { type: "function", name: "existing_tool" },
        { type: "web_search" },
        { type: "x_search" },
      ],
    });
  });

  it("injects only the missing native search tool", () => {
    const { beforeProviderRequest } = installExtension(true);

    const result = beforeProviderRequest?.(
      {
        payload: {
          input: "hello",
          tools: [{ type: "web_search" }],
        },
      },
      {
        model: { provider: "xai", id: "grok-4.20-0309-reasoning" },
      },
    );

    expect(result).toEqual({
      input: "hello",
      tools: [{ type: "web_search" }, { type: "x_search" }],
    });
  });

  it("does not modify payloads when both native search tools are already present", () => {
    const { beforeProviderRequest } = installExtension(true);

    const result = beforeProviderRequest?.(
      {
        payload: {
          input: "hello",
          tools: [{ type: "web_search" }, { type: "x_search" }],
        },
      },
      {
        model: { provider: "xai", id: "grok-4.20-0309-reasoning" },
      },
    );

    expect(result).toBeUndefined();
  });

  it("leaves non-catalog behaviors unchanged", () => {
    const { beforeProviderRequest } = installExtension(true);

    const payload = {
      input: "hello",
      reasoning: { effort: "high", summary: "auto" },
    };

    const result = beforeProviderRequest?.(
      { payload },
      {
        model: { provider: "openai-codex", id: "gpt-5.4" },
      },
    );

    expect(result).toBeUndefined();
  });
});
