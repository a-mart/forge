/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProviderUsage } from './use-provider-usage'
import type { ProviderUsageStats } from '@forge/protocol'

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

function TestHarness({ enabled }: { enabled: boolean }) {
  const providers = useProviderUsage(enabled)
  return createElement('pre', { 'data-testid': 'providers' }, JSON.stringify(providers))
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  flushSync(() => {})
}

describe('useProviderUsage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount()
      })
    }

    root = null
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('keeps the last successful provider snapshot when a later poll fails', async () => {
    const goodSnapshot: ProviderUsageStats = {
      openai: {
        provider: 'openai',
        available: true,
        plan: 'pro',
      },
      anthropic: {
        provider: 'anthropic',
        available: true,
      },
    }

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => goodSnapshot,
      } as Response)
      .mockRejectedValueOnce(new Error('backend restarting'))

    globalThis.fetch = fetchMock

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(TestHarness, { enabled: true }))
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('openai')
      expect(container.textContent).toContain('anthropic')
    })

    await vi.advanceTimersByTimeAsync(180_000)
    await flushPromises()

    expect(container.textContent).toContain('openai')
    expect(container.textContent).toContain('anthropic')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
