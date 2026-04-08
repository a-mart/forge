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

    case 'playwright_discovery_snapshot':
    case 'playwright_discovery_updated':
      context.updateState({
        playwrightSnapshot: event.snapshot,
        playwrightSettings: event.snapshot.settings,
      })
      return true

    case 'playwright_discovery_settings_updated':
      context.updateState({
        playwrightSettings: event.settings,
        playwrightSnapshot: context.state.playwrightSnapshot
          ? { ...context.state.playwrightSnapshot, settings: event.settings }
          : context.state.playwrightSnapshot,
      })
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

    default:
      return false
  }
}
