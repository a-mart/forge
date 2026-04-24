/** @vitest-environment jsdom */

import { fireEvent, getByRole, getByTestId, waitFor } from '@testing-library/dom'
import { createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitLogEntry } from '@forge/protocol'
import { CortexRestoreVersionDialog } from './CortexRestoreVersionDialog'

vi.mock('@/components/diff-viewer/DiffPane', () => ({
  DiffPane: ({ oldContent, newContent, fileName }: { oldContent: string | null; newContent: string | null; fileName: string | null }) =>
    createElement('div', {
      'data-testid': 'mock-restore-diff-pane',
      'data-old': oldContent ?? '',
      'data-new': newContent ?? '',
      'data-file-name': fileName ?? '',
    }),
}))

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch
const fetchSpyState = { writeBodies: [] as Array<{ path: string; content: string; versioningSource?: string }> }

const SELECTED_COMMIT: GitLogEntry = {
  sha: 'abcdef1234567890',
  shortSha: 'abcdef12',
  message: 'Knowledge update',
  author: 'Cortex',
  date: '2026-03-29T12:00:00.000Z',
  filesChanged: 1,
  metadata: {
    source: 'profile-memory-merge',
    reviewRunId: 'review-1',
    paths: ['shared/knowledge/common.md'],
  },
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  fetchSpyState.writeBodies = []
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (url.includes('/api/git/commit-diff') && method === 'GET') {
      return {
        ok: true,
        json: async () => ({ oldContent: '# Before\nBody\n', newContent: '# Restored\nSelected version\n' }),
      } as Response
    }

    if (url.endsWith('/api/read-file') && method === 'POST') {
      return {
        ok: true,
        json: async () => ({ path: '/data/shared/knowledge/common.md', content: '# Current\nLive version\n' }),
      } as Response
    }

    if (url.endsWith('/api/write-file') && method === 'POST') {
      fetchSpyState.writeBodies.push(JSON.parse(String(init?.body ?? '{}')) as { path: string; content: string; versioningSource?: string })
      return { ok: true, json: async () => ({ success: true }) } as Response
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`)
  }) as typeof fetch
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  document.body.innerHTML = ''
  container.remove()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

function renderDialog(overrides?: Partial<ComponentProps<typeof CortexRestoreVersionDialog>>) {
  if (!root) {
    root = createRoot(container)
  }

  const props: ComponentProps<typeof CortexRestoreVersionDialog> = {
    open: true,
    wsUrl: 'ws://127.0.0.1:47187',
    agentId: 'cortex',
    absolutePath: '/data/shared/knowledge/common.md',
    gitPath: 'shared/knowledge/common.md',
    documentLabel: 'Common Knowledge',
    selectedCommit: SELECTED_COMMIT,
    onOpenChange: vi.fn(),
    onRestoreSuccess: vi.fn(),
    ...overrides,
  }

  flushSync(() => {
    root?.render(createElement(CortexRestoreVersionDialog, props))
  })

  return props
}

describe('CortexRestoreVersionDialog', () => {
  it('shows a current-vs-selected diff preview', async () => {
    renderDialog()
    await flushPromises()

    const diffPane = getByTestId(document.body, 'mock-restore-diff-pane')
    expect(diffPane.getAttribute('data-old')).toBe('# Current\nLive version\n')
    expect(diffPane.getAttribute('data-new')).toBe('# Restored\nSelected version\n')
  })

  it('does not write until restore is confirmed', async () => {
    renderDialog()
    await flushPromises()

    expect(fetchSpyState.writeBodies).toEqual([])
    expect(getByRole(document.body, 'button', { name: /restore this version/i })).toBeTruthy()
  })

  it('writes the selected content after explicit confirmation', async () => {
    const props = renderDialog()

    // Wait for the preview to fully load before clicking — the confirm handler
    // early-returns when preview is null, so clicking before load is a silent no-op.
    await waitFor(() => {
      const diffPane = getByTestId(document.body, 'mock-restore-diff-pane')
      expect(diffPane.getAttribute('data-new')).toBe('# Restored\nSelected version\n')
    })

    fireEvent.click(getByTestId(document.body, 'cortex-confirm-restore'))

    await waitFor(() => {
      expect(fetchSpyState.writeBodies).toHaveLength(1)
      expect(props.onRestoreSuccess).toHaveBeenCalledTimes(1)
      expect(props.onOpenChange).toHaveBeenCalledWith(false)
    })

    expect(fetchSpyState.writeBodies[0]).toEqual({
      path: '/data/shared/knowledge/common.md',
      content: '# Restored\nSelected version\n',
      versioningSource: 'api-write-file-restore',
    })
  })
})
