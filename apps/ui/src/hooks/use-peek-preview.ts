import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hook that adds press-and-hold "quick look" behavior to image thumbnails.
 *
 * - **Quick tap/click** → opens the preview persistently (same as before).
 * - **Press and hold** (≥ `delay` ms) → opens a peek preview that closes on pointer release.
 *
 * Returns `target` (the currently-previewed value, or `null`), `clearTarget` (for the
 * dialog's `onOpenChange`), and `bind(value)` which produces pointer/click event handlers
 * to spread onto each thumbnail button.
 *
 * Generic over `T` so callers can store whatever zoom-target shape they need.
 */
export function usePeekPreview<T>(delay = 250) {
  const [target, setTarget] = useState<T | null>(null)

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peekingRef = useRef(false)
  const suppressClickRef = useRef(false)
  const globalCleanupRef = useRef<(() => void) | null>(null)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      globalCleanupRef.current?.()
    }
  }, [])

  const clearTarget = useCallback(() => setTarget(null), [])

  /**
   * Produce event handlers for a single thumbnail button.
   * `value` is set as the preview target when the preview opens.
   */
  const bind = (value: T) => {
    const open = () => setTarget(value)
    const close = () => setTarget(null)

    return {
      onPointerDown: (e: React.PointerEvent) => {
        // Only primary button (left-click / single touch)
        if (e.button !== 0) return

        // Reset any prior state
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        globalCleanupRef.current?.()
        globalCleanupRef.current = null
        peekingRef.current = false
        suppressClickRef.current = false

        timerRef.current = setTimeout(() => {
          timerRef.current = null
          peekingRef.current = true
          open()

          // When the dialog overlay opens it covers the button, so the button's
          // own onPointerUp may never fire.  Use a window-level listener instead.
          const onGlobalUp = () => {
            globalCleanupRef.current = null
            if (peekingRef.current) {
              peekingRef.current = false
              suppressClickRef.current = true
              close()
            }
          }
          window.addEventListener('pointerup', onGlobalUp, { once: true })
          globalCleanupRef.current = () =>
            window.removeEventListener('pointerup', onGlobalUp)
        }, delay)
      },

      onPointerUp: () => {
        // If the timer hasn't fired yet this was a quick tap — let onClick handle it.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }

        if (peekingRef.current) {
          peekingRef.current = false
          suppressClickRef.current = true
          globalCleanupRef.current?.()
          globalCleanupRef.current = null
          close()
        }
      },

      onPointerLeave: () => {
        // Cancel the long-press timer if we haven't entered peek mode yet.
        // Do NOT close an active peek here — the dialog overlay renders on top
        // of the button which triggers a spurious pointerleave.  The global
        // pointerup listener handles peek dismissal instead.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
      },

      onPointerCancel: () => {
        // Browser terminated the pointer (e.g. native scroll took over).
        // Cancel everything including an active peek.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current)
          timerRef.current = null
        }
        if (peekingRef.current) {
          peekingRef.current = false
          suppressClickRef.current = true
          globalCleanupRef.current?.()
          globalCleanupRef.current = null
          close()
        }
      },

      onClick: (e: React.MouseEvent) => {
        // After a peek we suppress the trailing click to avoid re-opening
        // the dialog persistently.
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          e.preventDefault()
          return
        }
        // Normal quick tap → persistent open
        open()
      },
    }
  }

  return { target, clearTarget, bind }
}
