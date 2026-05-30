import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CODEX_MENTION_HANDLE,
  CODEX_MENTION_SUGGESTION,
  type MentionSuggestion,
  type ProjectAgentSuggestion,
  toProjectAgentMentionSuggestion,
} from '../mention-types'
import { hasComposerMentionTokens, isLeadingMentionPosition } from '../mention-utils'

interface UseMentionsOptions {
  projectAgents?: ProjectAgentSuggestion[]
  enableCodexMention?: boolean
  input: string
  setInputWithDraft: (value: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

interface UseMentionsReturn {
  isMentionMenuOpen: boolean
  setIsMentionMenuOpen: (open: boolean) => void
  mentionFilter: string
  mentionSelectedIndex: number
  setMentionSelectedIndex: (index: number) => void
  mentionTokenStart: number
  filteredMentions: MentionSuggestion[]
  mentionMenuRef: React.RefObject<HTMLDivElement | null>
  selectMention: (suggestion: MentionSuggestion) => void
  /** Check if the given value should open the mention menu. Returns true if handled. */
  checkMentionTrigger: (value: string) => boolean
  hasMentionTokens: boolean
}

function codexMentionMatchesFilter(filter: string): boolean {
  if (!filter) return true
  const lower = filter.toLowerCase()
  return CODEX_MENTION_HANDLE.toLowerCase().startsWith(lower)
}

export function useMentions({
  projectAgents,
  enableCodexMention = false,
  input,
  setInputWithDraft,
  textareaRef,
}: UseMentionsOptions): UseMentionsReturn {
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [mentionTokenStart, setMentionTokenStart] = useState(-1)
  const [mentionAtLeadingPosition, setMentionAtLeadingPosition] = useState(false)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)

  const hasMentionTokens = useMemo(() => hasComposerMentionTokens(input), [input])

  const filteredMentions = useMemo(() => {
    const suggestions: MentionSuggestion[] = []

    if (enableCodexMention && mentionAtLeadingPosition && codexMentionMatchesFilter(mentionFilter)) {
      suggestions.push(CODEX_MENTION_SUGGESTION)
    }

    if (projectAgents && projectAgents.length > 0) {
      const lower = mentionFilter.toLowerCase()
      const projectMatches = mentionFilter
        ? projectAgents.filter(
            (agent) =>
              agent.handle.toLowerCase().startsWith(lower) ||
              agent.displayName.toLowerCase().startsWith(lower),
          )
        : projectAgents

      suggestions.push(...projectMatches.map(toProjectAgentMentionSuggestion))
    }

    return suggestions
  }, [enableCodexMention, mentionAtLeadingPosition, mentionFilter, projectAgents])

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

  const selectMention = useCallback(
    (suggestion: MentionSuggestion) => {
      const textarea = textareaRef.current
      const cursorPos = textarea?.selectionStart ?? input.length
      const replacement =
        suggestion.kind === 'codex' ? `[@${CODEX_MENTION_HANDLE}] ` : `[@${suggestion.handle}] `
      const newValue = input.slice(0, mentionTokenStart) + replacement + input.slice(cursorPos)
      setInputWithDraft(newValue)
      setIsMentionMenuOpen(false)
      setMentionFilter('')
      setMentionSelectedIndex(0)
      setMentionTokenStart(-1)
      setMentionAtLeadingPosition(false)
      const newCursor = mentionTokenStart + replacement.length
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(newCursor, newCursor)
      })
    },
    [input, mentionTokenStart, setInputWithDraft, textareaRef],
  )

  const checkMentionTrigger = useCallback(
    (value: string): boolean => {
      const hasProjectAgents = !!(projectAgents && projectAgents.length > 0)
      if (!hasProjectAgents && !enableCodexMention) {
        setIsMentionMenuOpen(false)
        return false
      }

      const cursorPos = textareaRef.current?.selectionStart ?? value.length
      const textBeforeCursor = value.slice(0, cursorPos)
      const atIdx = textBeforeCursor.lastIndexOf('@')
      if (atIdx >= 0) {
        const charBefore = atIdx > 0 ? textBeforeCursor[atIdx - 1] : ' '
        const tokenAfterAt = textBeforeCursor.slice(atIdx + 1)
        if (
          (charBefore === ' ' || charBefore === '\n' || charBefore === '\t' || atIdx === 0) &&
          !/[\s]/.test(tokenAfterAt) &&
          tokenAfterAt.length <= 50
        ) {
          const isLeadingPosition = isLeadingMentionPosition(value, atIdx)
          const canOfferCodexMention = enableCodexMention && isLeadingPosition
          if (!hasProjectAgents && !canOfferCodexMention) {
            setIsMentionMenuOpen(false)
            setMentionAtLeadingPosition(false)
            return false
          }

          setMentionFilter(tokenAfterAt)
          setMentionTokenStart(atIdx)
          setMentionAtLeadingPosition(isLeadingPosition)
          setIsMentionMenuOpen(true)
          setMentionSelectedIndex(0)
          return true
        }
      }

      setIsMentionMenuOpen(false)
      setMentionAtLeadingPosition(false)
      return false
    },
    [enableCodexMention, projectAgents, textareaRef],
  )

  return {
    isMentionMenuOpen,
    setIsMentionMenuOpen,
    mentionFilter,
    mentionSelectedIndex,
    setMentionSelectedIndex,
    mentionTokenStart,
    filteredMentions,
    mentionMenuRef,
    selectMention,
    checkMentionTrigger,
    hasMentionTokens,
  }
}
