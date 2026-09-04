import {
  MANAGER_MODEL_UNAVAILABLE_REASONS,
  MANAGER_REASONING_LEVELS,
  MANAGER_SELECTION_CATALOG_LIMITS,
  MANAGER_SELECTION_CATALOG_VERSION,
  WORK_MODE_UNAVAILABLE_REASONS,
  isWorkModeId,
  type ManagerModelOption,
  type ManagerModelSurface,
  type ManagerModelSurfaceState,
  type ManagerModelUnavailableReason,
  type ManagerReasoningLevel,
  type ManagerSelectionCatalogDefaults,
  type ManagerSelectionCatalogResponse,
  type ManagerSelectionReasoningOption,
  type WorkModeId,
  type WorkModeOption,
  type WorkModeUnavailableReason,
} from '@forge/protocol'
import {
  encodeManagerModelValue,
  type ManagerModelSelectRow,
} from '@/lib/manager-model-selection'

export const MANAGER_SELECTION_CATALOG_DECODE_ERROR = 'Invalid manager selection catalog'
const GENERIC_REASONING_LEVELS: ManagerReasoningLevel[] = ['none', 'low', 'medium', 'high', 'xhigh']
const CURRENT_UNAVAILABLE_REASON = 'Not available for selection'
const PROVIDER_UNAVAILABLE_REASON = 'Provider not configured'

export class ManagerSelectionCatalogDecodeError extends Error {
  constructor(message = MANAGER_SELECTION_CATALOG_DECODE_ERROR) {
    super(message)
    this.name = 'ManagerSelectionCatalogDecodeError'
  }
}

/** Decode one validated V1 snapshot. Never merges bundled client inventories. */
export function decodeManagerSelectionCatalog(value: unknown): ManagerSelectionCatalogResponse {
  if (!isRecord(value)) {
    throw new ManagerSelectionCatalogDecodeError()
  }
  if (value.version !== MANAGER_SELECTION_CATALOG_VERSION) {
    throw new ManagerSelectionCatalogDecodeError('Unsupported manager selection catalog version')
  }
  if (!isBoundedString(value.revision, MANAGER_SELECTION_CATALOG_LIMITS.maxRevisionLength)) {
    throw new ManagerSelectionCatalogDecodeError()
  }
  if (!Array.isArray(value.models) || !Array.isArray(value.workModes) || !isRecord(value.defaults)) {
    throw new ManagerSelectionCatalogDecodeError()
  }

  if (
    value.models.length > MANAGER_SELECTION_CATALOG_LIMITS.maxModels
    || value.workModes.length > MANAGER_SELECTION_CATALOG_LIMITS.maxWorkModes
  ) {
    throw new ManagerSelectionCatalogDecodeError()
  }

  const models = value.models.map(decodeModelOption)
  const workModes = value.workModes.map(decodeWorkModeOption)
  const defaults = decodeDefaults(value.defaults)
  if (
    models.some((model) => model === undefined)
    || workModes.some((workMode) => workMode === undefined)
    || !defaults
  ) {
    throw new ManagerSelectionCatalogDecodeError()
  }

  const decodedModels = models as ManagerModelOption[]
  const decodedWorkModes = workModes as WorkModeOption[]
  if (
    hasDuplicateModelIdentity(decodedModels)
    || hasDuplicateWorkModeId(decodedWorkModes)
    || !defaultsReferenceCatalog(defaults, decodedModels, decodedWorkModes)
  ) {
    throw new ManagerSelectionCatalogDecodeError()
  }

  return {
    version: MANAGER_SELECTION_CATALOG_VERSION,
    revision: value.revision,
    models: decodedModels,
    workModes: decodedWorkModes,
    defaults,
  }
}

export function projectManagerModelRows(
  catalog: ManagerSelectionCatalogResponse,
  surface: ManagerModelSurface,
): ManagerModelSelectRow[] {
  const rows: ManagerModelSelectRow[] = []
  for (const model of catalog.models) {
    const row = projectModelRow(model, surface)
    if (row) rows.push(row)
  }
  return rows
}

export function projectSelectableManagerModelRows(
  catalog: ManagerSelectionCatalogResponse,
  surface: ManagerModelSurface,
): ManagerModelSelectRow[] {
  return projectManagerModelRows(catalog, surface).filter((row) => !row.unavailableReason)
}

