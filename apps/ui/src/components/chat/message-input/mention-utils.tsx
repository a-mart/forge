import type { ReactNode } from 'react'
import { CODEX_MENTION_HANDLE } from './mention-types'

export const MENTION_TOKEN_RE = /\[@[^\]]+\]/gi
export const CODEX_INLINE_TOOL_TOKEN_RE = /@codex:[^\s]+/gi

/** True when the @ trigger sits at the leading edge of the composer text. */
export function isLeadingMentionPosition(text: string, atIdx: number): boolean {
  return text.slice(0, atIdx).trim().length === 0
}

function normalizeMentionHandle(token: string): string {
  if (token.startsWith('[@') && token.endsWith(']')) {
    return token.slice(2, -1).trim()
  }

  if (token.toLowerCase().startsWith('@codex:')) {
    return token.slice('@codex:'.length).trim()
  }

  return token.slice(1).trim()
}

function isCodexMentionToken(token: string): boolean {
  const handle = normalizeMentionHandle(token)
  return handle.toLowerCase() === CODEX_MENTION_HANDLE.toLowerCase()
}

function isCodexToolMentionToken(token: string): boolean {
  const lower = token.toLowerCase()
  if (lower.startsWith('[@codex:') && lower.endsWith(']')) {
    return true
  }

  return lower.startsWith('@codex:')
}

/** Find the mention token range that contains or is bounded by the given cursor position. */
export function findMentionContaining(text: string, pos: number): { start: number; end: number } | null {
  const patterns = [MENTION_TOKEN_RE, CODEX_INLINE_TOOL_TOKEN_RE]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!
      const end = start + match[0].length
      if (pos >= start && pos <= end) {
        return { start, end }
      }
    }
  }

  return null
}

/** Render text with [@handle] and @Codex:tool tokens as styled mention chips for the overlay. */
export function renderMentionOverlay(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  let lastIdx = 0
  const combined = new RegExp(`${MENTION_TOKEN_RE.source}|${CODEX_INLINE_TOOL_TOKEN_RE.source}`, 'gi')

  for (const match of text.matchAll(combined)) {
    const start = match.index!
    const end = start + match[0].length
    if (start > lastIdx) {
      parts.push(text.slice(lastIdx, start))
    }
    const token = match[0]
    const handle = normalizeMentionHandle(token)
    const isCodex = isCodexMentionToken(token)
    const isCodexTool = isCodexToolMentionToken(token)
    parts.push(
      <span
        key={start}
        className={
          isCodex || isCodexTool
            ? 'rounded-sm bg-emerald-500/15 dark:bg-emerald-400/15'
            : 'rounded-sm bg-blue-500/10 dark:bg-blue-400/10'
        }
      >
        {token.startsWith('[') ? <span className="text-transparent">[</span> : null}
        <span
          className={
            isCodex || isCodexTool
              ? 'font-medium text-emerald-700 dark:text-emerald-300'
              : 'text-blue-600 dark:text-blue-400'
          }
        >
          {isCodexTool ? `@Codex:${handle}` : `@${handle}`}
        </span>
        {token.startsWith('[') ? <span className="text-transparent">]</span> : null}
      </span>,
    )
    lastIdx = end
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  parts.push('\n')
  return parts
}

export function hasComposerMentionTokens(text: string): boolean {
  return /\[@[^\]]+\]/i.test(text) || CODEX_INLINE_TOOL_TOKEN_RE.test(text)
}

export function isCodexToolPickerTrigger(textBeforeCursor: string): boolean {
  return /(?:^|\s)@codex\s*-\s*[^\s]*$/i.test(textBeforeCursor)
}
