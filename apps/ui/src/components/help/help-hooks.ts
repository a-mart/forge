import { useContext, useEffect } from 'react'
import { HelpContext, type HelpContextValue } from './HelpProvider'

/**
 * Returns the full help context (state + actions).
 * Must be used within a <HelpProvider>.
 */
export function useHelp(): HelpContextValue {
  const context = useContext(HelpContext)

  if (!context) {
    throw new Error('useHelp must be used within a <HelpProvider>')
  }

  return context
}

/**
 * Sets the help context key when the component mounts.
 * This tells the help system which UI surface is currently active,
 * so the drawer shows relevant articles.
 */
export function useHelpContext(contextKey: string): void {
  const { setContextKey } = useHelp()

  useEffect(() => {
    setContextKey(contextKey)
  }, [contextKey, setContextKey])
}

/**
 * Registers global keyboard shortcuts for the help system.
 * Mount once near the app root (e.g. inside HelpProvider consumers).
 *
 * Shortcuts:
 * - Ctrl+/ or ⌘+/: toggle help drawer
 * - ? (when not in input/textarea/select): toggle shortcut overlay
 * - Escape: close drawer or shortcut overlay
 */
export function useHelpHotkeys(): void {
  const { isDrawerOpen, isShortcutOverlayOpen, openDrawer, closeDrawer, toggleShortcutOverlay, closeShortcutOverlay } = useHelp()

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const handler = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const isEditing = target
        ? target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT'
          || target.isContentEditable
        : false

      // Ctrl+/ or ⌘+/ — toggle help drawer
      if (event.code === 'Slash' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        if (isDrawerOpen) {
          closeDrawer()
        } else {
          openDrawer()
        }
        return
      }

      // Escape — close drawer or shortcut overlay
      if (event.code === 'Escape') {
        if (isShortcutOverlayOpen) {
          closeShortcutOverlay()
          return
        }
        if (isDrawerOpen) {
          closeDrawer()
          return
        }
        // Don't prevent default for Escape if nothing to close — let other
        // handlers (e.g. dialog close) handle it.
        return
      }

      // ? — toggle shortcut overlay (only when not editing)
      if (event.key === '?' && !isEditing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        toggleShortcutOverlay()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDrawerOpen, isShortcutOverlayOpen, openDrawer, closeDrawer, toggleShortcutOverlay, closeShortcutOverlay])
}
