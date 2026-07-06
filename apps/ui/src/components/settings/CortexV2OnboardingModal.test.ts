/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CortexV2OnboardingModal } from './CortexV2OnboardingModal'
import { CORTEX_V2_ONBOARDING_SEEN_KEY } from './cortex-v2-copy'

const knowledgeV2ApiMock = vi.hoisted(() => ({
  fetchKnowledgeV2Settings: vi.fn(),
  updateKnowledgeV2Settings: vi.fn(),
}))

vi.mock('./knowledge-v2-api', () => ({
  fetchKnowledgeV2Settings: (...args: unknown[]) => knowledgeV2ApiMock.fetchKnowledgeV2Settings(...args),
  updateKnowledgeV2Settings: (...args: unknown[]) => knowledgeV2ApiMock.updateKnowledgeV2Settings(...args),
}))

function settingsView(enabled: boolean) {
  return {
    settings: {
      enabled,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    defaults: {
      enabled: false,
      legacyCleanupConfirmed: false,
      indexCaps: { global: 200, profile: 100 },
      updatedAt: null,
    },
    constraints: { indexCaps: { min: 0, max: 1000, defaults: { global: 200, profile: 100 } } },
  }
}

let container: HTMLDivElement
let root: Root | null = null

function installMockLocalStorage(): void {
  const store = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => store.set(key, value)),
      removeItem: vi.fn((key: string) => store.delete(key)),
      clear: vi.fn(() => store.clear()),
    },
  })
}

beforeEach(() => {
  installMockLocalStorage()
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({
    available: true,
    response: settingsView(false),
  })
  knowledgeV2ApiMock.updateKnowledgeV2Settings.mockResolvedValue({ ok: true, ...settingsView(true) })
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
  vi.clearAllMocks()
})

async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
  flushSync(() => {})
}

function render(): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(CortexV2OnboardingModal, { source: 'ws://127.0.0.1:8787' }))
  })
}

function dialogText(): string {
  return document.body.textContent ?? ''
}

describe('CortexV2OnboardingModal', () => {
  it('shows when undecided and knowledge-v2 is available but disabled', async () => {
    render()
    await flush()

    expect(dialogText()).toContain('Try the new Cortex')
  })

  it('does not show when the seen marker is already set', async () => {
    localStorage.setItem(CORTEX_V2_ONBOARDING_SEEN_KEY, 'true')
    render()
    await flush()

    expect(dialogText()).not.toContain('Try the new Cortex')
    // Never even queries the backend once the marker is set.
    expect(knowledgeV2ApiMock.fetchKnowledgeV2Settings).not.toHaveBeenCalled()
  })

  it('does not show and marks seen when knowledge-v2 is already enabled', async () => {
    knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({
      available: true,
      response: settingsView(true),
    })
    render()
    await flush()

    expect(dialogText()).not.toContain('Try the new Cortex')
    expect(localStorage.getItem(CORTEX_V2_ONBOARDING_SEEN_KEY)).toBe('true')
  })

  it('does not show and marks seen when knowledge-v2 is unavailable (non-Builder)', async () => {
    knowledgeV2ApiMock.fetchKnowledgeV2Settings.mockResolvedValue({ available: false })
    render()
    await flush()

    expect(dialogText()).not.toContain('Try the new Cortex')
    expect(localStorage.getItem(CORTEX_V2_ONBOARDING_SEEN_KEY)).toBe('true')
  })

  it('enables via PUT and marks seen when "Enable new Cortex" is clicked', async () => {
    render()
    await flush()

    const enableBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Enable new Cortex',
    )
    expect(enableBtn).toBeTruthy()

    flushSync(() => {
      fireEvent.click(enableBtn!)
    })
    await flush()

    expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).toHaveBeenCalledWith(
      'ws://127.0.0.1:8787',
      { enabled: true },
    )
    expect(localStorage.getItem(CORTEX_V2_ONBOARDING_SEEN_KEY)).toBe('true')
    expect(dialogText()).not.toContain('Try the new Cortex')
  })

  it('marks seen without enabling when "Not now" is clicked', async () => {
    render()
    await flush()

    const dismissBtn = Array.from(document.body.querySelectorAll('button')).find(
      (btn) => btn.textContent === 'Not now',
    )
    expect(dismissBtn).toBeTruthy()

    flushSync(() => {
      fireEvent.click(dismissBtn!)
    })
    await flush()

    expect(knowledgeV2ApiMock.updateKnowledgeV2Settings).not.toHaveBeenCalled()
    expect(localStorage.getItem(CORTEX_V2_ONBOARDING_SEEN_KEY)).toBe('true')
    expect(dialogText()).not.toContain('Try the new Cortex')
  })
})
