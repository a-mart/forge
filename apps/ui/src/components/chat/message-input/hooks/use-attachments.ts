import { useCallback, type ChangeEvent } from 'react'
import {
  fileToPendingAttachment,
  type PendingAttachment,
  type PendingTerminalAttachment,
} from '@/lib/file-attachments'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'

interface UseAttachmentsOptions {
  disabled: boolean
  isRecording: boolean
  attachedFilesRef: React.RefObject<PendingAttachment[]>
  setAttachedFilesWithDraft: (files: PendingAttachment[]) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

interface UseAttachmentsReturn {
  addFiles: (files: File[]) => Promise<void>
  addTerminalContext: (context: TerminalSelectionContext) => void
  removeAttachment: (attachmentId: string) => void
  handleFileSelect: (event: ChangeEvent<HTMLInputElement>) => Promise<void>
  handlePaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => Promise<void>
}

export function useAttachments({
  disabled,
  isRecording,
  attachedFilesRef,
  setAttachedFilesWithDraft,
  textareaRef,
}: UseAttachmentsOptions): UseAttachmentsReturn {
  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || isRecording || files.length === 0) return

      const uploaded = await Promise.all(files.map(fileToPendingAttachment))
      const nextAttachments = uploaded.filter(
        (attachment): attachment is PendingAttachment => attachment !== null,
      )

      if (nextAttachments.length === 0) return

      setAttachedFilesWithDraft([...attachedFilesRef.current, ...nextAttachments])
    },
    [disabled, isRecording, setAttachedFilesWithDraft, attachedFilesRef],
  )

  const addTerminalContext = useCallback(
    (context: TerminalSelectionContext) => {
      const attachment: PendingTerminalAttachment = {
        id: crypto.randomUUID(),
        type: 'terminal',
        terminalName: context.terminalName,
        lineRange: context.lineRange,
        content: context.text,
        sizeBytes: new Blob([context.text]).size,
      }
      setAttachedFilesWithDraft([...attachedFilesRef.current, attachment])
      requestAnimationFrame(() => textareaRef.current?.focus())
    },
    [setAttachedFilesWithDraft, attachedFilesRef, textareaRef],
  )

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      setAttachedFilesWithDraft(
        attachedFilesRef.current.filter((attachment) => attachment.id !== attachmentId),
      )
    },
    [setAttachedFilesWithDraft, attachedFilesRef],
  )

  const handleFileSelect = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? [])
      await addFiles(files)
      event.target.value = ''
    },
    [addFiles],
  )

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)

      if (files.length === 0) return

      event.preventDefault()
      await addFiles(files)
    },
    [addFiles],
  )

  return {
    addFiles,
    addTerminalContext,
    removeAttachment,
    handleFileSelect,
    handlePaste,
  }
}
