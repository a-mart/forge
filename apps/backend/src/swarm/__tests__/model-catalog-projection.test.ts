import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getModels } from "@mariozechner/pi-ai";
import { ModelRegistry } from "@mariozechner/pi-coding-agent";
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
      providers: Record<string, { api?: string; models?: Array<{ id: string; api?: string; cost?: unknown }> }>;
    };

    const upstreamXaiModelIds = getModels("xai")
      .map((model) => model.id)
      .sort();
    const projectedXaiModels = projection.providers.xai?.models ?? [];

    expect(projectedXaiModels.map((model) => model.id).sort()).toEqual(upstreamXaiModelIds);
    expect(projectedXaiModels.every((model) => model.api === "openai-responses")).toBe(true);
    expect(projection.providers.xai?.api).toBe("openai-responses");

    const upstreamGrok4Fast = getModels("xai").find((model) => model.id === "grok-4-fast");
    expect(projectedXaiModels.find((model) => model.id === "grok-4-fast")?.cost).toEqual(upstreamGrok4Fast?.cost);
    expect(projection.providers.openrouter).toBeUndefined();

    const registry = new ModelRegistry(authStorageStub as any, projectionPath);

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("xai", "grok-4")?.api).toBe("openai-responses");
    expect(registry.find("xai", "grok-4")?.contextWindow).toBe(256_000);
    expect(registry.find("openai-codex", "gpt-5.3-codex")?.contextWindow).toBe(272_000);
    expect(registry.find("openai-codex", "gpt-5.3-codex")?.maxTokens).toBe(128_000);
    expect(registry.find("anthropic", "claude-opus-4-6")?.contextWindow).toBe(1_000_000);
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
      apiKey: "OPENROUTER_API_KEY",
      api: "openai-completions",
    });
    expect(projection.providers.openrouter?.models).toEqual([
      expect.objectContaining({
        id: "anthropic/claude-3.5-sonnet",
        name: "Claude 3.5 Sonnet",
      }),
    ]);

    const registry = new ModelRegistry(authStorageStub as any, projectionPath);
    expect(registry.getError()).toBeUndefined();
    expect(registry.find("openrouter", "anthropic/claude-3.5-sonnet")?.contextWindow).toBe(200_000);
    expect(registry.find("openrouter", "anthropic/claude-3.5-sonnet")?.api).toBe("openai-completions");
  });

  it("keeps disabled curated models in the projection so existing configs retain Forge-owned runtime behavior", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "forge-model-catalog-projection-"));
    const dataDir = join(rootDir, "data");
    await mkdir(dataDir, { recursive: true });
    await writeModelOverrides(dataDir, {
      version: 1,
      overrides: {
        "grok-4": { enabled: false },
        "gpt-5.3-codex": { enabled: false },
      },
    });

    const projectionPath = await generatePiProjection(dataDir);
    const registry = new ModelRegistry(authStorageStub as any, projectionPath);

    expect(registry.getError()).toBeUndefined();
    expect(registry.find("xai", "grok-4")?.api).toBe("openai-responses");
    expect(registry.find("xai", "grok-4")?.contextWindow).toBe(256_000);
    expect(registry.find("openai-codex", "gpt-5.3-codex")?.contextWindow).toBe(272_000);
  });
});
