import type { ModelCacheObservationEntry } from '../ws-state'

export function upsertModelCacheObservation(
  observations: ModelCacheObservationEntry[],
  observation: ModelCacheObservationEntry,
): ModelCacheObservationEntry[] {
  if (!observation.id) {
    return [...observations, observation]
  }

  const existingIdx = observations.findIndex((entry) => entry.id === observation.id)
  if (existingIdx < 0) {
    return [...observations, observation]
  }

  const next = [...observations]
  next[existingIdx] = observation
  return next
}

/** Route bootstrap/live observations based on whether the persisted setting is known yet. */
export function routeModelCacheObservationsForState(options: {
  incoming: ModelCacheObservationEntry[]
  enabled: boolean
  settingLoaded: boolean
  currentObservations: ModelCacheObservationEntry[]
  pendingObservations: ModelCacheObservationEntry[]
  mode: 'replace' | 'upsert'
}): {
  modelCacheObservations: ModelCacheObservationEntry[]
  pendingModelCacheObservations: ModelCacheObservationEntry[]
} {
  const { incoming, enabled, settingLoaded, currentObservations, pendingObservations, mode } = options

  if (!settingLoaded) {
    const nextPending =
      mode === 'replace'
        ? incoming
        : incoming.reduce(
            (list, observation) => upsertModelCacheObservation(list, observation),
            pendingObservations,
          )

    return {
      modelCacheObservations: currentObservations,
      pendingModelCacheObservations: nextPending,
    }
  }

  if (!enabled) {
    return {
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
    }
  }

  const mergedPending =
    mode === 'replace'
      ? incoming
      : incoming.reduce(
          (list, observation) => upsertModelCacheObservation(list, observation),
          pendingObservations,
        )

  return {
    modelCacheObservations:
      mode === 'replace'
        ? mergedPending
        : mergedPending.reduce(
            (list, observation) => upsertModelCacheObservation(list, observation),
            currentObservations,
          ),
    pendingModelCacheObservations: [],
  }
}

export function applyLoadedModelCacheVisualizationSetting(options: {
  enabled: boolean
  currentObservations: ModelCacheObservationEntry[]
  pendingObservations: ModelCacheObservationEntry[]
}): {
  modelCacheVisualizationEnabled: boolean
  modelCacheVisualizationSettingLoaded: boolean
  modelCacheObservations: ModelCacheObservationEntry[]
  pendingModelCacheObservations: ModelCacheObservationEntry[]
} {
  if (!options.enabled) {
    return {
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
      modelCacheObservations: [],
      pendingModelCacheObservations: [],
    }
  }

  return {
    modelCacheVisualizationEnabled: true,
    modelCacheVisualizationSettingLoaded: true,
    modelCacheObservations: options.pendingObservations.reduce(
      (list, observation) => upsertModelCacheObservation(list, observation),
      options.currentObservations,
    ),
    pendingModelCacheObservations: [],
  }
}
