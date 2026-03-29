import { describe, expect, it, vi } from "vitest";

const piAiMockState = vi.hoisted(() => ({
  getModels: vi.fn((provider: unknown) =>
    provider === "xai"
      ? [
          {
            id: "grok-4.20-0309-reasoning",
            name: "Grok 4.20 (Reasoning)",
            api: "openai-completions",
            provider: "xai",
            baseUrl: "https://api.x.ai/v1",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
            contextWindow: 2_000_000,
            maxTokens: 30_000,
          },
        ]
      : [],
  ),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModels: (provider: unknown) => piAiMockState.getModels(provider),
}));

import { createXaiResponsesExtensionFactory } from "../extensions/xai-responses-provider.js";

function installExtension(webSearchEnabled: boolean) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const registerProvider = vi.fn();

  createXaiResponsesExtensionFactory({ webSearchEnabled })({
    registerProvider,
    on: (event: string, handler: (...args: any[]) => unknown) => {
      handlers.set(event, handler);
    },
  } as any);

  return {
    registerProvider,
    beforeProviderRequest: handlers.get("before_provider_request"),
  };
}

describe("createXaiResponsesExtensionFactory", () => {
  it("registers xAI responses models with a future-proof reasoning compat flag", () => {
    const { registerProvider } = installExtension(false);

    expect(registerProvider).toHaveBeenCalledWith(
      "xai",
      expect.objectContaining({
        api: "openai-responses",
        models: [
          expect.objectContaining({
            id: "grok-4.20-0309-reasoning",
            api: "openai-responses",
            compat: expect.objectContaining({
              supportsReasoningEffort: false,
            }),
          }),
        ],
      }),
    );
  });

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

  it("leaves non-xAI payloads unchanged", () => {
    const { beforeProviderRequest } = installExtension(true);

    const payload = {
      input: "hello",
      reasoning: { effort: "high", summary: "auto" },
    };

    const result = beforeProviderRequest?.(
      { payload },
      {
        model: { provider: "openai", id: "gpt-5.4" },
      },
    );

    expect(result).toBeUndefined();
  });
});
