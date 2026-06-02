import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchCodexCatalog } from '@/lib/codex-catalog-api'
import {
  CODEX_MENTION_HANDLE,
  CODEX_MENTION_SUGGESTION,
  type CodexToolMentionSuggestion,
  type MentionSuggestion,
  type ProjectAgentSuggestion,
  toProjectAgentMentionSuggestion,
} from '../mention-types'
import {
  hasComposerMentionTokens,
  isCodexToolPickerTrigger,
  isLeadingMentionPosition,
} from '../mention-utils'

interface UseMentionsOptions {
  projectAgents?: ProjectAgentSuggestion[]
  enableCodexMention?: boolean
  managerAgentId?: string
  wsUrl?: string
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
  codexCatalogLoading: boolean
}

function codexMentionMatchesFilter(filter: string): boolean {
  if (!filter) return true
  const lower = filter.toLowerCase()
  return CODEX_MENTION_HANDLE.toLowerCase().startsWith(lower)
}

function codexToolFilterFromTrigger(textBeforeCursor: string): string {
  const match = textBeforeCursor.match(/(?:^|\s)@codex\s*-\s*([^\s]*)$/i)
  return match?.[1]?.trim().toLowerCase() ?? ''
}

export function useMentions({
  projectAgents,
  enableCodexMention = false,
  managerAgentId,
  wsUrl,
  input,
  setInputWithDraft,
  textareaRef,
}: UseMentionsOptions): UseMentionsReturn {
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [mentionTokenStart, setMentionTokenStart] = useState(-1)
  const [mentionAtLeadingPosition, setMentionAtLeadingPosition] = useState(false)
  const [codexToolMode, setCodexToolMode] = useState(false)
  const [codexToolSuggestions, setCodexToolSuggestions] = useState<CodexToolMentionSuggestion[]>([])
  const [codexCatalogLoading, setCodexCatalogLoading] = useState(false)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)

  const hasMentionTokens = useMemo(() => hasComposerMentionTokens(input), [input])

  useEffect(() => {
    if (!codexToolMode || !enableCodexMention || !managerAgentId) {
      return
    }

    let cancelled = false
    setCodexCatalogLoading(true)

    void fetchCodexCatalog(wsUrl, managerAgentId).then((snapshot) => {
      if (cancelled) {
        return
      }

      const tools = (snapshot?.tools ?? []).map(
        (tool): CodexToolMentionSuggestion => ({
          kind: 'codex_tool',
          selector: tool.selector,
          displayName: tool.appName ? `${tool.appName} · ${tool.toolName}` : tool.selector,
          whenToUse: tool.description ?? `Call ${tool.selector} via Codex app-server`,
          serverName: tool.serverName,
          toolName: tool.toolName,
        }),
      )

      setCodexToolSuggestions(tools)
      setCodexCatalogLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [codexToolMode, enableCodexMention, managerAgentId, wsUrl])

  const filteredMentions = useMemo(() => {
    const suggestions: MentionSuggestion[] = []

    if (codexToolMode) {
      const lower = mentionFilter.toLowerCase()
      const toolMatches = mentionFilter
        ? codexToolSuggestions.filter(
            (tool) =>
              tool.selector.toLowerCase().includes(lower) ||
              tool.displayName.toLowerCase().includes(lower) ||
              tool.toolName.toLowerCase().includes(lower) ||
              tool.serverName.toLowerCase().includes(lower),
          )
        : codexToolSuggestions

      suggestions.push(...toolMatches.slice(0, 40))
      return suggestions
    }

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
  }, [
    codexToolMode,
    codexToolSuggestions,
    enableCodexMention,
    mentionAtLeadingPosition,
    mentionFilter,
    projectAgents,
  ])

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
      let replacement = ''
      if (suggestion.kind === 'codex') {
        replacement = `[@${CODEX_MENTION_HANDLE}] `
      } else if (suggestion.kind === 'codex_tool') {
        replacement = mentionAtLeadingPosition || codexToolMode
          ? `@Codex -${suggestion.selector} `
          : `[@Codex:${suggestion.selector}] `
      } else {
        replacement = `[@${suggestion.handle}] `
      }

      const newValue = input.slice(0, mentionTokenStart) + replacement + input.slice(cursorPos)
      setInputWithDraft(newValue)
      setIsMentionMenuOpen(false)
      setMentionFilter('')
      setMentionSelectedIndex(0)
      setMentionTokenStart(-1)
      setMentionAtLeadingPosition(false)
      setCodexToolMode(false)
      const newCursor = mentionTokenStart + replacement.length
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(newCursor, newCursor)
      })
    },
    [input, mentionAtLeadingPosition, mentionTokenStart, setInputWithDraft, textareaRef],
  )

  const checkMentionTrigger = useCallback(
    (value: string): boolean => {
      const hasProjectAgents = !!(projectAgents && projectAgents.length > 0)
      const cursorPos = textareaRef.current?.selectionStart ?? value.length
      const textBeforeCursor = value.slice(0, cursorPos)

      if (enableCodexMention && isCodexToolPickerTrigger(textBeforeCursor)) {
        const atIdx = textBeforeCursor.toLowerCase().lastIndexOf('@codex')
        setMentionFilter(codexToolFilterFromTrigger(textBeforeCursor))
        setMentionTokenStart(atIdx >= 0 ? atIdx : 0)
        setMentionAtLeadingPosition(isLeadingMentionPosition(value, atIdx >= 0 ? atIdx : 0))
        setCodexToolMode(true)
        setIsMentionMenuOpen(true)
        setMentionSelectedIndex(0)
        return true
      }

      if (!hasProjectAgents && !enableCodexMention) {
        setIsMentionMenuOpen(false)
        setCodexToolMode(false)
        return false
      }

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
            setCodexToolMode(false)
            return false
          }

          setMentionFilter(tokenAfterAt)
          setMentionTokenStart(atIdx)
          setMentionAtLeadingPosition(isLeadingPosition)
          setCodexToolMode(false)
          setIsMentionMenuOpen(true)
          setMentionSelectedIndex(0)
          return true
        }
      }

      setIsMentionMenuOpen(false)
      setMentionAtLeadingPosition(false)
      setCodexToolMode(false)
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
    codexCatalogLoading,
  }
}
