import { getModels } from "../swarm/pi/pi-ai-compat.js";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROVIDER_CASES = [
  { provider: "openai", envName: "OPENAI_API_KEY" },
  { provider: "xai", envName: "XAI_API_KEY" },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Pi dynamic provider request routing", () => {
  it.each(PROVIDER_CASES)(
    "keeps a dynamically replaced $provider endpoint paired with its provider key",
    async ({ provider, envName }) => {
      vi.stubEnv(envName, "");
      const builtInModel = getModels(provider)[0];
      if (!builtInModel) {
        throw new Error(`Expected a built-in ${provider} model`);
      }

      const registry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
      const dynamicBaseUrl = `https://${provider}.dynamic-provider.example.test/v1`;
      const dynamicApiKey = `${provider}-dynamic-provider-key`;
      registry.registerProvider(provider, {
        api: builtInModel.api,
        baseUrl: dynamicBaseUrl,
        apiKey: dynamicApiKey,
        models: [{
          id: builtInModel.id,
          name: `${builtInModel.name} (dynamic)`,
        }],
      });

      const model = registry.find(provider, builtInModel.id);
      expect(model?.baseUrl).toBe(dynamicBaseUrl);

      // Credential resolution synchronizes OAuth-sensitive routing at request time.
      // That synchronization must use the dynamic model baseline, not the stale built-in.
      const resolvedAuth = await registry.getApiKeyAndHeaders(model!);
      expect(resolvedAuth).toMatchObject({ ok: true, apiKey: dynamicApiKey });
      expect(model?.baseUrl).toBe(dynamicBaseUrl);
    },
  );

  it.each(PROVIDER_CASES)(
    "does not rewrite a caller-owned $provider model that reuses a built-in ID",
    async ({ provider }) => {
      const builtInModel = getModels(provider)[0];
      if (!builtInModel) {
        throw new Error(`Expected a built-in ${provider} model`);
      }

      const authStorage = AuthStorage.inMemory({});
      const runtimeApiKey = `${provider}-caller-runtime-key`;
      authStorage.setRuntimeApiKey(provider, runtimeApiKey);
      const registry = ModelRegistry.inMemory(authStorage);
      const callerBaseUrl = `https://${provider}.caller-owned.example.test/v1`;
      const callerModel = {
        ...builtInModel,
        baseUrl: callerBaseUrl,
      };

      const resolvedAuth = await registry.getApiKeyAndHeaders(callerModel);
      expect(resolvedAuth).toMatchObject({ ok: true, apiKey: runtimeApiKey });
      expect(callerModel.baseUrl).toBe(callerBaseUrl);
    },
  );
});
