import type { ManagerWsConfigEventContext } from '../types'
import type { ServerEvent } from '@forge/protocol'

export function handleConfigEvent(
  event: ServerEvent,
  context: ManagerWsConfigEventContext,
): boolean {
  switch (event.type) {
    case 'profiles_snapshot':
      context.updateState({ profiles: event.profiles })
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
      if (event.enabled) {
        const sessionAgentId = context.state.targetAgentId ?? context.state.subscribedAgentId
        const hasCachedSnapshot = sessionAgentId
          ? Boolean(context.state.taskSnapshots[sessionAgentId])
          : false

        context.updateState({
          workPlansEnabled: true,
          ...(sessionAgentId && !hasCachedSnapshot
            ? { taskSnapshotLoadingSessionId: sessionAgentId }
            : {}),
        })
      } else {
        context.updateState({
          workPlansEnabled: false,
          taskSnapshots: {},
          taskSnapshotLoadingSessionId: null,
        })
      }
      return true

    case 'model_cache_visualization_settings_changed':
      context.updateState({
        modelCacheVisualizationEnabled: event.enabled,
        ...(event.enabled ? {} : { modelCacheObservations: [] }),
      })
      return true

    default:
      return false
  }
}
