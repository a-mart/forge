/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { findAllByText, findByText, queryByText } from '@testing-library/dom'
import { CortexDashboardPanel } from './CortexDashboardPanel'

vi.mock('@/components/help/HelpTrigger', () => ({
  HelpTrigger: () => null,
}))

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  })
})

afterEach(() => {
  root?.unmount()
  root = null
  container.remove()
  vi.restoreAllMocks()
})

describe('CortexDashboardPanel', () => {
  it('renders index, entries, changelog, and consolidation data from the new Cortex endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/cortex/index')) {
        return response({
          indexes: [{ scope: 'global', content: '- [preference-use-pnpm] Use pnpm', tokenCap: 1500, tokenEstimate: 12, indexedEntryIds: ['preference-use-pnpm'] }],
          settings: { enabled: true, legacyCleanupConfirmed: false, indexCaps: { global: 1500, profile: 800 }, updatedAt: null },
        })
      }
      if (url.endsWith('/api/cortex/entries')) {
        return response({
          entries: [{
            id: 'preference-use-pnpm',
            version: 1,
            type: 'preference',
            scope: 'global',
            status: 'active',
            first_seen: '2026-07-05T12:00:00.000Z',
            last_confirmed: '2026-07-05T12:00:00.000Z',
            support_count: 2,
            sources: [{ kind: 'observed', session: 's1', at: '2026-07-05T12:00:00.000Z' }],
            evidence_tier: 'explicit_user',
            supersedes: [],
            source_entry_ids: [],
            importance: 'normal',
            decay_after_days: 365,
            title: 'Use pnpm',
            body: 'Use pnpm for installs.',
            tokenEstimate: 9,
          }],
        })
      }
      if (url.endsWith('/api/cortex/changelog')) {
        return response({ changelog: [{ runId: 'run-1', action: 'merged', entryId: 'preference-use-pnpm', why: 'duplicate', recordedAt: '2026-07-05T12:00:00.000Z' }] })
      }
      if (url.endsWith('/api/cortex/consolidation') && init?.method === 'POST') {
        return response({ run: { runId: 'run-2' } }, 202)
      }
      if (url.endsWith('/api/cortex/consolidation')) {
        return response({ consolidation: { lastRun: null, nextTrigger: { thresholdNewOrUpdatedEntries: 15, dailyCadenceHours: 24 }, promotionQueue: [] }, runs: [] })
      }
      return response({}, 404)
    }))

    const renderPanel = (requestedTab: { tab: 'index' | 'entries' | 'changelog' | 'consolidation'; nonce: number } | null = null) => {
      root?.render(createElement(CortexDashboardPanel, {
        wsUrl: 'ws://127.0.0.1:47187',
        managerId: 'manager-1',
        isOpen: true,
        onClose: vi.fn(),
        onArtifactClick: vi.fn(),
        onOpenSession: vi.fn(),
        requestedTab,
      }))
    }

    root = createRoot(container)
    flushSync(() => {
      renderPanel()
    })

    await findByText(container, /12 \/ 1500 tok/i)
    flushSync(() => {
      renderPanel({ tab: 'entries', nonce: 1 })
    })
    expect(await findAllByText(container, 'Use pnpm')).toHaveLength(2)
    flushSync(() => {
      renderPanel({ tab: 'changelog', nonce: 2 })
    })
    await findByText(container, 'duplicate')
    flushSync(() => {
      renderPanel({ tab: 'consolidation', nonce: 3 })
    })
    await findByText(container, 'Promotion review queue')
    expect(queryByText(container, 'Review')).toBeNull()
  })
})

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
