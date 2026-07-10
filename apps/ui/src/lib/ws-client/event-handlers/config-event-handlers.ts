import { applyLoadedModelCacheVisualizationSetting } from '../model-cache-visualization-state.js'
import type { ManagerWsConfigEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleConfigEvent(
  event: ServerEvent,
  context: ManagerWsConfigEventContext,
): boolean {
  switch (event.type) {
    case 'profiles_snapshot':
      context.updateState({
        profiles: event.profiles,
        hasReceivedProfilesSnapshot: true,
      })
      return true

    case 'telegram_status':
      context.updateState({ telegramStatus: event })
      return true

    case 'prompt_changed':
    case 'cortex_prompt_surface_changed':
      context.updateState({ promptChangeKey: context.state.promptChangeKey + 1 })
      return true

    case 'specialist_roster_changed':
      context.updateState({ specialistChangeKey: context.state.specialistChangeKey + 1 })
      return true

    case 'model_config_changed':
      context.updateState({ modelConfigChangeKey: context.state.modelConfigChangeKey + 1 })
      return true

    case 'work_plans_settings_changed':
      context.updateState({
        workPlansEnabled: false,
        taskSnapshots: {},
        taskSnapshotLoadingSessionId: null,
      })
      return true

    case 'model_cache_visualization_settings_changed':
      context.updateState(
        applyLoadedModelCacheVisualizationSetting({
          enabled: event.enabled,
          currentObservations: context.state.modelCacheObservations,
          pendingObservations: context.state.pendingModelCacheObservations,
        }),
      )
      return true

    default:
      return false
  }
}
