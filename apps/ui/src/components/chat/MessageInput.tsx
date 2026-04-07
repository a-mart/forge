import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { ALargeSmall, ArrowUp, List, ListOrdered, Loader2, Mic, Paperclip, Square } from 'lucide-react'
import { AttachedFiles } from '@/components/chat/AttachedFiles'
import { Button } from '@/components/ui/button'
import { MAX_VOICE_RECORDING_DURATION_MS, useVoiceRecorder } from '@/hooks/use-voice-recorder'
import {
  fileToPendingAttachment,
  type PendingAttachment,
  type PendingTerminalAttachment,
} from '@/lib/file-attachments'
import type { TerminalSelectionContext } from '@/components/terminal/TerminalViewport'
import { resolveApiEndpoint } from '@/lib/api-endpoint'
import { transcribeVoice } from '@/lib/voice-transcription-client'
import { cn } from '@/lib/utils'
import type { ConversationAttachment } from '@forge/protocol'
import type { SlashCommand } from '@/components/settings/slash-commands-api'

export interface ProjectAgentSuggestion {
  agentId: string
  handle: string
  displayName: string
  whenToUse: string
}

const TEXTAREA_MAX_HEIGHT = 186
const ACTIVE_WAVEFORM_BAR_COUNT = 16
const OPENAI_KEY_REQUIRED_MESSAGE = 'OpenAI API key required \u2014 add it in Settings.'
const DRAFTS_STORAGE_KEY = 'forge-chat-drafts'
const FORMAT_MODE_STORAGE_KEY = 'forge-chat-format-mode'

// --- Format mode helpers ---

function loadFormatMode(): boolean {
  try {
    return localStorage.getItem(FORMAT_MODE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function persistFormatMode(value: boolean): void {
  try {
    localStorage.setItem(FORMAT_MODE_STORAGE_KEY, String(value))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/** Returns the line containing the cursor and its start/end offsets within the full text. */
function getCurrentLine(text: string, cursorPos: number): { line: string; lineStart: number; lineEnd: number } {
  const lineStart = text.lastIndexOf('\n', cursorPos - 1) + 1
  let lineEnd = text.indexOf('\n', cursorPos)
  if (lineEnd === -1) lineEnd = text.length
  return { line: text.slice(lineStart, lineEnd), lineStart, lineEnd }
}

const BULLET_RE = /^- /
const NUMBERED_RE = /^(\d+)\. /
const MENTION_TOKEN_RE = /\[@[^\]]+\]/g

/**
 * Toggle a bullet-list prefix (`- `) on the current line.
 * Returns the updated text and new cursor position.
 */
function toggleBulletList(
  text: string,
  cursorPos: number,
): { text: string; cursor: number } {
  const { line, lineStart, lineEnd } = getCurrentLine(text, cursorPos)

  if (BULLET_RE.test(line)) {
    // Remove bullet prefix
    const newLine = line.slice(2)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: Math.max(lineStart, cursorPos - 2),
    }
  }

  // If it has a numbered prefix, replace it
  const numMatch = NUMBERED_RE.exec(line)
  if (numMatch) {
    const prefixLen = numMatch[0].length
    const newLine = '- ' + line.slice(prefixLen)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: lineStart + 2 + Math.max(0, cursorPos - lineStart - prefixLen),
    }
  }

  // Add bullet prefix
  const newLine = '- ' + line
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    cursor: cursorPos + 2,
  }
}

/**
 * Toggle a numbered-list prefix (`N. `) on the current line.
 * Auto-numbers based on preceding numbered lines.
 */
function toggleNumberedList(
  text: string,
  cursorPos: number,
): { text: string; cursor: number } {
  const { line, lineStart, lineEnd } = getCurrentLine(text, cursorPos)

  const numMatch = NUMBERED_RE.exec(line)
  if (numMatch) {
    // Remove numbered prefix
    const prefixLen = numMatch[0].length
    const newLine = line.slice(prefixLen)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: Math.max(lineStart, cursorPos - prefixLen),
    }
  }

  // Determine the next number by looking at preceding lines
  let nextNumber = 1
  const textBefore = text.slice(0, lineStart)
  const linesBefore = textBefore.split('\n')
  for (let i = linesBefore.length - 1; i >= 0; i--) {
    const prevMatch = NUMBERED_RE.exec(linesBefore[i]!)
    if (prevMatch) {
      nextNumber = Number(prevMatch[1]) + 1
      break
    }
    // Stop if the previous line is non-empty and not a numbered list
    if (linesBefore[i]!.trim() !== '') break
  }

  const prefix = `${nextNumber}. `

  // If it has a bullet prefix, replace it
  if (BULLET_RE.test(line)) {
    const newLine = prefix + line.slice(2)
    return {
      text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
      cursor: lineStart + prefix.length + Math.max(0, cursorPos - lineStart - 2),
    }
  }

  // Add numbered prefix
  const newLine = prefix + line
  return {
    text: text.slice(0, lineStart) + newLine + text.slice(lineEnd),
    cursor: cursorPos + prefix.length,
  }
}

