import { describe, expect, it } from 'vitest'
import { shouldEnableCodexMention } from './codex-mention-utils'

describe('shouldEnableCodexMention', () => {
  it('enables Codex mention only for manager sessions', () => {
    expect(shouldEnableCodexMention({ role: 'manager' })).toBe(true)
    expect(shouldEnableCodexMention({ role: 'worker' })).toBe(false)
    expect(shouldEnableCodexMention(null)).toBe(false)
  })
})
