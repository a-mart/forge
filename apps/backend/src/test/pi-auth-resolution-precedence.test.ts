import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "../swarm/pi/pi-ai-compat.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const BUILT_IN_PROVIDER_CASES = [
  { provider: "openai", envName: "OPENAI_API_KEY" },
  { provider: "anthropic", envName: "ANTHROPIC_API_KEY" },
  { provider: "xai", envName: "XAI_API_KEY" },
] as const;

interface ProviderFixture {
  provider: string;
  modelId: string;
  modelsJsonKey: string;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function writePrecedenceModelsFile(): Promise<{
  path: string;
  fixtures: ProviderFixture[];
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-auth-precedence-"));
  const path = join(root, "models.json");
  const fixtures = BUILT_IN_PROVIDER_CASES.map(({ provider }) => {
    const model = getModels(provider)[0];
    if (!model) {
      throw new Error(`Expected a built-in ${provider} model`);
    }
    return {
      provider,
      modelId: model.id,
      modelsJsonKey: `models-json-${provider}-key`,
      baseUrl: model.baseUrl,
    };
  });
  const customFixture = {
    provider: "precedence-custom",
    modelId: "precedence-model",
    modelsJsonKey: "models-json-custom-key",
  };

  await writeFile(path, JSON.stringify({
    providers: {
      ...Object.fromEntries(fixtures.map((fixture) => [
        fixture.provider,
        {
          baseUrl: fixture.baseUrl,
          apiKey: fixture.modelsJsonKey,
        },
      ])),
      [customFixture.provider]: {
        baseUrl: "https://custom.example.test/v1",
        api: "openai-completions",
        apiKey: customFixture.modelsJsonKey,
        models: [{ id: customFixture.modelId }],
      },
    },
  }), "utf8");

  return {
    path,
    fixtures: [
      ...fixtures.map(({ baseUrl: _baseUrl, ...fixture }) => fixture),
      customFixture,
    ],
  };
}

function findFixtureModel(registry: ModelRegistry, fixture: ProviderFixture) {
  const model = registry.find(fixture.provider, fixture.modelId);
  if (!model) {
    throw new Error(`Expected model ${fixture.provider}/${fixture.modelId}`);
  }
  return model;
}

async function resolveRequestKey(
  registry: ModelRegistry,
  fixture: ProviderFixture,
): Promise<string | undefined> {
  const result = await registry.getApiKeyAndHeaders(findFixtureModel(registry, fixture));
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.apiKey;
}

describe("Pi request-auth precedence", () => {
  it.each(BUILT_IN_PROVIDER_CASES)(
    "keeps runtime → stored → environment → models.json ordering for $provider",
    async ({ provider, envName }) => {
      const models = await writePrecedenceModelsFile();
      const fixture = models.fixtures.find((candidate) => candidate.provider === provider)!;
      vi.stubEnv(envName, `environment-${provider}-key`);

      const runtimeStorage = AuthStorage.inMemory({
        [provider]: { type: "api_key", key: `stored-${provider}-key` },
      });
      runtimeStorage.setRuntimeApiKey(provider, `runtime-${provider}-key`);
      const runtimeRegistry = ModelRegistry.create(runtimeStorage, models.path);
      await expect(resolveRequestKey(runtimeRegistry, fixture)).resolves.toBe(`runtime-${provider}-key`);

      const storedRegistry = ModelRegistry.create(AuthStorage.inMemory({
        [provider]: { type: "api_key", key: `stored-${provider}-key` },
      }), models.path);
      await expect(resolveRequestKey(storedRegistry, fixture)).resolves.toBe(`stored-${provider}-key`);

      const environmentRegistry = ModelRegistry.create(AuthStorage.inMemory({}), models.path);
      await expect(resolveRequestKey(environmentRegistry, fixture)).resolves.toBe(`environment-${provider}-key`);

      vi.stubEnv(envName, "");
      const modelsJsonRegistry = ModelRegistry.create(AuthStorage.inMemory({}), models.path);
      await expect(resolveRequestKey(modelsJsonRegistry, fixture)).resolves.toBe(fixture.modelsJsonKey);
    },
  );

  it("keeps runtime → stored → environment → models.json ordering for a custom provider", async () => {
    const models = await writePrecedenceModelsFile();
    const fixture = models.fixtures.find((candidate) => candidate.provider === "precedence-custom")!;

    const runtimeStorage = AuthStorage.inMemory({
      [fixture.provider]: { type: "api_key", key: "stored-custom-key" },
    });
    runtimeStorage.setRuntimeApiKey(fixture.provider, "runtime-custom-key");
    const runtimeRegistry = ModelRegistry.create(runtimeStorage, models.path);
    await expect(resolveRequestKey(runtimeRegistry, fixture)).resolves.toBe("runtime-custom-key");

    const storedRegistry = ModelRegistry.create(AuthStorage.inMemory({
      [fixture.provider]: { type: "api_key", key: "stored-custom-key" },
    }), models.path);
    await expect(resolveRequestKey(storedRegistry, fixture)).resolves.toBe("stored-custom-key");

    // Arbitrary custom provider IDs have no built-in env-map entry. Supply the
    // environment result at the AuthStorage boundary to prove ModelRegistry asks
    // for fallback auth before consulting the models.json literal.
    const environmentStorage = AuthStorage.inMemory({});
    vi.spyOn(environmentStorage, "getApiKey").mockImplementation(async (_provider, options) =>
      options?.includeFallback === false ? undefined : "environment-custom-key");
    const environmentRegistry = ModelRegistry.create(environmentStorage, models.path);
    await expect(resolveRequestKey(environmentRegistry, fixture)).resolves.toBe("environment-custom-key");

    const modelsJsonRegistry = ModelRegistry.create(AuthStorage.inMemory({}), models.path);
    await expect(resolveRequestKey(modelsJsonRegistry, fixture)).resolves.toBe(fixture.modelsJsonKey);
  });
});
