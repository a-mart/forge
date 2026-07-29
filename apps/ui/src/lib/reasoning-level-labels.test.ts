import { describe, expect, it } from 'vitest'
import { formatReasoningLevel } from './reasoning-level-labels'

describe('formatReasoningLevel', () => {
  it('distinguishes xhigh from max for Opus 5', () => {
    expect(formatReasoningLevel('xhigh', ['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('Extra High')
    expect(formatReasoningLevel('max', ['none', 'low', 'medium', 'high', 'xhigh', 'max'])).toBe('Max')
  })

  it('keeps legacy xhigh-only models labeled Max', () => {
    expect(formatReasoningLevel('xhigh', ['low', 'medium', 'high', 'xhigh'])).toBe('Max')
    expect(formatReasoningLevel('xhigh')).toBe('Max')
  })
})
