import { describe, expect, it, vi } from 'vitest'
import type { ExternalBrowserAcquireResult } from '../browser-target-adapter.js'
import { withSessionProfileConfirmation, type ProfileConfirmingChromeTransport } from '../automatic-chrome-profile-confirmation.js'

const ambiguous: ExternalBrowserAcquireResult = {
  ok: false,
  error: { code: 'attachment-required', message: 'Choose once.', retryable: false },
  metadata: { phase: 'discovery', mutationState: 'not-started', fallbackReason: 'ambiguous-instance' },
}
const acquired: ExternalBrowserAcquireResult = { ok: true, authority: { ownerEpoch: 1, tabId: 'ext.profile-b.7' } }
const input = { sessionAgentId: 'session-1', profileId: 'profile-1', operation: 'open' as const, preferredTabId: null, reuseExisting: false, createIfNeeded: true, ownerEpoch: 1 }

function fixture(results: ExternalBrowserAcquireResult[]) {
  const acquireTarget = vi.fn(async () => results.shift() ?? ambiguous)
  const confirmAutomaticInstance = vi.fn()
  const transport = {
    maxResponseBytes: 1024,
    execute: vi.fn(), acquireTarget, confirmAutomaticInstance,
    inventory: () => [
      { extensionInstanceId: 'profile-a', profileAlias: 'Work', chromeVersion: '1', shellAbi: 1, payloadVersion: '1', methods: [], supportedOperations: [], features: {}, connectedAt: '' },
      { extensionInstanceId: 'profile-b', profileAlias: 'Personal', chromeVersion: '1', shellAbi: 1, payloadVersion: '1', methods: [], supportedOperations: [], features: {}, connectedAt: '' },
    ],
  } as unknown as ProfileConfirmingChromeTransport
  return { transport, acquireTarget, confirmAutomaticInstance }
}

describe('session-only Chrome profile confirmation', () => {
  it('confirms one ambiguous profile and retries acquisition once', async () => {
    const value = fixture([ambiguous, acquired])
    const choose = vi.fn(async () => 1)
    const transport = withSessionProfileConfirmation(value.transport, choose)
    await expect(transport.acquireTarget!(input)).resolves.toEqual(acquired)
    expect(choose).toHaveBeenCalledWith(['Work', 'Personal'])
    expect(value.confirmAutomaticInstance).toHaveBeenCalledWith('session-1', 'profile-1', 'profile-b')
    expect(value.acquireTarget).toHaveBeenCalledTimes(2)
  })

  it('never prompts the same Forge session twice after dismissal', async () => {
    const value = fixture([ambiguous, ambiguous])
    const choose = vi.fn(async () => null)
    const transport = withSessionProfileConfirmation(value.transport, choose)
    await transport.acquireTarget!(input)
    await transport.acquireTarget!(input)
    expect(choose).toHaveBeenCalledTimes(1)
    expect(value.confirmAutomaticInstance).not.toHaveBeenCalled()
  })
})
