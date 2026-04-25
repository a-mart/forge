import { useCallback, useEffect, useRef, useState } from 'react'

export interface UseDrawerResizeOptions {
  /** localStorage key for persisting width */
  storageKey: string
  /** Default width in pixels */
  defaultWidth: number
  /** Minimum allowed width in pixels */
  minWidth: number
  /** Maximum allowed width in pixels */
  maxWidth: number
}

function loadWidth(key: string, defaultWidth: number, minWidth: number, maxWidth: number): number {
  if (typeof window === 'undefined') return defaultWidth
  try {
    const stored = window.localStorage.getItem(key)
    if (stored) {
      const w = parseInt(stored, 10)
      if (w >= minWidth && w <= maxWidth) return w
    }
  } catch { /* ignore */ }
  return defaultWidth
}

function persistWidth(key: string, width: number): void {
  try {
    window.localStorage.setItem(key, String(width))
  } catch { /* ignore */ }
}

/**
 * Reusable hook for resizable right-side sheet/drawer panels.
 *
 * Drag the left edge to resize; width is persisted to localStorage.
 * Follows the pattern established by HelpDrawer.
 */
export function useDrawerResize({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
}: UseDrawerResizeOptions) {
  const [width, setWidth] = useState(() => loadWidth(storageKey, defaultWidth, minWidth, maxWidth))
  const [isResizing, setIsResizing] = useState(false)
  const widthRef = useRef(width)

  useEffect(() => {
    widthRef.current = width
  }, [width])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    const startX = e.clientX
    const startWidth = widthRef.current

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Dragging left = increasing width (handle is on left edge of right-side sheet)
      const delta = startX - moveEvent.clientX
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta))
      setWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      persistWidth(storageKey, widthRef.current)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [storageKey, minWidth, maxWidth])

  return { width, isResizing, handleResizeStart }
}
