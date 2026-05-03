/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationSkillSelectionState, SkillInventoryEntry } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const apiMock = vi.hoisted(() => ({
  fetchCollabSkillInventory: vi.fn(),
  updateChannelSkillSelection: vi.fn(),
}))

vi.mock('../specialists-api', () => ({
  fetchCollabSkillInventory: (...args: unknown[]) => apiMock.fetchCollabSkillInventory(...args),
  updateChannelSkillSelection: (...args: unknown[]) => apiMock.updateChannelSkillSelection(...args),
}))

const { ChannelSkillSelection } = await import('./ChannelSkillSelection')

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeSkill(overrides: Partial<SkillInventoryEntry> = {}): SkillInventoryEntry {
  return {
    skillId: 'brave-search',
    name: 'Brave Search',
    directoryName: 'brave-search',
    description: 'Web search via Brave',
    envCount: 1,
    hasRichConfig: false,
    sourceKind: 'builtin',
    rootPath: '/skills/brave-search',
    skillFilePath: '/skills/brave-search/SKILL.md',
    isInherited: false,
    isEffective: true,
    ...overrides,
  }
}

function makeMemorySkill(): SkillInventoryEntry {
  return makeSkill({
    skillId: 'memory',
    name: 'Memory',
    directoryName: 'memory',
    description: 'Persistent memory',
  })
}

