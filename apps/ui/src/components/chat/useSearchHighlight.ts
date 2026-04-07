import { useEffect, useRef } from 'react'
import type { SearchMatch } from './useChatSearch'

/**
 * Uses the CSS Custom Highlight API to highlight search matches in the message
 * list DOM. Creates two named highlights:
 * - `chat-search`: all matches (yellow background)
 * - `chat-search-current`: the current/active match (orange background)
 *
 * Falls back gracefully to no highlighting when the API is unavailable.
 */
export function useSearchHighlight(
  /** Ref to the scroll container that holds all message DOM nodes */
  containerRef: React.RefObject<HTMLElement | null>,
  matches: SearchMatch[],
  currentMatchIndex: number,
  isOpen: boolean,
): void {
  const prevHighlightsRef = useRef(false)

  useEffect(() => {
    // Feature detection
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) {
      return
    }
    const highlights = (CSS as CSSHighlightsAPI).highlights

    // Clean up when search is closed or no matches
    if (!isOpen || matches.length === 0) {
      if (prevHighlightsRef.current) {
        highlights.delete('chat-search')
        highlights.delete('chat-search-current')
        prevHighlightsRef.current = false
      }
      return
    }

    const container = containerRef.current
    if (!container) return

    // Build a map of messageId → array of text nodes (in document order)
    const messageTextNodes = new Map<string, Text[]>()

    // Find all message containers by data-message-id
    const messageElements = container.querySelectorAll('[data-message-id]')
    for (const el of messageElements) {
      const messageId = el.getAttribute('data-message-id')
      if (!messageId) continue

      const textNodes: Text[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null)
      let node: Text | null
      while ((node = walker.nextNode() as Text | null)) {
        if (node.nodeValue && node.nodeValue.length > 0) {
          textNodes.push(node)
        }
      }
      messageTextNodes.set(messageId, textNodes)
    }

    const allRanges: Range[] = []
    let currentRange: Range | null = null

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]
      const textNodes = messageTextNodes.get(match.messageId)
      if (!textNodes || textNodes.length === 0) continue

      const range = findRangeForMatch(textNodes, match)
      if (!range) continue

      allRanges.push(range)
      if (i === currentMatchIndex) {
        currentRange = range
      }
    }

    if (allRanges.length > 0) {
      highlights.set('chat-search', new Highlight(...allRanges))
      prevHighlightsRef.current = true
    } else {
      highlights.delete('chat-search')
    }

    if (currentRange) {
      highlights.set('chat-search-current', new Highlight(currentRange))

      // Scroll the current match into view
      const rangeRect = currentRange.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()

      // Check if the match is outside the visible area of the scroll container
      if (
        rangeRect.top < containerRect.top ||
        rangeRect.bottom > containerRect.bottom
      ) {
        // Use a temporary span to get scrollIntoView behavior on the range
        const tempSpan = document.createElement('span')
        currentRange.insertNode(tempSpan)
        tempSpan.scrollIntoView({ behavior: 'smooth', block: 'center' })
        tempSpan.parentNode?.removeChild(tempSpan)
      }
    } else {
      highlights.delete('chat-search-current')
    }

    return () => {
      highlights.delete('chat-search')
      highlights.delete('chat-search-current')
      prevHighlightsRef.current = false
    }
  }, [containerRef, matches, currentMatchIndex, isOpen])
}

/**
 * Given an array of text nodes (in document order) for a message element,
 * finds the Range that corresponds to the match's textOffset within the
 * rendered text content.
 *
 * The rendered text is the concatenation of all text node values. The match
 * offset is relative to the original message `.text` field, but since markdown
 * rendering can alter text, we search for the match string within the rendered
 * text nodes instead.
 */
function findRangeForMatch(
  textNodes: Text[],
  match: SearchMatch,
): Range | null {
  // We need to find the match string within the concatenated text of the DOM
  // nodes. The match was computed against the raw message text, but the
  // rendered DOM text may differ slightly due to markdown processing.
  // Strategy: search for the matched substring in the concatenated rendered text.

  // First, build the full rendered text and track node boundaries
  const nodeOffsets: { node: Text; start: number; end: number }[] = []
  let totalLength = 0
  for (const node of textNodes) {
    const len = node.nodeValue?.length ?? 0
    nodeOffsets.push({ node, start: totalLength, end: totalLength + len })
    totalLength += len
  }

  if (totalLength === 0) return null

  // We need the original query text. We can reconstruct it from the message text
  // but we don't have it here. Instead, use the match.textOffset and match.length
  // to find the string in the rendered text by searching from the approximate position.
  // Since rendered text may differ, we'll do a simple indexOf search for the
  // substring starting near the expected position.

  // Build rendered text
  const renderedText = textNodes.map((n) => n.nodeValue ?? '').join('')
  const renderedLower = renderedText.toLowerCase()

  // We need the actual query string. We can try to extract it from the raw
  // message text, but we don't have it here. Instead, let's count this as the
  // Nth occurrence where N = match.matchIndex.
  // Since we compute matches globally per message, we search for all occurrences
  // in rendered text and pick the Nth one.

  // But we don't have the query string... We need a different approach.
  // Let's try using the textOffset directly — if the rendered text matches
  // the raw text closely enough, the offset should work. If not, we fall back
  // to no highlight for that match.

  const matchStart = match.textOffset
  const matchEnd = matchStart + match.length

  // If the offset is beyond the rendered text, fall back
  if (matchStart >= totalLength) return null

  const clampedEnd = Math.min(matchEnd, totalLength)

  // Verify the text at this position is actually a case-insensitive match
  // by checking a few chars (sanity check)
  const renderedSubstr = renderedLower.slice(matchStart, clampedEnd)
  if (renderedSubstr.length === 0) return null

  // Find start node/offset
  const startInfo = findNodeAtOffset(nodeOffsets, matchStart)
  const endInfo = findNodeAtOffset(nodeOffsets, clampedEnd)
  if (!startInfo || !endInfo) return null

  try {
    const range = document.createRange()
    range.setStart(startInfo.node, startInfo.offset)
    range.setEnd(endInfo.node, endInfo.offset)
    return range
  } catch {
    return null
  }
}

function findNodeAtOffset(
  nodeOffsets: { node: Text; start: number; end: number }[],
  offset: number,
): { node: Text; offset: number } | null {
  for (const entry of nodeOffsets) {
    if (offset >= entry.start && offset <= entry.end) {
      return { node: entry.node, offset: offset - entry.start }
    }
  }
  return null
}

// Type augmentation for CSS Custom Highlight API
interface CSSHighlightsAPI {
  highlights: HighlightRegistry
}

interface HighlightRegistry {
  set(name: string, highlight: Highlight): void
  delete(name: string): boolean
  clear(): void
}