export function findCatalogModel(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  provider: string,
  modelId: string,
): ManagerModelOption | undefined {
  if (!catalog) return undefined
  return catalog.models.find((model) => model.provider === provider && model.modelId === modelId)
}

/**
 * Preserve an effective current model that is absent from this surface's
 * selectable inventory. Labels come from the same snapshot when present.
 */
export function buildCatalogCurrentModelFallbackRow(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  provider: string,
  modelId: string,
  thinkingLevel?: string,
): ManagerModelSelectRow {
  const option = findCatalogModel(catalog, provider, modelId)
  if (option) {
    return {
      key: encodeManagerModelValue(option.provider, option.modelId),
      provider: option.provider,
      providerDisplayName: option.providerLabel,
      familyId: option.familyId ?? 'unknown',
      familyDisplayName: option.familyLabel ?? 'Other',
      modelId: option.modelId,
      displayName: option.label,
      supportedReasoningLevels: option.reasoningOptions.map((option) => option.id),
      defaultReasoningLevel: option.defaultReasoningId,
      unavailableReason: CURRENT_UNAVAILABLE_REASON,
    }
  }

  const normalizedThinking = normalizeReasoningLevel(thinkingLevel)
  return {
    key: encodeManagerModelValue(provider, modelId),
    provider,
    providerDisplayName: provider,
    familyId: 'unknown',
    familyDisplayName: 'Other',
    modelId,
    displayName: modelId,
    supportedReasoningLevels: GENERIC_REASONING_LEVELS,
    defaultReasoningLevel: normalizedThinking ?? 'high',
    unavailableReason: CURRENT_UNAVAILABLE_REASON,
  }
}

export function resolveCreateManagerDefault(
  catalog: ManagerSelectionCatalogResponse,
  availableRows: readonly ManagerModelSelectRow[],
): { provider: string; modelId: string; reasoningLevel: ManagerReasoningLevel } | undefined {
  const advertised = catalog.defaults.createManagerModel
  if (!advertised) return undefined

  const advertisedRow = availableRows.find((row) =>
    row.provider === advertised.provider && row.modelId === advertised.modelId
  )
  if (!advertisedRow) return undefined

  const reasoningLevel = advertisedRow.supportedReasoningLevels.includes(advertised.reasoningId)
    ? advertised.reasoningId
    : advertisedRow.defaultReasoningLevel
  return {
    provider: advertisedRow.provider,
    modelId: advertisedRow.modelId,
    reasoningLevel,
  }
}

export function catalogModelLabel(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  provider: string,
  modelId: string,
): string {
  return findCatalogModel(catalog, provider, modelId)?.label ?? modelId
}

export function catalogReasoningLevels(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  provider: string,
  modelId: string,
): ManagerReasoningLevel[] | undefined {
  const option = findCatalogModel(catalog, provider, modelId)
  return option?.reasoningOptions.map((reasoning) => reasoning.id)
}

export function workModeLabel(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  id: string | undefined,
): string {
  if (!id) return 'Work mode'
  const advertised = catalog?.workModes.find((workMode) => workMode.id === id)
  if (advertised) return advertised.label
  return formatUnknownWorkModeId(id)
}

export function projectWorkModeOptions(
  catalog: ManagerSelectionCatalogResponse | null | undefined,
  currentId: string | undefined,
): WorkModeOption[] {
  const advertised = catalog?.workModes ?? []
  if (!currentId) return advertised
  if (advertised.some((workMode) => workMode.id === currentId)) return advertised
  return [
    ...advertised,
    {
      id: currentId,
      label: formatUnknownWorkModeId(currentId),
      description: '',
      selectable: false,
      unavailableReason: 'unsupported',
    },
  ]
}

function projectModelRow(
  model: ManagerModelOption,
  surface: ManagerModelSurface,
): ManagerModelSelectRow | undefined {
  const state = model.surfaces[surface]
  if (!state) return undefined
  return {
    key: encodeManagerModelValue(model.provider, model.modelId),
    provider: model.provider,
    providerDisplayName: model.providerLabel,
    familyId: model.familyId ?? 'unknown',
    familyDisplayName: model.familyLabel ?? model.providerLabel,
    modelId: model.modelId,
    displayName: model.label,
    supportedReasoningLevels: model.reasoningOptions.map((option) => option.id),
    defaultReasoningLevel: model.defaultReasoningId,
    ...(state.selectable ? {} : { unavailableReason: unavailableReasonLabel(state.unavailableReason) }),
  }
}

