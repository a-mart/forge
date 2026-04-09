import { useCallback, useEffect, useRef, useState } from 'react'
import { useLatestRef } from '../../hooks/useLatestRef'

interface UseResizablePanelOptions {
  /** localStorage key to persist the width */
  storageKey: string
  /** Default width in pixels */
  defaultWidth: number
  /** Minimum width in pixels */
  minWidth: number
  /** Maximum width in pixels */
  maxWidth: number
  /** When true, dragging left increases width (for panels with handles on their left edge) */
  invertDelta?: boolean
}

interface UseResizablePanelResult {
  /** Current panel width in pixels */
  width: number
  /** Whether a drag is currently in progress */
  isDragging: boolean
  /** Callback ref — attach to the drag handle element via ref={handleRef} */
  handleRef: (node: HTMLDivElement | null) => void
}

/**
 * Hook for a horizontally resizable panel. Uses a callback ref so that
 * mousedown listeners are reliably attached/detached even when the handle
 * DOM node is conditionally rendered (unmounted and remounted).
 *
 * Usage:
 * ```tsx
 * const { width, isDragging, handleRef } = useResizablePanel({
 *   storageKey: 'my-panel-width',
 *   defaultWidth: 250,
 *   minWidth: 150,
 *   maxWidth: 500,
 * })
 * ```
 */
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  invertDelta = false,
}: UseResizablePanelOptions): UseResizablePanelResult {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultWidth
    const storage = globalThis.localStorage
    if (!storage || typeof storage.getItem !== 'function') {
      return defaultWidth
    }

    const stored = storage.getItem(storageKey)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) {
        return parsed
      }
    }
    return defaultWidth
  })

  const [isDragging, setIsDragging] = useState(false)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const widthRef = useLatestRef(width)
  const invertRef = useLatestRef(invertDelta)

  const persistWidth = useCallback(
    (w: number) => {
      const storage = globalThis.localStorage
      if (!storage || typeof storage.setItem !== 'function') {
        return
      }

      storage.setItem(storageKey, String(w))
    },
    [storageKey],
  )

  // Stable mousedown handler — created once via useState lazy initializer so
  // the identity never changes.  Reads width from ref, not closure.
  const [onMouseDown] = useState(() => (e: MouseEvent) => {
    e.preventDefault()
    startXRef.current = e.clientX
    startWidthRef.current = widthRef.current
    setIsDragging(true)
  })

  // Callback ref: reliably attaches/detaches mousedown whenever the DOM node
  // mounts or unmounts (handles conditional rendering correctly).
  const handleRef = useCallback((node: HTMLDivElement | null) => {
    if (nodeRef.current) {
      nodeRef.current.removeEventListener('mousedown', onMouseDown)
    }
    nodeRef.current = node
    if (node) {
      node.addEventListener('mousedown', onMouseDown)
    }
  }, [onMouseDown])

  // Drag movement & release — only active while dragging
  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current
      const adjustedDelta = invertRef.current ? -delta : delta
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + adjustedDelta))
      setWidth(newWidth)
    }

    const onMouseUp = () => {
      setIsDragging(false)
      // Persist the final width
      setWidth((current) => {
        persistWidth(current)
        return current
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)

    // Prevent text selection while dragging
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging, minWidth, maxWidth, persistWidth, invertRef])

  return { width, isDragging, handleRef }
}
