import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectAgentSuggestion } from '../types'

interface UseMentionsOptions {
  projectAgents?: ProjectAgentSuggestion[]
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
  filteredMentions: ProjectAgentSuggestion[]
  mentionMenuRef: React.RefObject<HTMLDivElement | null>
  selectMention: (agent: ProjectAgentSuggestion) => void
  /** Check if the given value should open the mention menu. Returns true if handled. */
  checkMentionTrigger: (value: string) => boolean
  hasMentionTokens: boolean
}

export function useMentions({
  projectAgents,
  input,
  setInputWithDraft,
  textareaRef,
}: UseMentionsOptions): UseMentionsReturn {
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [mentionTokenStart, setMentionTokenStart] = useState(-1)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)

  const hasMentionTokens = useMemo(() => /\[@[^\]]+\]/.test(input), [input])

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

  const selectMention = useCallback(
    (agent: ProjectAgentSuggestion) => {
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
    },
    [input, mentionTokenStart, setInputWithDraft, textareaRef],
  )

  const checkMentionTrigger = useCallback(
    (value: string): boolean => {
      if (projectAgents && projectAgents.length > 0) {
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
            setMentionFilter(tokenAfterAt)
            setMentionTokenStart(atIdx)
            setIsMentionMenuOpen(true)
            setMentionSelectedIndex(0)
            return true
          }
        }
      }
      setIsMentionMenuOpen(false)
      return false
    },
    [projectAgents, textareaRef],
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