function unavailableReasonLabel(reason: ManagerModelUnavailableReason | undefined): string {
  if (reason === 'provider_not_configured') return PROVIDER_UNAVAILABLE_REASON
  return CURRENT_UNAVAILABLE_REASON
}

function decodeModelOption(value: unknown): ManagerModelOption | undefined {
  if (!isRecord(value)) return undefined
  if (
    !isBoundedString(value.provider, MANAGER_SELECTION_CATALOG_LIMITS.maxProviderIdLength)
    || !isBoundedString(value.providerLabel, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
    || !isBoundedString(value.modelId, MANAGER_SELECTION_CATALOG_LIMITS.maxModelIdLength)
    || !isBoundedString(value.label, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
  ) {
    return undefined
  }
  if (value.familyId !== undefined && !isBoundedString(value.familyId, MANAGER_SELECTION_CATALOG_LIMITS.maxFamilyIdLength)) {
    return undefined
  }
  if (value.familyLabel !== undefined && !isBoundedString(value.familyLabel, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)) {
    return undefined
  }
  if (
    value.description !== undefined
    && !isBoundedString(value.description, MANAGER_SELECTION_CATALOG_LIMITS.maxDescriptionLength)
  ) {
    return undefined
  }
  if (!Array.isArray(value.reasoningOptions) || typeof value.defaultReasoningId !== 'string') {
    return undefined
  }

  if (value.reasoningOptions.length > MANAGER_SELECTION_CATALOG_LIMITS.maxReasoningOptionsPerModel) {
    return undefined
  }
  const decodedReasoningOptions = value.reasoningOptions.map(decodeReasoningOption)
  if (decodedReasoningOptions.some((option) => option === undefined)) return undefined
  const reasoningOptions = decodedReasoningOptions as ManagerSelectionReasoningOption[]
  if (
    reasoningOptions.length === 0
    || new Set(reasoningOptions.map((option) => option.id)).size !== reasoningOptions.length
    || !reasoningOptions.some((option) => option.id === value.defaultReasoningId)
  ) {
    return undefined
  }

  const surfaces = decodeSurfaces(value.surfaces)
  if (!surfaces) return undefined

  return {
    provider: value.provider,
    providerLabel: value.providerLabel,
    modelId: value.modelId,
    label: value.label,
    ...(typeof value.familyId === 'string' ? { familyId: value.familyId } : {}),
    ...(typeof value.familyLabel === 'string' ? { familyLabel: value.familyLabel } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    reasoningOptions,
    defaultReasoningId: value.defaultReasoningId as ManagerReasoningLevel,
    surfaces,
  }
}

function decodeReasoningOption(value: unknown): ManagerSelectionReasoningOption | undefined {
  if (!isRecord(value) || !isManagerReasoningLevel(value.id)) return undefined
  if (!isBoundedString(value.label, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)) return undefined
  return { id: value.id, label: value.label }
}

function decodeSurfaces(value: unknown): ManagerModelOption['surfaces'] | undefined {
  if (!isRecord(value)) return undefined
  const surfaces: ManagerModelOption['surfaces'] = {}
  for (const surface of ['create', 'change'] as const) {
    if (value[surface] === undefined) continue
    const state = decodeSurfaceState(value[surface])
    if (!state) return undefined
    surfaces[surface] = state
  }
  if (Object.keys(surfaces).length === 0) return undefined
  return surfaces
}

function decodeSurfaceState(value: unknown): ManagerModelSurfaceState | undefined {
  if (!isRecord(value) || typeof value.selectable !== 'boolean') return undefined
  if (value.selectable) {
    if (value.unavailableReason !== undefined) return undefined
    return { selectable: true }
  }
  if (!isManagerModelUnavailableReason(value.unavailableReason)) return undefined
  return {
    selectable: false,
    unavailableReason: value.unavailableReason,
  }
}

function decodeWorkModeOption(value: unknown): WorkModeOption | undefined {
  if (!isRecord(value) || !isWorkModeId(value.id)) return undefined
  if (
    !isBoundedString(value.label, MANAGER_SELECTION_CATALOG_LIMITS.maxLabelLength)
    || !isBoundedString(value.description, MANAGER_SELECTION_CATALOG_LIMITS.maxDescriptionLength)
    || typeof value.selectable !== 'boolean'
  ) {
    return undefined
  }
  if (value.selectable) {
    if (value.unavailableReason !== undefined) return undefined
    return {
      id: value.id,
      label: value.label,
      description: value.description,
      selectable: true,
    }
  }
  if (!isWorkModeUnavailableReason(value.unavailableReason)) return undefined
  return {
    id: value.id,
    label: value.label,
    description: value.description,
    selectable: false,
    unavailableReason: value.unavailableReason,
  }
}

function decodeDefaults(value: Record<string, unknown>): ManagerSelectionCatalogDefaults | undefined {
  if (!isWorkModeId(value.workModeId)) return undefined
  if (value.createManagerModel === undefined) {
    return { workModeId: value.workModeId }
  }
  if (!isRecord(value.createManagerModel)) return undefined
  const createManagerModel = value.createManagerModel
  if (
    !isBoundedString(createManagerModel.provider, MANAGER_SELECTION_CATALOG_LIMITS.maxProviderIdLength)
    || !isBoundedString(createManagerModel.modelId, MANAGER_SELECTION_CATALOG_LIMITS.maxModelIdLength)
    || !isManagerReasoningLevel(createManagerModel.reasoningId)
  ) {
    return undefined
  }
  return {
    workModeId: value.workModeId,
    createManagerModel: {
      provider: createManagerModel.provider,
      modelId: createManagerModel.modelId,
      reasoningId: createManagerModel.reasoningId,
    },
  }
}

function hasDuplicateModelIdentity(models: readonly ManagerModelOption[]): boolean {
  const identities = models.map((model) => `${model.provider}\u0000${model.modelId}`)
  return new Set(identities).size !== identities.length
}

function hasDuplicateWorkModeId(workModes: readonly WorkModeOption[]): boolean {
  const ids = workModes.map((workMode) => workMode.id)
  return new Set(ids).size !== ids.length
}

function defaultsReferenceCatalog(
  defaults: ManagerSelectionCatalogDefaults,
  models: readonly ManagerModelOption[],
  workModes: readonly WorkModeOption[],
): boolean {
  const defaultWorkMode = workModes.find((workMode) => workMode.id === defaults.workModeId)
  if (!defaultWorkMode?.selectable) return false

  const modelDefault = defaults.createManagerModel
  if (!modelDefault) return true
  const model = models.find((candidate) =>
    candidate.provider === modelDefault.provider && candidate.modelId === modelDefault.modelId
  )
  return model?.surfaces.create?.selectable === true
    && model.reasoningOptions.some((reasoning) => reasoning.id === modelDefault.reasoningId)
}

function formatUnknownWorkModeId(id: string): string {
  if (id === 'delegation_first') return 'Delegate first'
  if (id === 'adaptive') return 'Adaptive'
  if (id === 'hands_on') return 'Hands-on'
  const words = id.replaceAll(/[_-]+/g, ' ').trim()
  if (!words) return id
  return words.replaceAll(/\b\w/g, (character) => character.toUpperCase())
}

function normalizeReasoningLevel(level: string | undefined): ManagerReasoningLevel | undefined {
  if (!level) return undefined
  const normalized = level === 'x-high' ? 'xhigh' : level
  return isManagerReasoningLevel(normalized) ? normalized : undefined
}

function isManagerReasoningLevel(value: unknown): value is ManagerReasoningLevel {
  return typeof value === 'string' && (MANAGER_REASONING_LEVELS as readonly string[]).includes(value)
}

function isManagerModelUnavailableReason(value: unknown): value is ManagerModelUnavailableReason {
  return typeof value === 'string'
    && (MANAGER_MODEL_UNAVAILABLE_REASONS as readonly string[]).includes(value)
}

function isWorkModeUnavailableReason(value: unknown): value is WorkModeUnavailableReason {
  return typeof value === 'string'
    && (WORK_MODE_UNAVAILABLE_REASONS as readonly string[]).includes(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export type { WorkModeId }