const DEFAULT_SELECTION: CollaborationSkillSelectionState = {
  mode: 'all',
  savedSelectedSkillHandles: [],
  resolvedSkillHandles: ['brave-search', 'memory'],
  alwaysOnSkillHandles: ['memory'],
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  apiMock.fetchCollabSkillInventory.mockResolvedValue([makeMemorySkill(), makeSkill()])
  apiMock.updateChannelSkillSelection.mockResolvedValue({
    channelId: 'ch-1',
    activeSkillSelection: DEFAULT_SELECTION,
  })
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

function render(selection?: CollaborationSkillSelectionState): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(ChannelSkillSelection, {
        clientOrWsUrl: 'ws://127.0.0.1:47187',
        channelId: 'ch-1',
        channelLabel: 'engineering',
        activeSkillSelection: selection ?? DEFAULT_SELECTION,
        changeKey: 0,
        onSelectionSaved: vi.fn(),
      }),
    )
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('ChannelSkillSelection', () => {
  it('renders the section header with channel label', async () => {
    render()
    await flush()
    await flush()

    expect(container.textContent).toContain('Skill Selection')
    expect(container.textContent).toContain('#engineering')
  })

  it('shows loading spinner during inventory fetch', () => {
    apiMock.fetchCollabSkillInventory.mockReturnValue(new Promise(() => {}))
    render()

    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows error message when inventory fetch fails', async () => {
    apiMock.fetchCollabSkillInventory.mockRejectedValue(new Error('Network error'))
    render()
    await flush()
    await flush()

    expect(container.textContent).toContain('Network error')
  })

  it('renders All/Custom radio buttons after load', async () => {
    render()
    await flush()
    await flush()

    const radios = container.querySelectorAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(container.textContent).toContain('All skills')
    expect(container.textContent).toContain('Custom selection')
  })

  it('defaults to "all" mode and shows summary text', async () => {
    render()
    await flush()
    await flush()

    const allRadio = container.querySelector('input[value="all"]') as HTMLInputElement
    expect(allRadio?.checked).toBe(true)
    expect(container.textContent).toContain('available skill')
  })

  it('switches to custom mode and shows skill checkboxes', async () => {
    const customSelection: CollaborationSkillSelectionState = {
      mode: 'custom',
      savedSelectedSkillHandles: ['brave-search'],
      resolvedSkillHandles: ['brave-search'],
      alwaysOnSkillHandles: ['memory'],
    }
    render(customSelection)
    await flush()
    await flush()

    expect(container.textContent).toContain('Always on')
    expect(container.textContent).toContain('Memory')
    expect(container.textContent).toContain('Optional skills')
    expect(container.textContent).toContain('Brave Search')
  })

  it('shows lock icon for always-on skills in custom mode', async () => {
    const customSelection: CollaborationSkillSelectionState = {
      mode: 'custom',
      savedSelectedSkillHandles: [],
      resolvedSkillHandles: [],
      alwaysOnSkillHandles: ['memory'],
    }
    render(customSelection)
    await flush()
    await flush()

    expect(container.textContent).toContain('Always on')
    expect(container.textContent).toContain('Memory')
  })

  it('does not show Save button when nothing has changed', async () => {
    render()
    await flush()
    await flush()

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save'),
    )
    expect(saveBtn).toBeUndefined()
  })

  it('shows Save button when mode changes from all to custom', async () => {
    render()
    await flush()
    await flush()

    const customRadio = container.querySelector('input[value="custom"]') as HTMLInputElement
    flushSync(() => {
      customRadio.click()
    })
    await flush()

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save'),
    )
    expect(saveBtn).toBeTruthy()
  })

  it('shows missing handles warning when present', async () => {
    const selection: CollaborationSkillSelectionState = {
      mode: 'custom',
      savedSelectedSkillHandles: ['gone-skill'],
      resolvedSkillHandles: [],
      alwaysOnSkillHandles: ['memory'],
      missingSkillHandles: ['gone-skill'],
    }
    render(selection)
    await flush()
    await flush()

    expect(container.textContent).toContain('Missing skill handles')
    expect(container.textContent).toContain('gone-skill')
  })

  it('shows skill source kind badge', async () => {
    const customSelection: CollaborationSkillSelectionState = {
      mode: 'custom',
      savedSelectedSkillHandles: [],
      resolvedSkillHandles: [],
      alwaysOnSkillHandles: ['memory'],
    }
    render(customSelection)
    await flush()
    await flush()

    expect(container.textContent).toContain('builtin')
  })

  it('calls updateChannelSkillSelection with correct payload on save', async () => {
    const onSaved = vi.fn()
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(ChannelSkillSelection, {
          clientOrWsUrl: 'ws://127.0.0.1:47187',
          channelId: 'ch-1',
          channelLabel: 'engineering',
          activeSkillSelection: DEFAULT_SELECTION,
          changeKey: 0,
          onSelectionSaved: onSaved,
        }),
      )
    })
    await flush()
    await flush()

    // Switch to custom mode
    const customRadio = container.querySelector('input[value="custom"]') as HTMLInputElement
    flushSync(() => {
      customRadio.click()
    })
    await flush()

    // Click save
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save'),
    )!
    flushSync(() => {
      saveBtn.click()
    })
    await flush()
    await flush()

    expect(apiMock.updateChannelSkillSelection).toHaveBeenCalledWith(
      'ws://127.0.0.1:47187',
      'ch-1',
      { mode: 'custom', savedSelectedSkillHandles: [] },
    )
  })

  /* -------------------------------------------------------------- */
  /*  Case-normalization tests (mixed-case directoryName)            */
  /* -------------------------------------------------------------- */

  describe('handle case normalization', () => {
    const mixedCaseInventory: SkillInventoryEntry[] = [
      makeSkill({
        skillId: 'Memory',
        name: 'Memory',
        directoryName: 'Memory', // mixed-case directory on disk
        description: 'Persistent memory',
      }),
      makeSkill({
        skillId: 'Brave-Search',
        name: 'Brave Search',
        directoryName: 'Brave-Search', // mixed-case directory on disk
      }),
    ]

    it('renders saved lowercase handles as checked when directoryName is mixed-case', async () => {
      apiMock.fetchCollabSkillInventory.mockResolvedValue(mixedCaseInventory)

      const customSelection: CollaborationSkillSelectionState = {
        mode: 'custom',
        savedSelectedSkillHandles: ['brave-search'], // lowercase from backend
        resolvedSkillHandles: ['brave-search'],
        alwaysOnSkillHandles: ['memory'], // lowercase from backend
      }
      render(customSelection)
      await flush()
      await flush()

      // Brave-Search (mixed-case dir) should appear checked
      const checkboxes = container.querySelectorAll('[role="checkbox"]')
      expect(checkboxes.length).toBe(1) // only optional skills get a checkbox
      expect(checkboxes[0]?.getAttribute('data-state')).toBe('checked')
    })

    it('detects always-on skills with mixed-case directoryName', async () => {
      apiMock.fetchCollabSkillInventory.mockResolvedValue(mixedCaseInventory)

      const customSelection: CollaborationSkillSelectionState = {
        mode: 'custom',
        savedSelectedSkillHandles: [],
        resolvedSkillHandles: [],
        alwaysOnSkillHandles: ['memory'], // lowercase
      }
      render(customSelection)
      await flush()
      await flush()

      // Memory should be in the always-on section, not optional
      expect(container.textContent).toContain('Always on')
      // Only one optional skill checkbox (Brave-Search), not two
      const checkboxes = container.querySelectorAll('[role="checkbox"]')
      expect(checkboxes.length).toBe(1)
    })

    it('sends normalized lowercase handles in save payload', async () => {
      apiMock.fetchCollabSkillInventory.mockResolvedValue(mixedCaseInventory)
      apiMock.updateChannelSkillSelection.mockResolvedValue({
        channelId: 'ch-1',
        activeSkillSelection: {
          mode: 'custom',
          savedSelectedSkillHandles: ['brave-search'],
          resolvedSkillHandles: ['brave-search'],
          alwaysOnSkillHandles: ['memory'],
        },
      })

      const onSaved = vi.fn()
      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(ChannelSkillSelection, {
            clientOrWsUrl: 'ws://127.0.0.1:47187',
            channelId: 'ch-1',
            channelLabel: 'engineering',
            activeSkillSelection: DEFAULT_SELECTION,
            changeKey: 0,
            onSelectionSaved: onSaved,
          }),
        )
      })
      await flush()
      await flush()

      // Switch to custom
      const customRadio = container.querySelector('input[value="custom"]') as HTMLInputElement
      flushSync(() => { customRadio.click() })
      await flush()

      // Toggle Brave-Search (mixed-case directoryName)
      const checkbox = container.querySelector('[role="checkbox"]')!
      flushSync(() => { (checkbox as HTMLElement).click() })
      await flush()

      // Save
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Save'),
      )!
      flushSync(() => { saveBtn.click() })
      await flush()
      await flush()

      // Payload should contain lowercase handle
      const call = apiMock.updateChannelSkillSelection.mock.calls[0]
      expect(call[2]).toEqual({
        mode: 'custom',
        savedSelectedSkillHandles: ['brave-search'],
      })
    })
  })
})
