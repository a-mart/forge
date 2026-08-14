import { useCallback, useEffect, useRef, useState } from 'react'
import { useLatestRef } from '../../hooks/useLatestRef'

interface UseResizableHeightOptions {
  storageKey: string
  defaultHeight: number
  minHeight: number
  maxHeight: number
}

interface UseResizableHeightResult {
  height: number
  isDragging: boolean
  handleRef: (node: HTMLDivElement | null) => void
}

export function useResizableHeight({
  storageKey,
  defaultHeight,
  minHeight,
  maxHeight,
}: UseResizableHeightOptions): UseResizableHeightResult {
  const [height, setHeight] = useState(() => {
    if (typeof window === 'undefined') return defaultHeight
    const storage = globalThis.localStorage
    if (!storage || typeof storage.getItem !== 'function') {
      return defaultHeight
    }

    const stored = storage.getItem(storageKey)
    if (stored) {
      const parsed = parseInt(stored, 10)
      if (!isNaN(parsed) && parsed >= minHeight && parsed <= maxHeight) {
        return parsed
      }
    }
    return defaultHeight
  })

  const [isDragging, setIsDragging] = useState(false)
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)
  const heightRef = useLatestRef(height)

  const persistHeight = useCallback(
    (nextHeight: number) => {
      const storage = globalThis.localStorage
      if (!storage || typeof storage.setItem !== 'function') {
        return
      }

      storage.setItem(storageKey, String(nextHeight))
    },
    [storageKey],
  )

  const [onMouseDown] = useState(() => (event: MouseEvent) => {
    event.preventDefault()
    startYRef.current = event.clientY
    startHeightRef.current = heightRef.current
    setIsDragging(true)
  })

  const handleRef = useCallback((node: HTMLDivElement | null) => {
    if (nodeRef.current) {
      nodeRef.current.removeEventListener('mousedown', onMouseDown)
    }
    nodeRef.current = node
    if (node) {
      node.addEventListener('mousedown', onMouseDown)
    }
  }, [onMouseDown])

  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (event: MouseEvent) => {
      const delta = event.clientY - startYRef.current
      const nextHeight = Math.min(maxHeight, Math.max(minHeight, startHeightRef.current + delta))
      setHeight(nextHeight)
    }

    const onMouseUp = () => {
      setIsDragging(false)
      setHeight((current) => {
        persistHeight(current)
        return current
      })
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'

    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging, maxHeight, minHeight, persistHeight])

  return { height, isDragging, handleRef }
}
