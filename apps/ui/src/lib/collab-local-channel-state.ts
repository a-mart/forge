const STORAGE_PREFIX = 'forge:collab:v1'
const MUTE_STORAGE_SUFFIX = 'muted'
const MUTE_CHANGE_EVENT = 'forge:collab:channel-mute-changed'

export interface CollabChannelMuteChange {
  workspaceId: string
  channelId: string
  muted: boolean
}

export function buildMutedStorageKey(workspaceId: string, channelId: string): string {
  return `${STORAGE_PREFIX}:workspace:${workspaceId}:channel:${channelId}:${MUTE_STORAGE_SUFFIX}`
}

export function isMuted(workspaceId: string, channelId: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(buildMutedStorageKey(workspaceId, channelId)) === 'true'
  } catch {
    return false
  }
}

export function toggleMute(workspaceId: string, channelId: string): boolean {
  const nextMuted = !isMuted(workspaceId, channelId)
  setMuted(workspaceId, channelId, nextMuted)
  return nextMuted
}

export function subscribeToMuteChanges(
  listener: (change: CollabChannelMuteChange) => void,
): () => void {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const handleCustomEvent = (event: Event) => {
    const detail = (event as CustomEvent<CollabChannelMuteChange>).detail
    if (detail) {
      listener(detail)
    }
  }

  const handleStorageEvent = (event: StorageEvent) => {
    if (!event.key) {
      return
    }

    const parsed = parseMutedStorageKey(event.key)
    if (!parsed) {
      return
    }

    listener({
      ...parsed,
      muted: event.newValue === 'true',
    })
  }

  window.addEventListener(MUTE_CHANGE_EVENT, handleCustomEvent as EventListener)
  window.addEventListener('storage', handleStorageEvent)

  return () => {
    window.removeEventListener(MUTE_CHANGE_EVENT, handleCustomEvent as EventListener)
    window.removeEventListener('storage', handleStorageEvent)
  }
}

function setMuted(workspaceId: string, channelId: string, muted: boolean): void {
  if (typeof window === 'undefined') {
    return
  }

  const storageKey = buildMutedStorageKey(workspaceId, channelId)

  try {
    window.localStorage.setItem(storageKey, String(muted))
  } catch {
    // Ignore localStorage write failures.
  }

  window.dispatchEvent(
    new CustomEvent<CollabChannelMuteChange>(MUTE_CHANGE_EVENT, {
      detail: { workspaceId, channelId, muted },
    }),
  )
}

function parseMutedStorageKey(storageKey: string): {
  workspaceId: string
  channelId: string
} | null {
  const match = storageKey.match(/^forge:collab:v1:workspace:(.+):channel:(.+):muted$/)
  if (!match) {
    return null
  }

  return {
    workspaceId: match[1],
    channelId: match[2],
  }
}
