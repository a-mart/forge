import type { ManagerToolActivityEvent } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'

/** Applies only authority for the currently selected manager session. */
export function reduceManagerToolActivity(
  state: ManagerWsState,
  event: ManagerToolActivityEvent,
): Partial<ManagerWsState> | null {
  if (event.sessionAgentId !== state.targetAgentId) return null

  const current = state.managerToolActivity
  if (current && event.revision < current.revision) return null

  return { managerToolActivity: event }
}