/** Find the mention token range that contains or is bounded by the given cursor position. */
function findMentionContaining(text: string, pos: number): { start: number; end: number } | null {
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index!
    const end = start + match[0].length
    if (pos >= start && pos <= end) {
      return { start, end }
    }
  }
  return null
}

/** Render text with [@handle] tokens as styled mention chips for the overlay. */
function renderMentionOverlay(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIdx = 0
  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index!
    const end = start + match[0].length
    if (start > lastIdx) {
      parts.push(text.slice(lastIdx, start))
    }
    const handle = match[0].slice(2, -1)
    parts.push(
      <span key={start} className="rounded-sm bg-blue-500/10 dark:bg-blue-400/10">
        <span className="text-transparent">[</span>
        <span className="text-blue-600 dark:text-blue-400">@{handle}</span>
        <span className="text-transparent">]</span>
      </span>,
    )
    lastIdx = end
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  // Trailing newline matches textarea's implicit trailing line
  parts.push('\n')
  return parts
}

function loadDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
    return {}
  } catch {
    return {}
  }
}

function persistDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

const ATTACHMENT_DRAFTS_STORAGE_KEY = 'forge-chat-attachment-drafts'
/** Max serialized size (bytes) we'll commit to localStorage for attachment drafts. */
const ATTACHMENT_DRAFTS_MAX_BYTES = 4 * 1024 * 1024

function loadAttachmentDrafts(): Record<string, PendingAttachment[]> {
  try {
    const raw = localStorage.getItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, PendingAttachment[]>
    }
    return {}
  } catch {
    return {}
  }
}

