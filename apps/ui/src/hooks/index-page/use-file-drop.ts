import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import type { MessageInputHandle } from '@/components/chat/MessageInput'
import { hasSessionReferenceDrag, readSessionReferenceDrag } from '@/lib/session-reference-drag'
import type { ActiveView } from './use-route-state'

interface UseFileDropOptions {
  activeView: ActiveView
  messageInputRef: RefObject<MessageInputHandle | null>
  /** Accept sidebar session drags as composer references (local manager chats only). */
  acceptSessionReferences?: boolean
}

export function useFileDrop({
  activeView,
  messageInputRef,
  acceptSessionReferences = false,
}: UseFileDropOptions): {
  isDraggingFiles: boolean
  handleDragEnter: (event: DragEvent<HTMLDivElement>) => void
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void
  handleDrop: (event: DragEvent<HTMLDivElement>) => void
} {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  const dragDepthRef = useRef(0)

  useEffect(() => {
    if (activeView === 'chat') {
      return
    }

    dragDepthRef.current = 0
    setIsDraggingFiles(false)
  }, [activeView])

  const isAcceptedDrag = useCallback(
    (dataTransfer: DataTransfer | null | undefined) =>
      Boolean(dataTransfer?.types.includes('Files')) ||
      (acceptSessionReferences && hasSessionReferenceDrag(dataTransfer)),
    [acceptSessionReferences],
  )

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') {
      return
    }

    if (!isAcceptedDrag(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }, [activeView, isAcceptedDrag])

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') {
      return
    }

    if (!isAcceptedDrag(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [activeView, isAcceptedDrag])

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') {
      return
    }

    if (!isAcceptedDrag(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false)
    }
  }, [activeView, isAcceptedDrag])

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (activeView !== 'chat') {
      return
    }

    if (!isAcceptedDrag(event.dataTransfer)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)

    const sessionReference = hasSessionReferenceDrag(event.dataTransfer)
      ? readSessionReferenceDrag(event.dataTransfer)
      : null
    if (sessionReference) {
      messageInputRef.current?.addSessionReference(sessionReference)
      return
    }

    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) {
      return
    }

    void messageInputRef.current?.addFiles(files)
  }, [activeView, isAcceptedDrag, messageInputRef])

  return {
    isDraggingFiles,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  }
}
