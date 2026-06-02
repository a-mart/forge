import { describe, expect, it } from 'vitest'
import {
  findMentionContaining,
  hasComposerMentionTokens,
  isCodexToolPickerTrigger,
  isLeadingMentionPosition,
  renderMentionOverlay,
} from './mention-utils'

describe('mention-utils codex support', () => {
  it('detects leading mention position', () => {
    expect(isLeadingMentionPosition('@Codex hello', 0)).toBe(true)
    expect(isLeadingMentionPosition('  @Codex hello', 2)).toBe(true)
    expect(isLeadingMentionPosition('please @Codex later', 7)).toBe(false)
  })

  it('matches codex mention tokens case-insensitively', () => {
    expect(hasComposerMentionTokens('[@Codex] summarize')).toBe(true)
    expect(hasComposerMentionTokens('[@codex] summarize')).toBe(true)
  })

  it('finds mention token ranges for codex tokens', () => {
    expect(findMentionContaining('[@Codex] hello', 3)).toEqual({ start: 0, end: 8 })
  })

  it('renders codex tokens with distinct styling marker', () => {
    const nodes = renderMentionOverlay('[@Codex] ping [@docs]')
    const rendered = JSON.stringify(nodes)
    expect(rendered).toContain('emerald')
    expect(rendered).toContain('blue')
  })

  it('detects inline codex tool tokens and picker trigger', () => {
    expect(hasComposerMentionTokens('run @Codex:fireflies now')).toBe(true)
    expect(findMentionContaining('run @Codex:fireflies now', 10)).toEqual({ start: 4, end: 20 })
    expect(isCodexToolPickerTrigger('@Codex -fire')).toBe(true)
    expect(isCodexToolPickerTrigger('please @Codex -fire')).toBe(true)
  })
})
