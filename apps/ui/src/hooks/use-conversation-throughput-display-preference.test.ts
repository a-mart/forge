/** @vitest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONVERSATION_THROUGHPUT_DISPLAY_KEY,
  storeConversationThroughputDisplayPref,
} from '@/lib/sidebar-prefs'
import { useConversationThroughputDisplayPreference } from './use-conversation-throughput-display-preference'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => { values.clear() },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

function PreferenceHarness({ id }: { id: string }) {
  const [enabled, setEnabled] = useConversationThroughputDisplayPreference()
  return createElement('button', {
    type: 'button',
    'data-testid': id,
    'data-enabled': String(enabled),
    onClick: () => setEnabled(!enabled),
  })
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useConversationThroughputDisplayPreference', () => {
  it('defaults to hidden when the preference is unset', () => {
    act(() => {
      root.render(createElement(PreferenceHarness, { id: 'preference' }))
    })

    expect(container.querySelector('[data-testid="preference"]')?.getAttribute('data-enabled')).toBe('false')
  })

  it('hydrates the persisted enabled preference', () => {
    localStorage.setItem(CONVERSATION_THROUGHPUT_DISPLAY_KEY, 'true')

    act(() => {
      root.render(createElement(PreferenceHarness, { id: 'preference' }))
    })

    expect(container.querySelector('[data-testid="preference"]')?.getAttribute('data-enabled')).toBe('true')
  })

  it('hydrates a stored enabled preference without a recoverable SSR mismatch', async () => {
    localStorage.setItem(CONVERSATION_THROUGHPUT_DISPLAY_KEY, 'true')
    const serverMarkup = renderToString(createElement(PreferenceHarness, { id: 'preference' }))
    expect(serverMarkup).toContain('data-enabled="false"')

    act(() => root.unmount())
    container.innerHTML = serverMarkup
    const onRecoverableError = vi.fn()
    act(() => {
      root = hydrateRoot(container, createElement(PreferenceHarness, { id: 'preference' }), {
        onRecoverableError,
      })
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="preference"]')?.getAttribute('data-enabled')).toBe('true')
  })

  it('persists and immediately synchronizes every mounted conversation surface', () => {
    act(() => {
      root.render(createElement('div', null,
        createElement(PreferenceHarness, { id: 'first' }),
        createElement(PreferenceHarness, { id: 'second' }),
      ))
    })

    act(() => {
      ;(container.querySelector('[data-testid="first"]') as HTMLButtonElement).click()
    })

    expect(localStorage.getItem(CONVERSATION_THROUGHPUT_DISPLAY_KEY)).toBe('true')
    expect(container.querySelector('[data-testid="first"]')?.getAttribute('data-enabled')).toBe('true')
    expect(container.querySelector('[data-testid="second"]')?.getAttribute('data-enabled')).toBe('true')

    act(() => {
      storeConversationThroughputDisplayPref(false)
    })

    expect(container.querySelector('[data-testid="first"]')?.getAttribute('data-enabled')).toBe('false')
    expect(container.querySelector('[data-testid="second"]')?.getAttribute('data-enabled')).toBe('false')
  })
})
