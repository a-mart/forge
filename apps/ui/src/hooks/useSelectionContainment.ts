import { useCallback, type RefObject } from 'react'

/**
 * Prevents text selection from escaping a container element during drag-select.
 * Sets user-select: none on documentElement during active pointer drag,
 * with user-select: text on the container to allow internal selection.
 */
export function useSelectionContainment(containerRef: RefObject<HTMLElement | null>) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const container = containerRef.current
      if (!container) return

      document.documentElement.style.userSelect = 'none'
      container.style.userSelect = 'text'

      const cleanup = () => {
        document.documentElement.style.userSelect = ''
        container.style.userSelect = ''
        document.removeEventListener('pointerup', cleanup)
      }
      document.addEventListener('pointerup', cleanup)
    },
    [containerRef],
  )

  return { onPointerDown }
}
