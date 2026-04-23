import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingAttachment } from '@/lib/file-attachments'
import { useLatestRef } from '@/hooks/useLatestRef'
import {
  loadDrafts,
  persistDrafts,
  loadAttachmentDrafts,
  persistAttachmentDrafts,
} from '../draft-storage'

interface UseDraftOptions {
  draftKey?: string
}

interface UseDraftReturn {
  input: string
  setInput: (value: string) => void
  setInputWithDraft: (value: string) => void
  attachedFiles: PendingAttachment[]
  setAttachedFilesWithDraft: (files: PendingAttachment[]) => void
  /** Ref that always holds the current input value. */
  inputRef: React.RefObject<string>
  /** Ref that always holds the current attached files. */
  attachedFilesRef: React.RefObject<PendingAttachment[]>
}

export function useDraft({ draftKey }: UseDraftOptions): UseDraftReturn {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])

  const draftsRef = useRef<Record<string, string>>(loadDrafts())
  const prevDraftKeyRef = useRef<string | undefined>(undefined)
  const inputRef = useLatestRef(input)

  const attachedFilesRef = useLatestRef(attachedFiles)
  const attachmentDraftsRef = useRef<Record<string, PendingAttachment[]>>(loadAttachmentDrafts())

  // Save current draft and restore the next draft whenever the storage key changes.
  useEffect(() => {
    const prevKey = prevDraftKeyRef.current
    if (prevKey === draftKey) return

    if (prevKey) {
      if (inputRef.current.trim()) {
        draftsRef.current[prevKey] = inputRef.current
      } else {
        delete draftsRef.current[prevKey]
      }
      if (attachedFilesRef.current.length > 0) {
        attachmentDraftsRef.current[prevKey] = attachedFilesRef.current
      } else {
        delete attachmentDraftsRef.current[prevKey]
      }
    }

    const restoredDraft = draftKey ? (draftsRef.current[draftKey] ?? '') : ''
    setInput(restoredDraft)

    const restoredAttachments = draftKey ? (attachmentDraftsRef.current[draftKey] ?? []) : []
    setAttachedFiles(restoredAttachments)

    persistDrafts(draftsRef.current)
    persistAttachmentDrafts(attachmentDraftsRef.current)
    prevDraftKeyRef.current = draftKey
  }, [attachedFilesRef, draftKey, inputRef])

  // Flush current draft on page unload so it survives refresh.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!draftKey) {
        return
      }

      if (inputRef.current.trim()) {
        draftsRef.current[draftKey] = inputRef.current
      } else {
        delete draftsRef.current[draftKey]
      }
      persistDrafts(draftsRef.current)

      if (attachedFilesRef.current.length > 0) {
        attachmentDraftsRef.current[draftKey] = attachedFilesRef.current
      } else {
        delete attachmentDraftsRef.current[draftKey]
      }
      persistAttachmentDrafts(attachmentDraftsRef.current)
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [attachedFilesRef, draftKey, inputRef])

  const setInputWithDraft = useCallback(
    (value: string) => {
      setInput(value)
      if (!draftKey) {
        return
      }

      if (value.trim()) {
        draftsRef.current[draftKey] = value
      } else {
        delete draftsRef.current[draftKey]
      }
      persistDrafts(draftsRef.current)
    },
    [draftKey],
  )

  const setAttachedFilesWithDraft = useCallback(
    (files: PendingAttachment[]) => {
      setAttachedFiles(files)
      if (!draftKey) {
        return
      }

      if (files.length > 0) {
        attachmentDraftsRef.current[draftKey] = files
      } else {
        delete attachmentDraftsRef.current[draftKey]
      }
      persistAttachmentDrafts(attachmentDraftsRef.current)
    },
    [draftKey],
  )

  return {
    input,
    setInput,
    setInputWithDraft,
    attachedFiles,
    setAttachedFilesWithDraft,
    inputRef,
    attachedFilesRef,
  }
}
