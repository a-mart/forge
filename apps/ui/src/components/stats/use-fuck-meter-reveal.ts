import { useEffect, useState } from 'react'

/** Ephemeral and overview-only: never persist the Easter egg in routes or storage. */
export function useFuckMeterReveal(enabled: boolean) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let streak = 0
    const reset = () => { streak = 0 }
    const onKeyDown = (event: KeyboardEvent) => {
      const editing = event.composedPath().some((target) => target instanceof HTMLElement && (
        target.matches('input, textarea, select, [role="textbox"]') || target.isContentEditable ||
        target.getAttribute('contenteditable') === 'true'
      ))
      if (editing || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) {
        reset()
        return
      }
      if (event.repeat) return
      if (event.key.toLowerCase() !== 'f') {
        reset()
        return
      }
      streak += 1
      if (streak === 4) {
        setVisible(true)
        reset()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', reset)
    }
  }, [enabled])

  return { visible: enabled && visible, hide: () => setVisible(false) }
}
