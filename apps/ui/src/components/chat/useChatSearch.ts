import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { ConversationEntry } from '@forge/protocol'

export interface SearchMatch {
  /** The message ID (same as data-message-id in the DOM) */
  messageId: string
  /** Which occurrence within this message (0-based) */
  matchIndex: number
  /** Character offset within the message text */
  textOffset: number
  /** Length of the matched substring */
  length: number
}

export interface ChatSearchState {
  isOpen: boolean
  query: string
  setQuery: (query: string) => void
  matches: SearchMatch[]
  currentMatchIndex: number
  totalMatches: number
  next: () => void
  prev: () => void
  open: () => void
  close: () => void
}

function resolveMessageId(
  message: Extract<ConversationEntry, { type: 'conversation_message' }>,
): string {
  const id = message.id?.trim()
  return id && id.length > 0 ? id : message.timestamp
}

function computeMatches(
  messages: ConversationEntry[],
  query: string,
): SearchMatch[] {
  if (!query) return []

  const lowerQuery = query.toLowerCase()
  const results: SearchMatch[] = []

  for (const message of messages) {
    if (message.type !== 'conversation_message') continue
    if (!message.text) continue

    const messageId = resolveMessageId(message)
    const lowerText = message.text.toLowerCase()
    let matchIndex = 0
    let startPos = 0

    while (startPos < lowerText.length) {
      const found = lowerText.indexOf(lowerQuery, startPos)
      if (found === -1) break

      results.push({
        messageId,
        matchIndex,
        textOffset: found,
        length: query.length,
      })
      matchIndex++
      startPos = found + 1
    }
  }

  return results
}

export function useChatSearch(messages: ConversationEntry[]): ChatSearchState {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedQuery, setDebouncedQuery] = useState('')

  // Debounce query updates
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query)
    }, 150)
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [query])

  const matches = useMemo(
    () => computeMatches(messages, debouncedQuery),
    [messages, debouncedQuery],
  )

  // Clamp currentMatchIndex when matches change
  useEffect(() => {
    if (matches.length === 0) {
      setCurrentMatchIndex(0)
    } else if (currentMatchIndex >= matches.length) {
      setCurrentMatchIndex(matches.length - 1)
    }
  }, [matches.length, currentMatchIndex])

  const next = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length)
  }, [matches.length])

  const prev = useCallback(() => {
    if (matches.length === 0) return
    setCurrentMatchIndex((prev) => (prev - 1 + matches.length) % matches.length)
  }, [matches.length])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setQuery('')
    setDebouncedQuery('')
    setCurrentMatchIndex(0)
  }, [])

  return {
    isOpen,
    query,
    setQuery,
    matches,
    currentMatchIndex,
    totalMatches: matches.length,
    next,
    prev,
    open,
    close,
  }
}
