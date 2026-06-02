import { describe, expect, it } from 'vitest'
import {
  canOfferCodexMentionAtPosition,
  codexMentionMatchesFilter,
  codexPluginFilterFromTrigger,
  findCodexPluginTriggerStart,
  findMentionContaining,
  hasComposerMentionTokens,
  isCodexPluginPickerTrigger,
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
    expect(isCodexPluginPickerTrigger('@Codex -fire')).toBe(true)
    expect(isCodexPluginPickerTrigger('please @Codex -fire')).toBe(true)
  })

  it('detects plugin picker after [@Codex] chip token and colon triggers', () => {
    expect(isCodexPluginPickerTrigger('[@Codex] -')).toBe(true)
    expect(isCodexPluginPickerTrigger('[@Codex]-fire')).toBe(true)
    expect(isCodexPluginPickerTrigger('[@Codex]:')).toBe(true)
    expect(isCodexPluginPickerTrigger('@Codex:')).toBe(true)
    expect(isCodexPluginPickerTrigger('please [@Codex] -repo')).toBe(true)
    expect(codexPluginFilterFromTrigger('[@Codex] -fire')).toBe('fire')
    expect(findCodexPluginTriggerStart('[@Codex] -fire')).toBe(0)
    expect(findCodexPluginTriggerStart('please [@Codex] -repo')).toBe(7)
  })

  it('matches codex mention filters for inline prefixes', () => {
    expect(codexMentionMatchesFilter('C')).toBe(true)
    expect(codexMentionMatchesFilter('cod')).toBe(true)
    expect(codexMentionMatchesFilter('zzz')).toBe(false)
    expect(canOfferCodexMentionAtPosition('please @C', 7, 'C')).toBe(true)
    expect(canOfferCodexMentionAtPosition('please @', 7, '')).toBe(false)
  })
})
