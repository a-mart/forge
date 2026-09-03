import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getModels } from "../pi/pi-ai-compat.js";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

const modelRegistryMockState = vi.hoisted(() => ({
  construct: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: () => ({ get: () => undefined, getApiKey: async () => undefined }),
  },
  ModelRegistry: new Proxy(class {}, {
    construct(_target, args) {
      modelRegistryMockState.construct(...args);
      return {
        getError: () => undefined,
        find: (provider: string, modelId: string) => {
          const models: Record<string, Record<string, unknown>> = {
            xai: {
              "grok-4": { api: "openai-responses", contextWindow: 256_000 },
              "grok-4.6": { api: "openai-responses", contextWindow: 500_000, maxTokens: 500_000 },
            },
            "openai-codex": {
              "gpt-6-astra": { contextWindow: 1_050_000, maxTokens: 128_000 },
              "gpt-5.6-sol": { contextWindow: 272_000, maxTokens: 128_000 },
              "gpt-5.6-terra": { contextWindow: 272_000, maxTokens: 128_000 },
              "gpt-5.6-luna": { contextWindow: 272_000, maxTokens: 128_000 },
              "gpt-5.5": { contextWindow: 272_000, maxTokens: 128_000 },
            },
            anthropic: {
              "claude-opus-4-6": { contextWindow: 1_000_000 },
            },
            openrouter: {
              "anthropic/claude-3.5-sonnet": { contextWindow: 200_000, api: "openai-completions" },
            },
          };
          return (models[provider]?.[modelId] as Record<string, unknown> | undefined) ?? undefined;
        },
        getAll: () => [],
      };
    },
  }),
}));

import {
  generatePiProjection,
  getPiModelsProjectionPath,
} from "../model-catalog-projection.js";
import { writeModelOverrides } from "../model-overrides.js";
import { addOpenRouterModel } from "../openrouter-models.js";

const authStorageStub = {
  getOAuthProviders: () => [],
  get: () => undefined,
  hasAuth: () => false,
  getApiKey: async () => undefined,
};

