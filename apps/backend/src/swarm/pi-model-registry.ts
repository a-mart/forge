import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { assertPiModelsProjectionAvailable } from "./model-catalog-projection.js";

export function createPiModelRegistry(
  authStorage: Parameters<typeof ModelRegistry.create>[0],
  piModelsJsonPath: string,
): ModelRegistry {
  assertPiModelsProjectionAvailable(piModelsJsonPath);
  const modelRegistry = ModelRegistry.create(authStorage, piModelsJsonPath);
  const modelRegistryError = modelRegistry.getError?.();
  if (modelRegistryError) {
    throw new Error(modelRegistryError);
  }
  return modelRegistry;
}
