/** @vitest-environment jsdom */

import { fireEvent, getByText, queryByRole } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptSurfaceEditor } from './PromptSurfaceEditor'
import type { CortexPromptSurfaceListEntry } from '@forge/protocol'

let container: HTMLDivElement
let root: Root | null = null
const originalFetch = globalThis.fetch

beforeEach(() => {
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
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  flushSync(() => {})
}

describe('PromptSurfaceEditor', () => {
  it('renders live Cortex file provenance and warning details', async () => {
    const surface: CortexPromptSurfaceListEntry = {
      surfaceId: 'common-knowledge-live',
      title: 'Common Knowledge',
      description: 'Live injected shared knowledge used in Cortex memory injection.',
      group: 'live',
      kind: 'file',
      editable: true,
      resetMode: 'none',
      runtimeEffect: 'liveInjected',
      warning: 'Live injected context — edits affect the current shared/knowledge/common.md used across agents.',
      filePath: '/tmp/data/shared/knowledge/common.md',
      sourcePath: '/tmp/data/shared/knowledge/common.md',
      seedPrompt: { category: 'operational', promptId: 'common-knowledge-template' },
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...surface,
        content: '# Common Knowledge\n\nInjected content\n',
        lastModifiedAt: '2026-03-16T12:00:00.000Z',
      }),
    }) as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(PromptSurfaceEditor, {
          wsUrl: 'ws://127.0.0.1:47187',
          profileId: 'cortex',
          surface,
          refreshKey: 0,
        }),
      )
    })

    await flushPromises()

    expect(getByText(container, 'Common Knowledge')).toBeTruthy()
    expect(getByText(container, 'Live Cortex file')).toBeTruthy()
    expect(getByText(container, 'Live injected context')).toBeTruthy()
    expect(getByText(container, /Seed relationship:/)).toBeTruthy()
    expect(getByText(container, 'Live injected context — edits affect the current shared/knowledge/common.md used across agents.')).toBeTruthy()
    expect((container.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toBe(
      '# Common Knowledge\n\nInjected content\n',
    )
    expect(getByText(container, '/tmp/data/shared/knowledge/common.md')).toBeTruthy()
  })

  it('preserves unsaved edits without refetching on every keystroke', async () => {
    const surface: CortexPromptSurfaceListEntry = {
      surfaceId: 'common-knowledge-live',
      title: 'Common Knowledge',
      description: 'Live injected shared knowledge used in Cortex memory injection.',
      group: 'live',
      kind: 'file',
      editable: true,
      resetMode: 'none',
      runtimeEffect: 'liveInjected',
      warning: 'Live injected context — edits affect the current shared/knowledge/common.md used across agents.',
      filePath: '/tmp/data/shared/knowledge/common.md',
      sourcePath: '/tmp/data/shared/knowledge/common.md',
      seedPrompt: { category: 'operational', promptId: 'common-knowledge-template' },
    }

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...surface,
        content: '# Common Knowledge\n\nOriginal\n',
        lastModifiedAt: '2026-03-16T12:00:00.000Z',
      }),
    })
    globalThis.fetch = fetchMock as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(PromptSurfaceEditor, {
          wsUrl: 'ws://127.0.0.1:47187',
          profileId: 'cortex',
          surface,
          refreshKey: 0,
        }),
      )
    })

    await flushPromises()

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    expect(textarea).toBeTruthy()
    fireEvent.change(textarea!, { target: { value: '# Common Knowledge\n\nEdited locally\n' } })
    await flushPromises()

    expect(textarea?.value).toBe('# Common Knowledge\n\nEdited locally\n')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('renders scratch surfaces as read-only supplemental files', async () => {
    const surface: CortexPromptSurfaceListEntry = {
      surfaceId: 'cortex-notes',
      title: 'Cortex Notes',
      description: 'Scratch notes file for tentative Cortex observations.',
      group: 'scratch',
      kind: 'file',
      editable: false,
      resetMode: 'none',
      runtimeEffect: 'scratchOnly',
      warning: 'Scratch only — referenced by Cortex for tentative notes; not injected into the manager system prompt.',
      filePath: '/tmp/data/shared/knowledge/.cortex-notes.md',
      sourcePath: '/tmp/data/shared/knowledge/.cortex-notes.md',
      seedPrompt: null,
    }

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...surface,
        content: '# Cortex Notes\n\nTentative note\n',
      }),
    }) as typeof fetch

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(PromptSurfaceEditor, {
          wsUrl: 'ws://127.0.0.1:47187',
          profileId: 'cortex',
          surface,
          refreshKey: 0,
        }),
      )
    })

    await flushPromises()

    expect(getByText(container, 'Scratch / supplemental')).toBeTruthy()
    expect(getByText(container, 'Scratch / not injected')).toBeTruthy()
    expect((container.querySelector('textarea') as HTMLTextAreaElement | null)?.value).toBe(
      '# Cortex Notes\n\nTentative note\n',
    )
    expect(queryByRole(container, 'button', { name: 'Reseed from Template' })).toBeNull()
    expect(queryByRole(container, 'button', { name: 'Save' })).toBeNull()
  })
})
