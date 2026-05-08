import { describe, expect, it } from "vitest";
import { createCatalogRequestBehaviorExtensionFactory } from "../model-catalog-request-behaviors.js";

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
