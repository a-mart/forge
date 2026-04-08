import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingAttachment } from '@/lib/file-attachments'
import {
  loadDrafts,
  persistDrafts,
  loadAttachmentDrafts,
  persistAttachmentDrafts,
} from '../draft-storage'

interface UseDraftOptions {
  agentId?: string
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

export function useDraft({ agentId }: UseDraftOptions): UseDraftReturn {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])

  const draftsRef = useRef<Record<string, string>>(loadDrafts())
  const prevAgentIdRef = useRef<string | undefined>(undefined)
  const inputRef = useRef(input)
  inputRef.current = input

  const attachedFilesRef = useRef(attachedFiles)
  attachedFilesRef.current = attachedFiles
  const attachmentDraftsRef = useRef<Record<string, PendingAttachment[]>>(loadAttachmentDrafts())

  // Save current draft and restore new agent's draft on agent/session switch
  useEffect(() => {
    const prevId = prevAgentIdRef.current
    if (prevId === agentId) return

    // Save draft for previous agent
    if (prevId) {
      if (inputRef.current.trim()) {
        draftsRef.current[prevId] = inputRef.current
      } else {
        delete draftsRef.current[prevId]
      }
      if (attachedFilesRef.current.length > 0) {
        attachmentDraftsRef.current[prevId] = attachedFilesRef.current
      } else {
        delete attachmentDraftsRef.current[prevId]
      }
    }

    // Restore draft for new agent
    const restoredDraft = agentId ? (draftsRef.current[agentId] ?? '') : ''
    setInput(restoredDraft)
    inputRef.current = restoredDraft

    // Restore attachments for new agent
    const restoredAttachments = agentId ? (attachmentDraftsRef.current[agentId] ?? []) : []
    setAttachedFiles(restoredAttachments)

    persistDrafts(draftsRef.current)
    persistAttachmentDrafts(attachmentDraftsRef.current)
    prevAgentIdRef.current = agentId
  }, [agentId])

  // Flush current draft on page unload so it survives refresh
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (agentId) {
        if (inputRef.current.trim()) {
          draftsRef.current[agentId] = inputRef.current
        } else {
          delete draftsRef.current[agentId]
        }
        persistDrafts(draftsRef.current)

        if (attachedFilesRef.current.length > 0) {
          attachmentDraftsRef.current[agentId] = attachedFilesRef.current
        } else {
          delete attachmentDraftsRef.current[agentId]
        }
        persistAttachmentDrafts(attachmentDraftsRef.current)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [agentId])

  // Helper: update input state and sync draft to localStorage
  const setInputWithDraft = useCallback(
    (value: string) => {
      setInput(value)
      if (agentId) {
        if (value.trim()) {
          draftsRef.current[agentId] = value
        } else {
          delete draftsRef.current[agentId]
        }
        persistDrafts(draftsRef.current)
      }
    },
    [agentId],
  )

  // Helper: update attached files state and sync attachment draft to localStorage
  const setAttachedFilesWithDraft = useCallback(
    (files: PendingAttachment[]) => {
      setAttachedFiles(files)
      attachedFilesRef.current = files
      if (agentId) {
        if (files.length > 0) {
          attachmentDraftsRef.current[agentId] = files
        } else {
          delete attachmentDraftsRef.current[agentId]
        }
        persistAttachmentDrafts(attachmentDraftsRef.current)
      }
    },
    [agentId],
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
