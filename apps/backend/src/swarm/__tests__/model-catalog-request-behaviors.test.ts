import { describe, expect, it } from "vitest";
import {
  createCatalogRequestBehaviorExtensionFactory,
  injectOpenAICodexServiceTier,
} from "../model-catalog-request-behaviors.js";

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


describe("OpenAI Codex service tier behavior", () => {
  it("injects service_tier for priority without mutating the original payload", () => {
    const payload = { input: "hello" };
    const result = injectOpenAICodexServiceTier(payload, "priority");
    expect(result).toEqual({ input: "hello", service_tier: "priority" });
    expect(result).not.toBe(payload);
    expect(payload).toEqual({ input: "hello" });
  });

  it("overwrites existing service_tier and supports fast vocabulary adapter", () => {
    expect(injectOpenAICodexServiceTier({ service_tier: "default" }, "priority", "fast")).toEqual({ service_tier: "fast" });
  });

  it("no-ops for default, arrays, null, and non-object payloads", () => {
    const payload = { input: "hello" };
    expect(injectOpenAICodexServiceTier(payload, "default")).toBe(payload);
    expect(injectOpenAICodexServiceTier(null, "priority")).toBeNull();
    expect(injectOpenAICodexServiceTier(["x"], "priority")).toEqual(["x"]);
    expect(injectOpenAICodexServiceTier("x", "priority")).toBe("x");
  });

  it("extension injects service_tier only for priority Codex runtimes", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    createCatalogRequestBehaviorExtensionFactory({
      providerId: "openai-codex",
      modelId: "gpt-5.4",
      webSearchEnabled: false,
      serviceTier: "priority",
    })({
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      },
    } as any);

    const result = handlers.get("before_provider_request")?.(
      { payload: { input: "hello" } },
      { model: { provider: "openai-codex", id: "gpt-5.4" } },
    );
    expect(result).toEqual({ input: "hello", service_tier: "priority" });
  });
});
