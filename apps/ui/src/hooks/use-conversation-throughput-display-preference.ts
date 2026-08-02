import { useCallback, useSyncExternalStore } from 'react'
import {
  CONVERSATION_THROUGHPUT_DISPLAY_KEY,
  PREFERENCE_CHANGE_EVENT,
  readConversationThroughputDisplayPref,
  storeConversationThroughputDisplayPref,
} from '@/lib/sidebar-prefs'

const getServerSnapshot = (): boolean => false

function subscribe(onStoreChange: () => void): () => void {
  const onPreferenceChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key?: string }>).detail
    if (detail?.key === CONVERSATION_THROUGHPUT_DISPLAY_KEY) onStoreChange()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === CONVERSATION_THROUGHPUT_DISPLAY_KEY) onStoreChange()
  }

  window.addEventListener(PREFERENCE_CHANGE_EVENT, onPreferenceChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PREFERENCE_CHANGE_EVENT, onPreferenceChange)
    window.removeEventListener('storage', onStorage)
  }
}

/**
 * Browser-wide preference for conversation throughput presentation only.
 * A deterministic false server snapshot prevents stored browser state from
 * mismatching SSR markup; React refreshes the browser snapshot after hydration.
 * Telemetry and Stats history never depend on this preference.
 */
export function useConversationThroughputDisplayPreference(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribe,
    readConversationThroughputDisplayPref,
    getServerSnapshot,
  )

  const setPreference = useCallback((nextEnabled: boolean) => {
    storeConversationThroughputDisplayPref(nextEnabled)
  }, [])

  return [enabled, setPreference]
}