function persistAttachmentDrafts(drafts: Record<string, PendingAttachment[]>): void {
  try {
    const cleaned: Record<string, PendingAttachment[]> = {}
    for (const [key, value] of Object.entries(drafts)) {
      if (value.length > 0) cleaned[key] = value
    }
    if (Object.keys(cleaned).length === 0) {
      localStorage.removeItem(ATTACHMENT_DRAFTS_STORAGE_KEY)
      return
    }
    const serialized = JSON.stringify(cleaned)
    if (serialized.length > ATTACHMENT_DRAFTS_MAX_BYTES) {
      // Too large for localStorage — keep in-memory only, don't persist
      return
    }
    localStorage.setItem(ATTACHMENT_DRAFTS_STORAGE_KEY, serialized)
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

interface MessageInputProps {
  onSend: (message: string, attachments?: ConversationAttachment[]) => void
  onSubmitted?: () => void
  isLoading: boolean
  disabled?: boolean
  placeholderOverride?: string
  agentLabel?: string
  allowWhileLoading?: boolean
  wsUrl?: string
  agentId?: string
  slashCommands?: SlashCommand[]
  projectAgents?: ProjectAgentSuggestion[]
}

export interface MessageInputHandle {
  setInput: (value: string) => void
  focus: () => void
  addFiles: (files: File[]) => Promise<void>
  addTerminalContext: (context: TerminalSelectionContext) => void
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

function stretchWaveformBars(source: number[], targetCount: number): number[] {
  if (targetCount <= 0) return []
  if (source.length === 0) return Array.from({ length: targetCount }, () => 0)
  if (source.length === 1) return Array.from({ length: targetCount }, () => source[0] ?? 0)

  return Array.from({ length: targetCount }, (_, index) => {
    const position = (index / (targetCount - 1)) * (source.length - 1)
    const lower = Math.floor(position)
    const upper = Math.min(source.length - 1, Math.ceil(position))
    const ratio = position - lower
    const lowerValue = source[lower] ?? 0
    const upperValue = source[upper] ?? lowerValue
    return lowerValue + (upperValue - lowerValue) * ratio
  })
}

async function hasConfiguredOpenAiKey(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(endpoint)
    if (!response.ok) {
      return false
    }

    const payload = (await response.json()) as {
      providers?: Array<{
        provider?: unknown
        configured?: unknown
      }>
    }

    if (!payload || !Array.isArray(payload.providers)) {
      return false
    }

    return payload.providers.some((provider) => {
      if (!provider || typeof provider !== 'object') {
        return false
      }

      const providerId =
        typeof provider.provider === 'string' ? provider.provider.trim().toLowerCase() : ''
      const configured = provider.configured === true

      return configured && providerId === 'openai-codex'
    })
  } catch {
    return false
  }
}

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  {
    onSend,
    onSubmitted,
    isLoading,
    disabled = false,
    placeholderOverride,
    agentLabel = 'agent',
    allowWhileLoading = false,
    wsUrl,
    agentId,
    slashCommands,
    projectAgents,
  },
  ref,
) {
  const [input, setInput] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<PendingAttachment[]>([])
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [formatMode, setFormatMode] = useState(loadFormatMode)
  const hasMentionTokens = useMemo(() => /\[@[^\]]+\]/.test(input), [input])

  // --- Slash command autocomplete ---
  const [isSlashMenuOpen, setIsSlashMenuOpen] = useState(false)
  const [slashFilter, setSlashFilter] = useState('')
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const slashMenuRef = useRef<HTMLDivElement | null>(null)

  // --- @mention autocomplete ---
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [mentionTokenStart, setMentionTokenStart] = useState(-1)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)

  const filteredSlashCommands = useMemo(() => {
    if (!slashCommands || slashCommands.length === 0) return []
    if (!slashFilter) return slashCommands
    const lower = slashFilter.toLowerCase()
    return slashCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(lower))
  }, [slashCommands, slashFilter])

  const filteredMentions = useMemo(() => {
    if (!projectAgents || projectAgents.length === 0) return []
    if (!mentionFilter) return projectAgents
    const lower = mentionFilter.toLowerCase()
    return projectAgents.filter(
      (agent) =>
        agent.handle.toLowerCase().startsWith(lower) ||
        agent.displayName.toLowerCase().startsWith(lower),
    )
  }, [projectAgents, mentionFilter])

  // Close slash menu on outside click
  useEffect(() => {
    if (!isSlashMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (slashMenuRef.current && !slashMenuRef.current.contains(e.target as Node)) {
        setIsSlashMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isSlashMenuOpen])

  // Close mention menu on outside click
  useEffect(() => {
    if (!isMentionMenuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(e.target as Node)) {
        setIsMentionMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isMentionMenuOpen])

  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // --- Per-session draft persistence ---
  const draftsRef = useRef<Record<string, string>>(loadDrafts())
  const prevAgentIdRef = useRef<string | undefined>(undefined)
  const inputRef = useRef(input)
  inputRef.current = input

  // --- Per-session attachment draft persistence ---
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

  const {
    isRecording,
    isRequestingPermission: isRequestingMicrophone,
    durationMs: voiceRecordingDurationMs,
    waveformBars: recordingWaveformBars,
    startRecording,
    stopRecording,
  } = useVoiceRecorder()

  const transcribeEndpoint = useMemo(() => resolveApiEndpoint(wsUrl, '/api/transcribe'), [wsUrl])
  const settingsAuthEndpoint = useMemo(() => resolveApiEndpoint(wsUrl, '/api/settings/auth'), [wsUrl])

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    textarea.style.overflowY = 'hidden'
    textarea.style.height = 'auto'
    const nextHeight = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden'
  }, [])

  const blockedByLoading = isLoading && !allowWhileLoading

  useEffect(() => {
    resizeTextarea()
  }, [input, formatMode, resizeTextarea])

  useEffect(() => {
    if (!disabled && !blockedByLoading && !isRecording) {
      textareaRef.current?.focus()
    }
  }, [blockedByLoading, disabled, isRecording])

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled || isRecording || files.length === 0) return

      const uploaded = await Promise.all(files.map(fileToPendingAttachment))
      const nextAttachments = uploaded.filter((attachment): attachment is PendingAttachment => attachment !== null)

      if (nextAttachments.length === 0) {
        return
      }

      setAttachedFilesWithDraft([...attachedFilesRef.current, ...nextAttachments])
    },
    [disabled, isRecording, setAttachedFilesWithDraft],
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
    [setAttachedFilesWithDraft],
  )

  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        setInputWithDraft(value)
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      focus: () => {
        textareaRef.current?.focus()
      },
      addFiles,
      addTerminalContext,
    }),
    [addFiles, addTerminalContext, setInputWithDraft],
  )

  const handleFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    await addFiles(files)
    event.target.value = ''
  }

  const handlePaste = async (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (files.length === 0) return

    event.preventDefault()
    await addFiles(files)
  }

  const removeAttachment = (attachmentId: string) => {
    setAttachedFilesWithDraft(attachedFilesRef.current.filter((attachment) => attachment.id !== attachmentId))
  }

  const appendTranscriptionToInput = useCallback((transcribedText: string): boolean => {
    const trimmedText = transcribedText.trim()
    if (!trimmedText) {
      return false
    }

    setInput((previousInput) => {
      let next: string
      if (!previousInput.trim()) {
        next = trimmedText
      } else {
        const separator = previousInput.endsWith('\n') || previousInput.endsWith(' ') ? '' : '\n'
        next = `${previousInput}${separator}${trimmedText}`
      }

      // Sync draft for the current agent
      if (agentId) {
        draftsRef.current[agentId] = next
        persistDrafts(draftsRef.current)
      }

      return next
    })

    requestAnimationFrame(() => textareaRef.current?.focus())
    return true
  }, [agentId])

  const stopAndTranscribeRecording = useCallback(async () => {
    const recording = await stopRecording()
    if (!recording) {
      setVoiceError('Recording failed. Could not capture audio. Please try again.')
      return
    }

    setIsTranscribingVoice(true)
    setVoiceError(null)

    try {
      const result = await transcribeVoice(recording.blob, transcribeEndpoint)
      const appended = appendTranscriptionToInput(result.text)
      if (!appended) {
        setVoiceError('No speech detected. Try speaking a little louder.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice transcription failed.'
      setVoiceError(message)
    } finally {
      setIsTranscribingVoice(false)
    }
  }, [appendTranscriptionToInput, stopRecording, transcribeEndpoint])

  useEffect(() => {
    if (!isRecording || isTranscribingVoice) return
    if (voiceRecordingDurationMs < MAX_VOICE_RECORDING_DURATION_MS) return
    void stopAndTranscribeRecording()
  }, [isRecording, isTranscribingVoice, stopAndTranscribeRecording, voiceRecordingDurationMs])

  const startInlineRecording = useCallback(async () => {
    const hasOpenAiKey = await hasConfiguredOpenAiKey(settingsAuthEndpoint)
    if (!hasOpenAiKey) {
      setVoiceError(OPENAI_KEY_REQUIRED_MESSAGE)
      return
    }

    try {
      await startRecording()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access your microphone.'
      setVoiceError(message)
    }
  }, [settingsAuthEndpoint, startRecording])

  const handleVoiceButtonClick = useCallback(() => {
    if (disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice) {
      return
    }

    setVoiceError(null)

    if (isRecording) {
      void stopAndTranscribeRecording()
      return
    }

    void startInlineRecording()
  }, [
    blockedByLoading,
    disabled,
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    startInlineRecording,
    stopAndTranscribeRecording,
  ])

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

  const submitMessage = useCallback(() => {
    const trimmed = input.trim()
    const hasContent = trimmed.length > 0 || attachedFiles.length > 0
    if (!hasContent || disabled || blockedByLoading || isRecording || isTranscribingVoice) {
      return
    }

    onSend(
      trimmed,
      attachedFiles.length > 0
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
        : undefined,
    )

    setInputWithDraft('')
    setAttachedFilesWithDraft([])
    requestAnimationFrame(() => {
      onSubmitted?.()
    })
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

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      submitMessage()
    },
    [submitMessage],
  )

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    setInputWithDraft(command.prompt)
    setIsSlashMenuOpen(false)
    setSlashFilter('')
    setSlashSelectedIndex(0)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [setInputWithDraft])

  const selectMention = useCallback((agent: ProjectAgentSuggestion) => {
    // Replace the @token (from mentionTokenStart to current cursor) with @handle + space
    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? input.length
    const replacement = `[@${agent.handle}] `
    const newValue = input.slice(0, mentionTokenStart) + replacement + input.slice(cursorPos)
    setInputWithDraft(newValue)
    setIsMentionMenuOpen(false)
    setMentionFilter('')
    setMentionSelectedIndex(0)
    setMentionTokenStart(-1)
    const newCursor = mentionTokenStart + replacement.length
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(newCursor, newCursor)
    })
  }, [input, mentionTokenStart, setInputWithDraft])

  // --- Mention overlay helpers ---
  const syncOverlayScroll = useCallback(() => {
    if (overlayRef.current && textareaRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  const snapCursorOutOfMention = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const { selectionStart, selectionEnd } = textarea
    if (selectionStart !== selectionEnd) return
    const mention = findMentionContaining(input, selectionStart)
    if (mention && selectionStart > mention.start && selectionStart < mention.end) {
      const snapTo =
        selectionStart - mention.start <= mention.end - selectionStart
          ? mention.start
          : mention.end
      textarea.setSelectionRange(snapTo, snapTo)
    }
  }, [input])

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // @mention autocomplete keyboard handling
    if (isMentionMenuOpen && filteredMentions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionSelectedIndex((prev) => (prev + 1) % filteredMentions.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionSelectedIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        const selected = filteredMentions[mentionSelectedIndex]
        if (selected) selectMention(selected)
        return
      }
    }
    if (isMentionMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      setIsMentionMenuOpen(false)
      return
    }

    // Atomic backspace/delete for mention tokens
    if (hasMentionTokens && (event.key === 'Backspace' || event.key === 'Delete')) {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart === textarea.selectionEnd) {
        const pos = textarea.selectionStart
        const mention = findMentionContaining(input, pos)
        if (mention) {
          const shouldDelete =
            event.key === 'Backspace' ? pos > mention.start : pos < mention.end
          if (shouldDelete) {
            event.preventDefault()
            const newValue = input.slice(0, mention.start) + input.slice(mention.end)
            setInputWithDraft(newValue)
            requestAnimationFrame(() => {
              textarea.setSelectionRange(mention.start, mention.start)
            })
            return
          }
        }
      }
    }

    // Slash command autocomplete keyboard handling
    if (isSlashMenuOpen && filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % filteredSlashCommands.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        const selected = filteredSlashCommands[slashSelectedIndex]
        if (selected) selectSlashCommand(selected)
        return
      }
    }
    if (isSlashMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      setIsSlashMenuOpen(false)
      return
    }

    // Toggle format mode: Shift+Cmd+X (Mac) / Shift+Ctrl+X (Windows/Linux)
    if (event.key.toLowerCase() === 'x' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      toggleFormatMode()
      return
    }

    if (formatMode) {
      // Format mode: Enter inserts newline (default), Ctrl/Cmd+Enter sends
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submitMessage()
      }
      // Plain Enter: let the default textarea behavior insert a newline
    } else {
      // Quick-send mode: Enter sends, Shift+Enter inserts newline
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submitMessage()
      }
    }
  }

  // Track input changes for slash command and @mention detection
  const handleInputChange = useCallback((value: string) => {
    setInputWithDraft(value)

    // Check for slash command trigger: starts with `/` and has no whitespace in the command portion
    if (value.startsWith('/') && slashCommands && slashCommands.length > 0) {
      const afterSlash = value.slice(1)
      // Only show menu if we're still typing the command name (no spaces yet)
      if (!afterSlash.includes(' ') && !afterSlash.includes('\n')) {
        setSlashFilter(afterSlash)
        setIsSlashMenuOpen(true)
        setSlashSelectedIndex(0)
        setIsMentionMenuOpen(false)
        return
      }
    }
    setIsSlashMenuOpen(false)

    // Check for @mention trigger (works mid-text)
    if (projectAgents && projectAgents.length > 0) {
      const cursorPos = textareaRef.current?.selectionStart ?? value.length
      // Walk backward from cursor to find an @ that starts a mention token
      const textBeforeCursor = value.slice(0, cursorPos)
      const atIdx = textBeforeCursor.lastIndexOf('@')
      if (atIdx >= 0) {
        // The @ must be at start of input or preceded by whitespace/newline
        const charBefore = atIdx > 0 ? textBeforeCursor[atIdx - 1] : ' '
        const tokenAfterAt = textBeforeCursor.slice(atIdx + 1)
        // Token must be contiguous (no spaces/newlines) and reasonable length
        if (
          (charBefore === ' ' || charBefore === '\n' || charBefore === '\t' || atIdx === 0) &&
          !/[\s]/.test(tokenAfterAt) &&
          tokenAfterAt.length <= 50
        ) {
          setMentionFilter(tokenAfterAt)
          setMentionTokenStart(atIdx)
          setIsMentionMenuOpen(true)
          setMentionSelectedIndex(0)
          return
        }
      }
    }
    setIsMentionMenuOpen(false)
  }, [setInputWithDraft, slashCommands, projectAgents])

  const hasContent = input.trim().length > 0 || attachedFiles.length > 0
  const canSubmit = hasContent && !disabled && !blockedByLoading && !isRecording && !isTranscribingVoice
  const placeholder = placeholderOverride ?? (
    disabled
      ? 'Waiting for connection...'
      : allowWhileLoading && isLoading
        ? `Send another message to ${agentLabel}...`
        : `Message ${agentLabel}...`
  )

  const activeWaveformBars = useMemo(
    () => stretchWaveformBars(recordingWaveformBars, ACTIVE_WAVEFORM_BAR_COUNT),
    [recordingWaveformBars],
  )

  const voiceButtonDisabled = disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice

  return (
    <form onSubmit={handleSubmit} className="sticky bottom-0 shrink-0 bg-background p-2 md:p-3" data-tour="chat-input">
      {/* Slash command autocomplete dropdown */}
      {isSlashMenuOpen && filteredSlashCommands.length > 0 ? (
        <div
          ref={slashMenuRef}
          className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
        >
          {filteredSlashCommands.map((cmd, idx) => (
            <button
              key={cmd.id}
              type="button"
              className={cn(
                'flex w-full items-start gap-3 px-3 py-2 text-left text-sm transition-colors',
                idx === slashSelectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'text-popover-foreground hover:bg-accent/50',
              )}
              onMouseEnter={() => setSlashSelectedIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault() // prevent textarea blur
                selectSlashCommand(cmd)
              }}
            >
              <code className="shrink-0 text-xs font-semibold text-foreground">/{cmd.name}</code>
              <span className="line-clamp-1 text-xs text-muted-foreground">{cmd.prompt}</span>
            </button>
          ))}
        </div>
      ) : isSlashMenuOpen && slashCommands && slashCommands.length > 0 && filteredSlashCommands.length === 0 ? (
        <div
          ref={slashMenuRef}
          className="mb-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
        >
          <p className="text-xs text-muted-foreground">No matching commands</p>
        </div>
      ) : null}

      {/* @mention autocomplete dropdown */}
      {isMentionMenuOpen && filteredMentions.length > 0 ? (
        <div
          ref={mentionMenuRef}
          className="mb-1 max-h-52 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg"
        >
          {filteredMentions.map((agent, idx) => (
            <button
              key={agent.agentId}
              type="button"
              className={cn(
                'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                idx === mentionSelectedIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'text-popover-foreground hover:bg-accent/50',
              )}
              onMouseEnter={() => setMentionSelectedIndex(idx)}
              onMouseDown={(e) => {
                e.preventDefault() // prevent textarea blur
                selectMention(agent)
              }}
            >
              <div className="flex items-center gap-2">
                <code className="shrink-0 text-xs font-semibold text-foreground">@{agent.handle}</code>
                <span className="text-xs text-muted-foreground">{agent.displayName}</span>
              </div>
              {agent.whenToUse ? (
                <span className="line-clamp-1 text-xs text-muted-foreground">{agent.whenToUse}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : isMentionMenuOpen && projectAgents && projectAgents.length > 0 && filteredMentions.length === 0 ? (
        <div
          ref={mentionMenuRef}
          className="mb-1 rounded-lg border border-border bg-popover px-3 py-2 shadow-lg"
        >
          <p className="text-xs text-muted-foreground">No matching project agents</p>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-border">
        <AttachedFiles attachments={attachedFiles} onRemove={removeAttachment} />

        <div className="group flex flex-col">
          {formatMode && !isRecording ? (
            <div className="flex items-center gap-0.5 border-b border-border/40 px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => applyListFormatting(toggleBulletList)}
                disabled={disabled}
                aria-label="Bullet list"
              >
                <List className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                onClick={() => applyListFormatting(toggleNumberedList)}
                disabled={disabled}
                aria-label="Numbered list"
              >
                <ListOrdered className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {isRecording ? (
            <div className="flex min-h-[48px] items-center gap-2 border-b border-border/60 bg-red-500/[0.05] px-3 py-2">
              <div className="flex h-7 flex-1 items-center gap-px py-1" aria-hidden>
                {activeWaveformBars.map((bar, index) => {
                  const barHeight = Math.max(2, Math.round(bar * 18))
                  return (
                    <span
                      key={index}
                      className="flex-1 rounded-[1px] bg-red-500/60 transition-[height] duration-150 ease-out"
                      style={{ height: `${barHeight}px` }}
                    />
                  )
                })}
              </div>

              <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                {formatDuration(voiceRecordingDurationMs)}
              </span>

              <button
                type="button"
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                onClick={() => void stopAndTranscribeRecording()}
                disabled={voiceButtonDisabled}
                aria-label="Stop recording"
              >
                <Square className="size-2 fill-current" />
              </button>
            </div>
          ) : (
            <div className="relative">
              {hasMentionTokens && (
                <div
                  ref={overlayRef}
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-sm leading-normal text-foreground',
                    'px-4 pt-3 pb-2',
                  )}
                >
                  {renderMentionOverlay(input)}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                spellCheck
                onChange={(event) => handleInputChange(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onScroll={syncOverlayScroll}
                onSelect={hasMentionTokens ? snapCursorOutOfMention : undefined}
                placeholder={placeholder}
                disabled={disabled}
                rows={1}
                className={cn(
                  'relative w-full resize-none border-0 bg-transparent text-sm leading-normal shadow-none focus:outline-none',
                  hasMentionTokens
                    ? 'text-transparent placeholder:text-muted-foreground'
                    : 'text-foreground',
                  formatMode ? 'min-h-[120px]' : 'min-h-[44px]',
                  'px-4 pt-3 pb-2',
                  '[&::-webkit-scrollbar]:w-1.5',
                  '[&::-webkit-scrollbar-track]:bg-transparent',
                  '[&::-webkit-scrollbar-thumb]:bg-transparent',
                  '[&::-webkit-scrollbar-thumb]:rounded-full',
                  'group-hover:[&::-webkit-scrollbar-thumb]:bg-border',
                )}
                style={hasMentionTokens ? { caretColor: 'var(--foreground)' } : undefined}
              />
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
            aria-label="Attach files"
          />

          <div className="flex items-center justify-between px-1.5 pb-1.5 pt-1">
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 rounded-full transition-colors',
                  formatMode
                    ? 'bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={toggleFormatMode}
                disabled={disabled || isRecording}
                aria-label={formatMode ? 'Switch to quick-send mode' : 'Switch to format mode'}
                title={formatMode ? 'Quick-send mode (Enter to send)' : 'Format mode (Enter for new line)'}
              >
                <ALargeSmall className="size-3.5" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 rounded-full text-muted-foreground/60 hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || isRecording}
                aria-label="Attach files"
              >
                <Paperclip className="size-3.5" />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-7 rounded-full transition-colors',
                  isRecording
                    ? 'text-red-500 hover:bg-red-500/10 hover:text-red-600'
                    : 'text-muted-foreground/60 hover:text-foreground',
                )}
                onClick={handleVoiceButtonClick}
                disabled={voiceButtonDisabled}
                aria-label={isRecording ? 'Stop recording and transcribe' : 'Record voice input'}
              >
                {isRequestingMicrophone || isTranscribingVoice ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isRecording ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <Mic className="size-3.5" />
                )}
              </Button>

              {formatMode ? (
                <span className="ml-1 select-none text-[11px] text-muted-foreground/50">
                  {navigator.platform?.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}+Enter to send
                </span>
              ) : null}
            </div>

            <Button
              type="submit"
              disabled={!canSubmit}
              size="icon"
              className={cn(
                'size-7 rounded-full transition-all',
                canSubmit
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-95'
                  : 'cursor-default bg-muted text-muted-foreground/40',
              )}
              aria-label="Send message"
            >
              <ArrowUp className="size-3.5" strokeWidth={2.5} />
            </Button>
          </div>

          {voiceError ? <p className="px-3 pb-2 text-xs text-destructive">{voiceError}</p> : null}
        </div>
      </div>
    </form>
  )
})
