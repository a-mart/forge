import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { assertPiModelsProjectionAvailable } from "./model-catalog-projection.js";
import { configureForgeXaiOAuthProxyClient } from "./xai-oauth-proxy-compat.js";

export function createPiModelRegistry(authStorage: AuthStorage, piModelsJsonPath: string): ModelRegistry {
  assertPiModelsProjectionAvailable(piModelsJsonPath);
  configureForgeXaiOAuthProxyClient();
  const modelRegistry = ModelRegistry.create(authStorage, piModelsJsonPath);
  const modelRegistryError = modelRegistry.getError?.();
  if (modelRegistryError) {
    throw new Error(modelRegistryError);
  }
  return modelRegistry;
}
