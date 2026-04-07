import { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { assertPiModelsProjectionAvailable } from "./model-catalog-projection.js";

export function createPiModelRegistry(
  authStorage: ConstructorParameters<typeof ModelRegistry>[0],
  piModelsJsonPath: string,
): ModelRegistry {
  assertPiModelsProjectionAvailable(piModelsJsonPath);
  const modelRegistry = new ModelRegistry(authStorage, piModelsJsonPath);
  const modelRegistryError = modelRegistry.getError?.();
  if (modelRegistryError) {
    throw new Error(modelRegistryError);
  }
  return modelRegistry;
}
