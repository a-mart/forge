import { useCallback, useEffect, useRef, useState } from 'react'
import type { PendingAttachment } from '@/lib/file-attachments'
import { loadFormatMode, persistFormatMode } from '../draft-storage'
import { TEXTAREA_MAX_HEIGHT } from '../types'

interface LastSubmission {
  text: string
  attachments: PendingAttachment[]
}

interface UseComposerOptions {
  input: string
  attachedFiles: PendingAttachment[]
  disabled: boolean
  blockedByLoading: boolean
  isRecording: boolean
  isTranscribingVoice: boolean
  onSend: (message: string, attachments?: import('@forge/protocol').ConversationAttachment[]) => void | boolean | Promise<boolean>
  onSubmitted?: () => void
  setInputWithDraft: (value: string) => void
  setAttachedFilesWithDraft: (files: PendingAttachment[]) => void
}

interface UseComposerReturn {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  overlayRef: React.RefObject<HTMLDivElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  formatMode: boolean
  toggleFormatMode: () => void
  applyListFormatting: (formatter: (text: string, cursor: number) => { text: string; cursor: number }) => void
  submitMessage: () => void
  handleSubmit: (event: React.FormEvent<HTMLFormElement>) => void
  syncOverlayScroll: () => void
  resizeTextarea: () => void
  canSubmit: boolean
  hasContent: boolean
  /** Restore the last successfully cleared submission. Returns true if restoration happened. */
  restoreLastSubmission: () => boolean
}

export function useComposer({
  input,
  attachedFiles,
  disabled,
  blockedByLoading,
  isRecording,
  isTranscribingVoice,
  onSend,
  onSubmitted,
  setInputWithDraft,
  setAttachedFilesWithDraft,
}: UseComposerOptions): UseComposerReturn {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const lastSubmissionRef = useRef<LastSubmission | null>(null)
  const [formatMode, setFormatMode] = useState(loadFormatMode)

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.overflowY = 'hidden'
    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [input, formatMode, resizeTextarea])

  useEffect(() => {
    if (!disabled && !blockedByLoading && !isRecording) {
      textareaRef.current?.focus()
    }
  }, [blockedByLoading, disabled, isRecording])

  const toggleFormatMode = useCallback(() => {
    setFormatMode((prev) => {
      const next = !prev
      persistFormatMode(next)
      return next
    })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  const applyListFormatting = useCallback(
    (formatter: (text: string, cursor: number) => { text: string; cursor: number }) => {
      const textarea = textareaRef.current
      if (!textarea) return
      const cursorPos = textarea.selectionStart
      const result = formatter(input, cursorPos)
      setInputWithDraft(result.text)
      requestAnimationFrame(() => {
        textarea.focus()
        textarea.setSelectionRange(result.cursor, result.cursor)
      })
    },
    [input, setInputWithDraft],
  )

  const hasContent = input.trim().length > 0 || attachedFiles.length > 0
  const canSubmit = hasContent && !disabled && !blockedByLoading && !isRecording && !isTranscribingVoice

  const submitMessage = useCallback(() => {
    const trimmed = input.trim()
    const hasMsg = trimmed.length > 0 || attachedFiles.length > 0
    if (!hasMsg || disabled || blockedByLoading || isRecording || isTranscribingVoice) return

    const convertedAttachments = attachedFiles.length > 0
      ? attachedFiles.map((attachment) => {
          if (attachment.type === 'terminal') {
            const label = attachment.lineRange
              ? `${attachment.terminalName} (${attachment.lineRange})`
              : attachment.terminalName
            return {
              type: 'text' as const,
              mimeType: 'text/plain' as const,
              text: `Terminal: ${label}\n\n\`\`\`\n${attachment.content}\n\`\`\``,
              fileName: `${label}.txt`,
            }
          }

          if (attachment.type === 'text') {
            return {
              type: 'text' as const,
              mimeType: attachment.mimeType,
              text: attachment.text,
              fileName: attachment.fileName,
            }
          }

          if (attachment.type === 'binary') {
            return {
              type: 'binary' as const,
              mimeType: attachment.mimeType,
              data: attachment.data,
              fileName: attachment.fileName,
            }
          }

          return {
            mimeType: attachment.mimeType,
            data: attachment.data,
            fileName: attachment.fileName,
          }
        })
      : undefined

    const result = onSend(trimmed, convertedAttachments) as boolean | Promise<boolean> | undefined

    // Accept send and clear draft, saving the submission for potential restoration
    const acceptSend = () => {
      lastSubmissionRef.current = { text: input, attachments: [...attachedFiles] }
      setInputWithDraft('')
      setAttachedFilesWithDraft([])
      requestAnimationFrame(() => {
        onSubmitted?.()
      })
    }

    // Handle sync or async result: false = rejected (keep draft), true/void = accepted (clear)
    if (result instanceof Promise) {
      void result.then((accepted) => {
        if (accepted !== false) acceptSend()
      })
    } else if (result === false) {
      // Send rejected — keep draft intact
    } else {
      // true, undefined (void), or any other truthy value — accepted
      acceptSend()
    }
  }, [
    attachedFiles,
    blockedByLoading,
    disabled,
    input,
    isRecording,
    isTranscribingVoice,
    onSend,
    onSubmitted,
    setInputWithDraft,
    setAttachedFilesWithDraft,
  ])

  const restoreLastSubmission = useCallback(() => {
    const last = lastSubmissionRef.current
    if (!last) return false
    setInputWithDraft(last.text)
    setAttachedFilesWithDraft(last.attachments)
    lastSubmissionRef.current = null
    return true
  }, [setInputWithDraft, setAttachedFilesWithDraft])

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitMessage()
    },
    [submitMessage],
  )

  const syncOverlayScroll = useCallback(() => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  return {
    textareaRef,
    overlayRef,
    fileInputRef,
    formatMode,
    toggleFormatMode,
    applyListFormatting,
    submitMessage,
    handleSubmit,
    syncOverlayScroll,
    resizeTextarea,
    canSubmit,
    hasContent,
    restoreLastSubmission,
  }
}
