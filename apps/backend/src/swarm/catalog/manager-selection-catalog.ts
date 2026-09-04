import { createHash } from "node:crypto";
import {
  DEFAULT_MANAGER_POSTURE,
  FORGE_MODEL_CATALOG,
  MANAGER_SELECTION_CATALOG_LIMITS,
  MANAGER_SELECTION_CATALOG_VERSION,
  WORK_MODE_DEFINITIONS,
  type ManagerModelOption,
  type ManagerModelSurface,
  type ManagerModelSurfaceState,
  type ManagerSelectionCatalogResponse,
  type ManagerSelectionReasoningOption,
  type WorkModeOption,
} from "@forge/protocol";
import {
  evaluateExactManagerModelSelection,
  type ManagerModelEligibilityResult,
} from "./manager-model-selection.js";
import { modelCatalogService } from "./model-catalog-service.js";
import { DEFAULT_SWARM_MODEL_PRESET } from "./model-presets.js";

const MANAGER_MODEL_SURFACES = ["create", "change"] as const satisfies readonly ManagerModelSurface[];

type CatalogWithoutRevision = Omit<ManagerSelectionCatalogResponse, "revision">;

/** Build a bounded, deterministic, secret-free projection of manager choices. */
export function buildManagerSelectionCatalog(
  providerAvailability: ReadonlyMap<string, boolean>,
): ManagerSelectionCatalogResponse {
  const baselineOptions = Object.values(FORGE_MODEL_CATALOG.models)
    .map((model) => projectModelOption(model.provider, model.modelId, providerAvailability))
    .filter((option): option is ManagerModelOption => option !== undefined)
    .sort(compareModelOptions);

  // Enumerate effective provider rows so discovered-only models are evaluated
  // (and omitted as worker/specialist-only) by the same authority as commands.
  // Baseline exact identities remain first so bounded dynamic inventory can
  // never crowd checked-in manager choices out of the response.
  const baselineKeys = new Set(
    Object.values(FORGE_MODEL_CATALOG.models).map((model) => exactModelKey(model.provider, model.modelId)),
  );
  const discoveredOptions = modelCatalogService.getAllProviders()
    .flatMap((provider) => modelCatalogService.getModelsForProvider(provider.providerId))
    .filter((model) => !baselineKeys.has(exactModelKey(model.provider, model.modelId)))
    .map((model) => projectModelOption(model.provider, model.modelId, providerAvailability))
    .filter((option): option is ManagerModelOption => option !== undefined)
    .sort(compareModelOptions);
  const openRouterOptions = modelCatalogService.getOpenRouterModels()
    .map((model) => projectModelOption("openrouter", model.modelId, providerAvailability))
    .filter((option): option is ManagerModelOption => option !== undefined)
    .sort(compareModelOptions);

  const models = deduplicateOptions([
    ...baselineOptions,
    ...discoveredOptions,
    ...openRouterOptions,
  ]).slice(0, MANAGER_SELECTION_CATALOG_LIMITS.maxModels);
  const workModes = buildWorkModeOptions();
  const defaults = {
    ...buildCreateManagerModelDefault(models, providerAvailability),
    workModeId: DEFAULT_MANAGER_POSTURE,
  };
  const content: CatalogWithoutRevision = {
    version: MANAGER_SELECTION_CATALOG_VERSION,
    models,
    workModes,
    defaults,
  };

  return {
    ...content,
    revision: buildCatalogRevision(content),
  };
}

function projectModelOption(
  provider: string,
  modelId: string,
  providerAvailability: ReadonlyMap<string, boolean>,
): ManagerModelOption | undefined {
  const evaluations = Object.fromEntries(
    MANAGER_MODEL_SURFACES.map((surface) => [
      surface,
      evaluateExactManagerModelSelection(
        { provider, modelId },
        { surface, providerAvailability },
      ),
    ]),
  ) as Record<ManagerModelSurface, ManagerModelEligibilityResult>;
  const metadata = evaluations.create.metadata ?? evaluations.change.metadata;
  if (!metadata || !isMetadataWithinBounds(metadata)) {
    return undefined;
  }

  const reasoningOptions = buildReasoningOptions(metadata.supportedReasoningLevels);
  if (
    reasoningOptions.length === 0
    || !reasoningOptions.some((option) => option.id === metadata.defaultReasoningLevel)
  ) {
    return undefined;
  }

  const surfaces: ManagerModelOption["surfaces"] = {};
  for (const surface of MANAGER_MODEL_SURFACES) {
    const state = projectSurfaceState(evaluations[surface], metadata.source);
    if (state) surfaces[surface] = state;
  }
  if (Object.keys(surfaces).length === 0) {
    return undefined;
  }

  return {
    provider: metadata.provider,
    providerLabel: metadata.providerLabel,
    modelId: metadata.modelId,
    label: metadata.label,
    ...(metadata.familyId ? { familyId: metadata.familyId } : {}),
    ...(metadata.familyLabel ? { familyLabel: metadata.familyLabel } : {}),
    reasoningOptions,
    defaultReasoningId: metadata.defaultReasoningLevel,
    surfaces,
  };
}

