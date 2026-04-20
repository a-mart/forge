/** @vitest-environment jsdom */

import { fireEvent, findByRole, findByText, getByRole, getByTestId, waitFor } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CortexDocumentEntry } from '@forge/protocol'
import { CortexDashboardPanel } from './CortexDashboardPanel'

vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: () => null,
}))

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

const DOCUMENTS: CortexDocumentEntry[] = [
  {
    id: 'shared/knowledge/common.md',
    label: 'Common Knowledge',
    description: 'Shared knowledge base across all profiles',
    group: 'commonKnowledge',
    surface: 'knowledge',
    absolutePath: '/data/shared/knowledge/common.md',
    gitPath: 'shared/knowledge/common.md',
    profileId: 'cortex',
    exists: true,
    sizeBytes: 128,
    editable: true,
  },
  {
    id: 'profiles/alpha/memory.md',
    label: 'Profile Memory: alpha',
    description: 'Injected profile summary memory for alpha',
    group: 'profileMemory',
    surface: 'memory',
    absolutePath: '/data/profiles/alpha/memory.md',
    gitPath: 'profiles/alpha/memory.md',
    profileId: 'alpha',
    exists: true,
    sizeBytes: 256,
    editable: true,
  },
  {
    id: 'profiles/alpha/reference/overview.md',
    label: 'alpha / overview.md',
    description: 'Reference doc for alpha',
    group: 'referenceDocs',
    surface: 'reference',
    absolutePath: '/data/profiles/alpha/reference/overview.md',
    gitPath: 'profiles/alpha/reference/overview.md',
    profileId: 'alpha',
    exists: true,
    sizeBytes: 64,
    editable: true,
  },
  {
    id: 'profiles/alpha/prompts/archetypes/review.md',
    label: 'alpha / archetype / review',
    description: 'Prompt override for alpha',
    group: 'promptOverrides',
    surface: 'prompt',
    absolutePath: '/data/profiles/alpha/prompts/archetypes/review.md',
    gitPath: 'profiles/alpha/prompts/archetypes/review.md',
    profileId: 'alpha',
    exists: true,
    sizeBytes: 32,
    editable: true,
  },
  {
    id: 'shared/knowledge/.cortex-notes.md',
    label: 'Cortex Notes',
    description: 'Working notes and tentative observations',
    group: 'notes',
    surface: 'knowledge',
    absolutePath: '/data/shared/knowledge/.cortex-notes.md',
    gitPath: 'shared/knowledge/.cortex-notes.md',
    profileId: 'cortex',
    exists: true,
    sizeBytes: 48,
    editable: true,
  },
]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  window.localStorage?.removeItem?.('cortex-panel-width')
  Element.prototype.scrollIntoView ??= vi.fn()
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

function getViewerTitle(): string | null {
  return (
    container.querySelector('[data-slot="tabs-content"][data-state="active"] [data-testid="cortex-document-viewer-shell"] h3')
      ?.textContent ?? null
  )
}

function installFetchMock() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.endsWith('/api/cortex/scan') && method === 'GET') {
      return {
        ok: true,
        json: async () => ({ documents: DOCUMENTS }),
      } as Response
    }

    if (url.endsWith('/api/read-file') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
      const path = body.path ?? ''
      const document = DOCUMENTS.find((entry) => entry.absolutePath === path)
      return {
        ok: true,
        json: async () => ({ path, content: `# ${document?.label ?? path}\n` }),
      } as Response
    }

    if (url.endsWith('/api/write-file') && method === 'POST') {
      return { ok: true, json: async () => ({ ok: true }) } as Response
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }) as typeof fetch
}

describe('CortexDashboardPanel', () => {
  it('renders grouped selector sections and switches between reference docs and prompt overrides', async () => {
    installFetchMock()

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(CortexDashboardPanel, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          isOpen: true,
          onClose: vi.fn(),
          onArtifactClick: vi.fn(),
          onOpenSession: vi.fn(),
        }),
      )
    })

    await waitFor(() => {
      expect(getViewerTitle()).toBe('Common Knowledge')
    })

    const selector = getByRole(container, 'combobox', { name: 'Cortex document selector' })
    fireEvent.keyDown(selector, { key: 'ArrowDown' })

    await findByText(document.body, 'Profile Memory')
    await findByText(document.body, 'Reference Docs')
    await findByText(document.body, 'Prompt Overrides')

    const overviewOption = await findByRole(document.body, 'option', { name: /alpha \/ overview\.md/i })
    fireEvent.click(overviewOption)

    await waitFor(() => {
      expect(getViewerTitle()).toBe('alpha / overview.md')
    })

    fireEvent.keyDown(selector, { key: 'ArrowDown' })
    const promptOverrideOption = await findByRole(document.body, 'option', {
      name: /alpha \/ archetype \/ review/i,
    })
    fireEvent.click(promptOverrideOption)

    await waitFor(() => {
      expect(getViewerTitle()).toBe('alpha / archetype / review')
    })
  })

  it('uses the shared viewer shell for the Notes tab', async () => {
    installFetchMock()

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(CortexDashboardPanel, {
          wsUrl: 'ws://127.0.0.1:47187',
          managerId: 'manager-1',
          isOpen: true,
          onClose: vi.fn(),
          onArtifactClick: vi.fn(),
          onOpenSession: vi.fn(),
          requestedTab: { tab: 'notes', nonce: 1 },
        }),
      )
    })

    await findByText(container, 'Cortex Notes')

    const shell = getByTestId(container, 'cortex-document-viewer-shell')
    expect(shell).toBeTruthy()
    expect(shell.getAttribute('data-surface')).toBe('knowledge')
    expect(getViewerTitle()).toBe('Cortex Notes')
  })
})
