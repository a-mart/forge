import { useCallback, useEffect, useState } from 'react'
import {
  PREFERENCE_CHANGE_EVENT,
  readConversationThroughputDisplayPref,
  storeConversationThroughputDisplayPref,
} from '@/lib/sidebar-prefs'

/**
 * Browser-wide preference for conversation throughput presentation only.
 * Telemetry and Stats history never depend on this preference.
 */
export function useConversationThroughputDisplayPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => readConversationThroughputDisplayPref())

  useEffect(() => {
    const hydrate = () => setEnabled(readConversationThroughputDisplayPref())
    window.addEventListener(PREFERENCE_CHANGE_EVENT, hydrate)
    window.addEventListener('storage', hydrate)
    return () => {
      window.removeEventListener(PREFERENCE_CHANGE_EVENT, hydrate)
      window.removeEventListener('storage', hydrate)
    }
  }, [])

  const setPreference = useCallback((nextEnabled: boolean) => {
    storeConversationThroughputDisplayPref(nextEnabled)
    setEnabled(nextEnabled)
  }, [])

  return [enabled, setPreference]
}
