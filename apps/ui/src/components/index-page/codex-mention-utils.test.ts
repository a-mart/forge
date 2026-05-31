import { describe, expect, it } from 'vitest'
import { shouldEnableCodexMention } from './codex-mention-utils'

describe('shouldEnableCodexMention', () => {
  it('enables Codex mention only for Builder manager sessions', () => {
    expect(shouldEnableCodexMention({ role: 'manager', sessionSurface: 'builder' })).toBe(true)
    expect(shouldEnableCodexMention({ role: 'manager' })).toBe(true)
    expect(shouldEnableCodexMention({ role: 'worker' })).toBe(false)
    expect(shouldEnableCodexMention(null)).toBe(false)
    expect(
      shouldEnableCodexMention({
        role: 'manager',
        sessionSurface: 'collab',
        collab: { workspaceId: 'ws-1', channelId: 'ch-1' },
      }),
    ).toBe(false)
  })
})