function projectSurfaceState(
  evaluation: ManagerModelEligibilityResult,
  source: "catalog" | "openrouter",
): ManagerModelSurfaceState | undefined {
  if (!evaluation.checks || !evaluation.checks.surfaceSupported) {
    return undefined;
  }

  // OpenRouter options are intentionally absent until live tool support and
  // explicit manager opt-in are both true. Once opted in, missing auth is
  // represented as disabled rather than silently dropping the exact ID.
  if (source === "openrouter" && !evaluation.checks.managerEnabled) {
    return undefined;
  }

  if (evaluation.eligible) {
    return { selectable: true };
  }
  if (evaluation.code === "provider_not_configured") {
    return { selectable: false, unavailableReason: "provider_not_configured" };
  }
  if (evaluation.code === "globally_disabled" || evaluation.code === "manager_disabled") {
    return { selectable: false, unavailableReason: "disabled" };
  }
  return undefined;
}

function buildReasoningOptions(
  levels: readonly ManagerSelectionReasoningOption["id"][],
): ManagerSelectionReasoningOption[] {
  const uniqueLevels = [...new Set(levels)]
    .slice(0, MANAGER_SELECTION_CATALOG_LIMITS.maxReasoningOptionsPerModel);
  return uniqueLevels.map((id) => ({ id, label: reasoningLabel(id, uniqueLevels) }));
}

function reasoningLabel(id: string, supportedLevels: readonly string[]): string {
  if (id === "none") return "None";
  if (id === "low") return "Low";
  if (id === "medium") return "Medium";
  if (id === "high") return "High";
  if (id === "xhigh") return supportedLevels.includes("max") ? "Extra High" : "Max";
  if (id === "max") return "Max";
  if (id === "ultra") return "Ultra";
  return id;
}

function buildWorkModeOptions(): WorkModeOption[] {
  return WORK_MODE_DEFINITIONS
    .filter((definition) =>
      isBoundedString(definition.id, MANAGER_SELECTION_CATALOG_LIMITS.maxWorkModeIdLength)
      && isBoundedString(definition.label, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
      && isBoundedString(definition.description, MANAGER_SELECTION_CATALOG_LIMITS.maxDescriptionLength),
    )
    .slice(0, MANAGER_SELECTION_CATALOG_LIMITS.maxWorkModes)
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      selectable: definition.selectable,
    }));
}

function buildCreateManagerModelDefault(
  models: readonly ManagerModelOption[],
  providerAvailability: ReadonlyMap<string, boolean>,
): Pick<ManagerSelectionCatalogResponse["defaults"], "createManagerModel"> {
  const descriptor = modelCatalogService.resolveModelDescriptorFromFamily(DEFAULT_SWARM_MODEL_PRESET);
  if (!descriptor) return {};

  const evaluation = evaluateExactManagerModelSelection(descriptor, {
    surface: "create",
    providerAvailability,
  });
  if (!evaluation.eligible) return {};

  const option = models.find((candidate) =>
    candidate.provider === evaluation.descriptor.provider
    && candidate.modelId === evaluation.descriptor.modelId
    && candidate.surfaces.create?.selectable === true
    && candidate.reasoningOptions.some((reasoning) => reasoning.id === evaluation.descriptor.thinkingLevel),
  );
  if (!option) return {};

  return {
    createManagerModel: {
      provider: evaluation.descriptor.provider,
      modelId: evaluation.descriptor.modelId,
      reasoningId: evaluation.descriptor.thinkingLevel as ManagerSelectionReasoningOption["id"],
    },
  };
}

function isMetadataWithinBounds(
  metadata: NonNullable<ManagerModelEligibilityResult["metadata"]>,
): boolean {
  return isBoundedString(metadata.provider, MANAGER_SELECTION_CATALOG_LIMITS.maxProviderIdLength)
    && isBoundedString(metadata.providerLabel, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
    && isBoundedString(metadata.modelId, MANAGER_SELECTION_CATALOG_LIMITS.maxModelIdLength)
    && isBoundedString(metadata.label, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
    && (metadata.familyId === undefined
      || isBoundedString(metadata.familyId, MANAGER_SELECTION_CATALOG_LIMITS.maxFamilyIdLength))
    && (metadata.familyLabel === undefined
      || isBoundedString(metadata.familyLabel, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength));
}

function isBoundedString(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

function deduplicateOptions(options: readonly ManagerModelOption[]): ManagerModelOption[] {
  const byExactIdentity = new Map<string, ManagerModelOption>();
  for (const option of options) {
    const key = exactModelKey(option.provider, option.modelId);
    if (!byExactIdentity.has(key)) byExactIdentity.set(key, option);
  }
  return [...byExactIdentity.values()];
}

function exactModelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function compareModelOptions(left: ManagerModelOption, right: ManagerModelOption): number {
  return compareStrings(left.provider, right.provider) || compareStrings(left.modelId, right.modelId);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildCatalogRevision(content: CatalogWithoutRevision): string {
  // Hash only the already member-readable projection. Credential values,
  // summaries, costs, paths, and Pi projection metadata never enter this input.
  const digest = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return `msc-v${MANAGER_SELECTION_CATALOG_VERSION}-${digest}`;
}
