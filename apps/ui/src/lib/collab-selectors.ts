import type { CollabWsState } from './collab-ws-state'
import { isMuted as isMutedLocally } from './collab-local-channel-state'

export function getChannelUnreadCount(state: CollabWsState, channelId: string): number {
  return state.channelUnreadCounts[channelId] ?? 0
}

export function getCategoryUnreadCount(state: CollabWsState, categoryId: string): number {
  return state.channels.reduce((total, channel) => {
    if (channel.categoryId !== categoryId) {
      return total
    }

    return total + getChannelUnreadCount(state, channel.channelId)
  }, 0)
}

export function isChannelMuted(
  state: Pick<CollabWsState, 'workspace'>,
  channelId: string,
): boolean {
  const workspaceId = state.workspace?.workspaceId
  return workspaceId ? isMutedLocally(workspaceId, channelId) : false
}
