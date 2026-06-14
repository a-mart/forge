import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodexCatalogPlugin } from '@/lib/codex-catalog-api'
import {
  ensureCodexCatalogWarm,
  fetchCodexCatalogWithCache,
  getCachedCodexCatalog,
} from '@/lib/codex-catalog-cache'
import {
  CODEX_MENTION_HANDLE,
  CODEX_MENTION_SUGGESTION,
  type CodexPluginMentionSuggestion,
  type MentionSuggestion,
  type ProjectAgentSuggestion,
  toProjectAgentMentionSuggestion,
} from '../mention-types'
import type { MentionMenuStatus } from '../mention-menu-a11y'
import {
  canOfferCodexMentionAtPosition,
  codexMentionMatchesFilter,
  codexPluginFilterFromTrigger,
  findCodexPluginTriggerStart,
  hasComposerMentionTokens,
  isCodexPluginPickerTrigger,
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
  moveMentionSelection: (delta: number) => void
  mentionTokenStart: number
  filteredMentions: MentionSuggestion[]
  mentionMenuRef: React.RefObject<HTMLDivElement | null>
  selectMention: (suggestion: MentionSuggestion) => void
  /** Check if the given value should open the mention menu. Returns true if handled. */
  checkMentionTrigger: (value: string) => boolean
  hasMentionTokens: boolean
  codexCatalogLoading: boolean
  codexCatalogError: boolean
  codexToolMode: boolean
  mentionMenuStatus: MentionMenuStatus | null
  mentionMenuBlocksQuickSend: boolean
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
  const [codexPluginSuggestions, setCodexPluginSuggestions] = useState<CodexPluginMentionSuggestion[]>([])
  const [codexCatalogLoading, setCodexCatalogLoading] = useState(false)
  const [codexCatalogError, setCodexCatalogError] = useState(false)
  const mentionMenuRef = useRef<HTMLDivElement | null>(null)

  const hasMentionTokens = useMemo(() => hasComposerMentionTokens(input), [input])

  const mapPluginsToSuggestions = useCallback(
    (plugins: CodexCatalogPlugin[]): CodexPluginMentionSuggestion[] =>
      plugins.map(
        (plugin): CodexPluginMentionSuggestion => ({
          kind: 'codex_plugin',
          selector: plugin.selector,
          displayName: plugin.displayName,
          whenToUse: plugin.description ?? `Use the ${plugin.displayName} Codex plugin`,
          category: plugin.category,
          riskHints: plugin.riskHints,
        }),
      ),
    [],
  )

  useEffect(() => {
    if (!enableCodexMention || !managerAgentId) {
      return
    }

    ensureCodexCatalogWarm(wsUrl, managerAgentId)
  }, [enableCodexMention, managerAgentId, wsUrl])

  useEffect(() => {
    if (!codexToolMode || !enableCodexMention || !managerAgentId) {
      return
    }

    let cancelled = false
    const cached = getCachedCodexCatalog(managerAgentId)
    if (cached) {
      setCodexPluginSuggestions(mapPluginsToSuggestions(cached.plugins ?? []))
      setCodexCatalogError(false)
      setCodexCatalogLoading(false)
    } else {
      setCodexCatalogLoading(true)
      setCodexCatalogError(false)
    }

    void fetchCodexCatalogWithCache(wsUrl, managerAgentId).then((result) => {
      if (cancelled) {
        return
      }

      if (result.status === 'error') {
        if (!cached) {
          setCodexPluginSuggestions([])
          setCodexCatalogError(true)
        }
        setCodexCatalogLoading(false)
        return
      }

      setCodexPluginSuggestions(mapPluginsToSuggestions(result.snapshot.plugins ?? []))
      setCodexCatalogError(false)
      setCodexCatalogLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [codexToolMode, enableCodexMention, managerAgentId, mapPluginsToSuggestions, wsUrl])

  const filteredMentions = useMemo(() => {
    const suggestions: MentionSuggestion[] = []

    if (codexToolMode) {
      const lower = mentionFilter.toLowerCase()
      const pluginMatches = mentionFilter
        ? codexPluginSuggestions.filter(
            (plugin) =>
              plugin.selector.toLowerCase().includes(lower) ||
              plugin.displayName.toLowerCase().includes(lower) ||
              plugin.whenToUse.toLowerCase().includes(lower) ||
              (plugin.category?.toLowerCase().includes(lower) ?? false),
          )
        : codexPluginSuggestions

      suggestions.push(...pluginMatches.slice(0, 40))
      return suggestions
    }

    if (
      enableCodexMention &&
      codexMentionMatchesFilter(mentionFilter) &&
      (mentionAtLeadingPosition || mentionFilter.length > 0)
    ) {
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
    codexPluginSuggestions,
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

  useEffect(() => {
    if (!isMentionMenuOpen || filteredMentions.length === 0) {
      return
    }
    if (mentionSelectedIndex >= filteredMentions.length) {
      setMentionSelectedIndex(0)
      return
    }

    const option = mentionMenuRef.current?.querySelector<HTMLElement>(
      `[role="option"][aria-selected="true"]`,
    )
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [filteredMentions.length, isMentionMenuOpen, mentionSelectedIndex])

  const moveMentionSelection = useCallback(
    (delta: number) => {
      setMentionSelectedIndex((current) => {
        const count = filteredMentions.length
        if (count === 0) {
          return 0
        }
        return (current + delta + count) % count
      })
    },
    [filteredMentions.length],
  )

  const selectMention = useCallback(
    (suggestion: MentionSuggestion) => {
      const textarea = textareaRef.current
      const cursorPos = textarea?.selectionStart ?? input.length
      let replacement = ''
      if (suggestion.kind === 'codex') {
        replacement = `[@${CODEX_MENTION_HANDLE}]`
      } else if (suggestion.kind === 'codex_plugin') {
        replacement = `[@Codex:${suggestion.selector}]`
      } else if (suggestion.kind === 'project_agent') {
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
    [input, mentionTokenStart, setInputWithDraft, textareaRef],
  )

  const checkMentionTrigger = useCallback(
    (value: string): boolean => {
      const hasProjectAgents = !!(projectAgents && projectAgents.length > 0)
      const cursorPos = textareaRef.current?.selectionStart ?? value.length
      const textBeforeCursor = value.slice(0, cursorPos)

      if (enableCodexMention && isCodexPluginPickerTrigger(textBeforeCursor)) {
        const tokenStart = findCodexPluginTriggerStart(textBeforeCursor)
        setMentionFilter(codexPluginFilterFromTrigger(textBeforeCursor))
        setMentionTokenStart(tokenStart)
        setMentionAtLeadingPosition(isLeadingMentionPosition(value, tokenStart))
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
          const canOfferCodexMention =
            enableCodexMention && canOfferCodexMentionAtPosition(value, atIdx, tokenAfterAt)
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

  const mentionMenuStatus = useMemo((): MentionMenuStatus | null => {
    if (!isMentionMenuOpen) {
      return null
    }

    if (codexToolMode) {
      if (codexCatalogLoading) {
        return 'loading'
      }
      if (codexCatalogError) {
        return 'error'
      }
      if (filteredMentions.length > 0) {
        return 'list'
      }
      return codexPluginSuggestions.length === 0 ? 'empty-catalog' : 'empty-filter'
    }

    if (filteredMentions.length > 0) {
      return 'list'
    }

    if ((projectAgents?.length ?? 0) > 0 || enableCodexMention) {
      return 'empty-filter'
    }

    return null
  }, [
    codexCatalogError,
    codexCatalogLoading,
    codexToolMode,
    codexPluginSuggestions.length,
    enableCodexMention,
    filteredMentions.length,
    isMentionMenuOpen,
    projectAgents,
  ])

  const mentionMenuBlocksQuickSend = isMentionMenuOpen && mentionMenuStatus !== 'list'

  return {
    isMentionMenuOpen,
    setIsMentionMenuOpen,
    mentionFilter,
    mentionSelectedIndex,
    setMentionSelectedIndex,
    moveMentionSelection,
    mentionTokenStart,
    filteredMentions,
    mentionMenuRef,
    selectMention,
    checkMentionTrigger,
    hasMentionTokens,
    codexCatalogLoading,
    codexCatalogError,
    codexToolMode,
    mentionMenuStatus,
    mentionMenuBlocksQuickSend,
  }
}
