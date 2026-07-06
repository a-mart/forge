/** @vitest-environment jsdom */

import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationCategory, CollaborationChannel, ManagerProfile } from '@forge/protocol'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  CollabScopeSelectItems,
  useCollabScopeData,
  type CollabScopeData,
} from './collab-scope'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const specialistsApiMock = vi.hoisted(() => ({
  fetchCollabCategories: vi.fn(),
  fetchCollabChannels: vi.fn(),
}))

vi.mock('./specialists-api', () => ({
  fetchCollabCategories: (...args: unknown[]) => specialistsApiMock.fetchCollabCategories(...args),
  fetchCollabChannels: (...args: unknown[]) => specialistsApiMock.fetchCollabChannels(...args),
}))

function category(id: string, name: string): CollaborationCategory {
  return { categoryId: id, name } as CollaborationCategory
}

function channel(id: string, name: string, archived = false): CollaborationChannel {
  return { channelId: id, name, archived } as CollaborationChannel
}

function profile(id: string, displayName?: string): ManagerProfile {
  return {
    profileId: id,
    displayName: displayName ?? id,
    defaultSessionAgentId: id,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  // jsdom lacks these; Radix Select calls them when opened.
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.scrollIntoView ??= vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  specialistsApiMock.fetchCollabCategories.mockReset()
  specialistsApiMock.fetchCollabChannels.mockReset()
})

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount())
  }
  root = null
  container.remove()
})

/* ------------------------------------------------------------------ */
/*  useCollabScopeData                                                */
/* ------------------------------------------------------------------ */

describe('useCollabScopeData', () => {
  function DataHarness(props: {
    isCollab: boolean
    onData: (data: CollabScopeData) => void
  }) {
    const data = useCollabScopeData('ws://127.0.0.1:47187', props.isCollab, 0)
    props.onData(data)
    return null
  }

  it('does not fetch categories/channels when the target is not collab', async () => {
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([])

    let latest: CollabScopeData | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(DataHarness, { isCollab: false, onData: (d) => { latest = d } }))
    })

    expect(specialistsApiMock.fetchCollabCategories).not.toHaveBeenCalled()
    expect(specialistsApiMock.fetchCollabChannels).not.toHaveBeenCalled()
    expect(latest!.collabCategories).toEqual([])
    expect(latest!.collabChannels).toEqual([])
  })

  it('loads categories/channels and filters archived channels when collab', async () => {
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([category('c1', 'Design')])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([
      channel('ch1', 'general'),
      channel('ch2', 'old', true),
    ])

    let latest: CollabScopeData | null = null
    await act(async () => {
      root = createRoot(container)
      root.render(createElement(DataHarness, { isCollab: true, onData: (d) => { latest = d } }))
    })
    // Allow the resolved promises' state updates to flush.
    await act(async () => { await Promise.resolve() })

    expect(specialistsApiMock.fetchCollabCategories).toHaveBeenCalledWith('ws://127.0.0.1:47187')
    expect(specialistsApiMock.fetchCollabChannels).toHaveBeenCalledWith('ws://127.0.0.1:47187')
    expect(latest!.collabCategories.map((c) => c.categoryId)).toEqual(['c1'])
    // Archived channel ch2 filtered out.
    expect(latest!.collabChannels.map((c) => c.channelId)).toEqual(['ch1'])
  })
})

/* ------------------------------------------------------------------ */
/*  CollabScopeSelectItems                                            */
/* ------------------------------------------------------------------ */

describe('CollabScopeSelectItems', () => {
  function renderItems(props: Parameters<typeof CollabScopeSelectItems>[0], value: string) {
    act(() => {
      root = createRoot(container)
      root.render(
        createElement(
          Select,
          { value, open: true },
          createElement(
            SelectTrigger,
            null,
            createElement(SelectValue, { placeholder: 'Select scope' }),
          ),
          createElement(SelectContent, null, createElement(CollabScopeSelectItems, props)),
        ),
      )
    })
  }

  it('renders Global + builder profiles when not collab (specialists global sentinel)', () => {
    renderItems(
      {
        isCollab: false,
        profiles: [profile('p1', 'Alpha'), profile('p2', 'Beta')],
        collabCategories: [],
        collabChannels: [],
        globalScopeValue: 'global',
      },
      'global',
    )

    const text = document.body.textContent ?? ''
    expect(text).toContain('Global')
    expect(text).toContain('Alpha')
    expect(text).toContain('Beta')
    // Profiles are rendered as options (radix renders open content into the DOM).
    expect(document.querySelector('[data-radix-select-viewport], [role="listbox"]')).not.toBeNull()
  })

  it('renders Global Collaboration + categories + channels when collab (skills global sentinel)', () => {
    renderItems(
      {
        isCollab: true,
        profiles: [profile('p1', 'Alpha')],
        collabCategories: [category('c1', 'Design')],
        collabChannels: [channel('ch1', 'general')],
        globalScopeValue: '__global__',
      },
      '__global__',
    )

    const text = document.body.textContent ?? ''
    expect(text).toContain('Global Collaboration')
    expect(text).toContain('Categories')
    expect(text).toContain('Category: Design')
    expect(text).toContain('Channels')
    expect(text).toContain('#general')
    // Builder profiles are NOT shown in collab mode.
    expect(text).not.toContain('Alpha')
  })
})