describe("model-catalog-projection", () => {
  it("generates a Pi projection consumed by ModelRegistry with Forge-owned runtime metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    expect(projectionPath).toBe(getPiModelsProjectionPath(dataDir));
    expect(projectionPath).toBe(join(dataDir, "shared", "cache", "generated", "pi-models.json"));

    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        api?: string;
        apiKey?: string;
        models?: Array<{ id: string; api?: string; cost?: unknown }>;
        modelOverrides?: Record<string, unknown>;
      }>;
    };

    const projectedXaiModels = projection.providers.xai?.models ?? [];

    expect(projectedXaiModels.map((model) => model.id).sort()).toEqual([
      "grok-4",
      "grok-4-fast",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
      "grok-4.5",
      "grok-4.6",
    ]);
    expect(projectedXaiModels.map((model) => model.id)).not.toEqual(expect.arrayContaining([
      "grok-4.3",
      "grok-build-0.1",
    ]));
    expect(projectedXaiModels.every((model) => model.api === "openai-responses")).toBe(true);
    expect(projection.providers.xai?.api).toBe("openai-responses");
    expect(projection.providers.xai?.apiKey).toBe("$XAI_API_KEY");

    const upstreamGrok4Fast = getModels("xai").find((model) => model.id === "grok-4-fast");
    expect(projectedXaiModels.find((model) => model.id === "grok-4-fast")?.cost).toEqual(upstreamGrok4Fast?.cost);
    expect(projectedXaiModels.find((model) => model.id === "grok-4.6")).toMatchObject({
      id: "grok-4.6",
      name: "Grok 4.6",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 500_000,
      cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
      thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
    });
    expect(projection.providers.openrouter).toBeUndefined();

    const projectedIds = Object.values(projection.providers).flatMap((provider) => [
      ...(provider.models?.map((model) => model.id) ?? []),
      ...Object.keys(provider.modelOverrides ?? {}),
    ]);
    for (const retiredModelId of [
      "gpt-5.3-codex-spark",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ]) {
      expect(projectedIds).not.toContain(retiredModelId);
    }

    const registry = new (ModelRegistry as unknown as new (...args: unknown[]) => unknown)(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => { api?: string; contextWindow?: number; maxTokens?: number } | undefined;
    };

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("xai", "grok-4")?.api).toBe("openai-responses");
    expect(registry.find("xai", "grok-4")?.contextWindow).toBe(256_000);
    expect(registry.find("xai", "grok-4.6")).toMatchObject({
      api: "openai-responses",
      contextWindow: 500_000,
      maxTokens: 500_000,
    });
    expect(registry.find("openai-codex", "gpt-6-astra")).toMatchObject({
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(registry.find("openai-codex", modelId)?.contextWindow).toBe(272_000);
      expect(registry.find("openai-codex", modelId)?.maxTokens).toBe(128_000);
    }
    expect(registry.find("openai-codex", "gpt-5.5")?.contextWindow).toBe(272_000);
    expect(registry.find("openai-codex", "gpt-5.5")?.maxTokens).toBe(128_000);
    expect(registry.find("anthropic", "claude-opus-4-6")?.contextWindow).toBe(1_000_000);
    expect(modelRegistryMockState.construct).toHaveBeenCalledWith(authStorageStub, projectionPath);
  });

  it("projects pending GPT-6 Astra with reasoning compatibility and tiered pricing", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    expect(getModels("openai-codex").some((model) => model.id === "gpt-6-astra")).toBe(false);

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-astra-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        models?: Array<{
          id: string;
          contextWindow?: number;
          maxTokens?: number;
          thinkingLevelMap?: Record<string, string | null>;
          cost?: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            tiers?: Array<{
              inputTokensAbove: number;
              input: number;
              output: number;
              cacheRead: number;
              cacheWrite: number;
            }>;
          };
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    const projectedAstra = projection.providers["openai-codex"]?.models?.find(
      (model) => model.id === "gpt-6-astra",
    );

    const expectedAstra = {
      id: "gpt-6-astra",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
      },
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: { supportsTemperature: false },
    };
    expect(projectedAstra).toMatchObject(expectedAstra);

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => {
        id: string;
        provider: string;
        api: string;
        baseUrl: string;
        contextWindow?: number;
        maxTokens?: number;
        thinkingLevelMap?: Record<string, string | null>;
        cost?: unknown;
        compat?: Record<string, unknown>;
      } | undefined;
    };
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openai-codex", "gpt-6-astra")).toMatchObject({
      ...expectedAstra,
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("projects pending Fable 5.1 with adaptive-thinking compatibility and curated pricing", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    expect(getModels("anthropic").some((model) => model.id === "claude-fable-5-1")).toBe(false);

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-fable51-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        models?: Array<{
          id: string;
          contextWindow?: number;
          maxTokens?: number;
          thinkingLevelMap?: Record<string, string | null>;
          cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    const projectedFable51 = projection.providers.anthropic?.models?.find(
      (model) => model.id === "claude-fable-5-1",
    );

    expect(projectedFable51).toMatchObject({
      id: "claude-fable-5-1",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => {
        contextWindow?: number;
        maxTokens?: number;
        cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
        compat?: Record<string, unknown>;
        thinkingLevelMap?: Record<string, string | null>;
      } | undefined;
    };
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("anthropic", "claude-fable-5-1")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      thinkingLevelMap: {
        off: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });
  });

  it("projects Fable 5 overrides through the real ModelRegistry without losing upstream runtime metadata", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    const upstreamFable = getModels("anthropic").find((model) => model.id === "claude-fable-5");
    expect(upstreamFable).toBeDefined();

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-fable-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        modelOverrides?: Record<string, {
          contextWindow?: number;
          maxTokens?: number;
          thinkingLevelMap?: Record<string, string | null>;
        }>;
        models?: Array<{ id: string }>;
      }>;
    };

    expect(projection.providers.anthropic?.modelOverrides?.["claude-fable-5"]).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    });
    expect(projection.providers.anthropic?.models?.map((model) => model.id) ?? []).not.toContain("claude-fable-5");

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => {
        contextWindow?: number;
        maxTokens?: number;
        cost?: unknown;
        compat?: Record<string, unknown>;
        thinkingLevelMap?: Record<string, string | null>;
      } | undefined;
    };
    const projectedFable = registry.find("anthropic", "claude-fable-5");

    expect(registry.getError()).toBeUndefined();
    expect(projectedFable).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true },
    });
    expect(projectedFable?.cost).toEqual(upstreamFable?.cost);
  });

  it("projects pending Opus 5 with adaptive-thinking compatibility metadata", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );
    expect(getModels("anthropic").some((model) => model.id === "claude-opus-5")).toBe(false);

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-opus5-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        models?: Array<{
          id: string;
          contextWindow?: number;
          maxTokens?: number;
          thinkingLevelMap?: Record<string, string | null>;
          cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
          compat?: Record<string, unknown>;
        }>;
      }>;
    };
    const projectedOpus5 = projection.providers.anthropic?.models?.find((model) => model.id === "claude-opus-5");

    expect(projectedOpus5).toMatchObject({
      id: "claude-opus-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => {
        contextWindow?: number;
        maxTokens?: number;
        cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
        compat?: Record<string, unknown>;
        thinkingLevelMap?: Record<string, string | null>;
      } | undefined;
    };
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("anthropic", "claude-opus-5")).toMatchObject({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    });
    expect(registry.find("anthropic", "claude-opus-5")?.thinkingLevelMap).not.toHaveProperty("off");
  });

  it("adds user-selected OpenRouter models as a custom provider merge block", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });
    await addOpenRouterModel(dataDir, {
      modelId: "anthropic/claude-3.5-sonnet",
      displayName: "Claude 3.5 Sonnet",
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      supportsReasoning: true,
      supportedReasoningLevels: ["none", "low", "medium", "high"],
      inputModes: ["text", "image"],
      addedAt: "2026-04-03T00:00:00.000Z",
    });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: Array<{ id: string; name?: string }> }>;
    };

    expect(projection.providers.openrouter).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "$OPENROUTER_API_KEY",
      api: "openai-completions",
    });
    expect(projection.providers.openrouter?.models).toEqual([
      expect.objectContaining({
        id: "anthropic/claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
      }),
    ]);

    const registry = new (ModelRegistry as unknown as new (...args: unknown[]) => unknown)(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => { api?: string; contextWindow?: number } | undefined;
    };
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openrouter", "anthropic/claude-3.5-sonnet")?.contextWindow).toBe(200_000);
    expect(registry.find("openrouter", "anthropic/claude-3.5-sonnet")?.api).toBe("openai-completions");
    expect(modelRegistryMockState.construct).toHaveBeenCalledWith(authStorageStub, projectionPath);
  });

  it("projects catalog-only built-in Anthropic models missing from Pi upstream through ModelRegistry", async () => {
    const { ModelRegistry: RealModelRegistry } = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
      "@earendil-works/pi-coding-agent",
    );

    const upstreamAnthropicIds = new Set(getModels("anthropic").map((model) => model.id));
    if (upstreamAnthropicIds.has("claude-opus-4-8") && upstreamAnthropicIds.has("claude-sonnet-5")) {
      return;
    }

    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-opus48-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });

    const projectionPath = await generatePiProjection(dataDir);
    const projection = JSON.parse(await readFile(projectionPath, "utf8")) as {
      providers: Record<string, {
        modelOverrides?: Record<string, unknown>;
        models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }>;
      }>;
    };

    if (!upstreamAnthropicIds.has("claude-opus-4-8")) {
      expect(projection.providers.anthropic?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          }),
        ]),
      );
      expect(projection.providers.anthropic?.modelOverrides?.["claude-opus-4-8"]).toBeUndefined();
    }

    if (!upstreamAnthropicIds.has("claude-sonnet-5")) {
      expect(projection.providers.anthropic?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          }),
        ]),
      );
      expect(projection.providers.anthropic?.modelOverrides?.["claude-sonnet-5"]).toBeUndefined();
    }

    const registry = new RealModelRegistry(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => { contextWindow?: number; maxTokens?: number } | undefined;
    };

    expect(registry.getError()).toBeUndefined();
    if (!upstreamAnthropicIds.has("claude-opus-4-8")) {
      expect(registry.find("anthropic", "claude-opus-4-8")).toMatchObject({
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
    }
    if (!upstreamAnthropicIds.has("claude-sonnet-5")) {
      expect(registry.find("anthropic", "claude-sonnet-5")).toMatchObject({
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
    }
  });

  it("keeps disabled curated models in the projection so existing configs retain Forge-owned runtime behavior", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "grok-4": { enabled: false },
        "gpt-5.6-sol": { enabled: false },
        "gpt-5.6-terra": { enabled: false },
        "gpt-5.6-luna": { enabled: false },
        "gpt-5.5": { enabled: false },
      },
    });

    const projectionPath = await generatePiProjection(dataDir);
    const registry = new (ModelRegistry as unknown as new (...args: unknown[]) => unknown)(authStorageStub as any, projectionPath) as {
      getError: () => unknown;
      find: (provider: string, modelId: string) => { api?: string; contextWindow?: number } | undefined;
    };

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("xai", "grok-4")?.api).toBe("openai-responses");
    expect(registry.find("xai", "grok-4")?.contextWindow).toBe(256_000);
    for (const modelId of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(registry.find("openai-codex", modelId)?.contextWindow).toBe(272_000);
    }
    expect(registry.find("openai-codex", "gpt-5.5")?.contextWindow).toBe(272_000);
    expect(modelRegistryMockState.construct).toHaveBeenCalledWith(authStorageStub, projectionPath);
  });
});
