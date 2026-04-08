import { useCallback, useState } from 'react'
import { HIDE_DISABLED_KEY } from '../types'

/**
 * Manages the "hide disabled" filter toggle, persisted in localStorage.
 */
export function useHideDisabled() {
  const [hideDisabled, setHideDisabled] = useState(() => {
    try {
      return localStorage.getItem(HIDE_DISABLED_KEY) === 'true'
    } catch {
      return false
    }
  })

  const handleToggleHideDisabled = useCallback((checked: boolean) => {
    setHideDisabled(checked)
    try {
      localStorage.setItem(HIDE_DISABLED_KEY, String(checked))
    } catch {
      // Ignore storage errors
    }
  }, [])

  return { hideDisabled, handleToggleHideDisabled }
}
