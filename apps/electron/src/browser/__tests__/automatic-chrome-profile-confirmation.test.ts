import { describe, expect, it, vi } from 'vitest'
import type { ExternalBrowserAcquireResult } from '../browser-target-adapter.js'
import { withSessionProfileConfirmation, type ProfileConfirmingChromeTransport } from '../automatic-chrome-profile-confirmation.js'

const ambiguous: ExternalBrowserAcquireResult = {
  ok: false,
  error: { code: 'target-not-found', message: 'Choose once.', retryable: false },
  metadata: { phase: 'discovery', mutationState: 'not-started', fallbackReason: 'ambiguous-instance' },
}
const acquired: ExternalBrowserAcquireResult = { ok: true, authority: { ownerEpoch: 1, tabId: 'ext.profile-b.7' } }
const input = { sessionAgentId: 'session-1', profileId: 'profile-1', operation: 'open' as const, preferredTabId: null, reuseExisting: false, createIfNeeded: true, ownerEpoch: 1 }

function fixture(results: ExternalBrowserAcquireResult[], confirm = true) {
  const acquireTarget = vi.fn(async () => results.shift() ?? ambiguous)
  const confirmAutomaticChoice = vi.fn(() => confirm)
  const automaticProfileChoices = vi.fn(() => [
    { token: 'ready-token-a', label: 'Chrome profile 1' },
    { token: 'ready-token-b', label: 'Chrome profile 2' },
  ])
  const transport = {
    maxResponseBytes: 1024,
    execute: vi.fn(), acquireTarget, confirmAutomaticChoice, automaticProfileChoices,
  } as unknown as ProfileConfirmingChromeTransport
  return { transport, acquireTarget, confirmAutomaticChoice, automaticProfileChoices }
}

describe('session-only Chrome profile confirmation', () => {
  it('confirms one opaque ready-set choice and retries acquisition once', async () => {
    const value = fixture([ambiguous, acquired])
    const choose = vi.fn(async () => 1)
    const transport = withSessionProfileConfirmation(value.transport, choose)
    await expect(transport.acquireTarget!(input)).resolves.toEqual(acquired)
    expect(choose).toHaveBeenCalledWith(['Chrome profile 1', 'Chrome profile 2'])
    expect(value.confirmAutomaticChoice).toHaveBeenCalledWith('session-1', 'profile-1', 'ready-token-b')
    expect(value.acquireTarget).toHaveBeenCalledTimes(2)
  })

  it('fails not-started without throwing when the ready choice disappears before confirmation', async () => {
    const value = fixture([ambiguous], false)
    const transport = withSessionProfileConfirmation(value.transport, vi.fn(async () => 1))
    await expect(transport.acquireTarget!(input)).resolves.toEqual(ambiguous)
    expect(value.acquireTarget).toHaveBeenCalledTimes(1)
    expect(value.confirmAutomaticChoice).toHaveBeenCalledWith('session-1', 'profile-1', 'ready-token-b')
  })

  it('uses only exact ready choices and never prompts the same Forge session twice after a reconnect race', async () => {
    const value = fixture([ambiguous, ambiguous])
    value.automaticProfileChoices.mockReturnValue([
      { token: 'ready-a', label: 'Chrome profile 1' },
      { token: 'ready-c', label: 'Chrome profile 2' },
    ])
    const choose = vi.fn(async () => null)
    const transport = withSessionProfileConfirmation(value.transport, choose)
    await transport.acquireTarget!(input)
    await transport.acquireTarget!(input)
    expect(choose).toHaveBeenCalledTimes(1)
    expect(choose).toHaveBeenCalledWith(['Chrome profile 1', 'Chrome profile 2'])
    expect(value.confirmAutomaticChoice).not.toHaveBeenCalled()
  })
})
