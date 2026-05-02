/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationCategory, SkillInventoryEntry } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const apiMock = vi.hoisted(() => ({
  fetchCollabSkillInventory: vi.fn(),
  updateCategoryDefaultSkillSelection: vi.fn(),
}))

vi.mock('../specialists-api', () => ({
  fetchCollabSkillInventory: (...args: unknown[]) => apiMock.fetchCollabSkillInventory(...args),
  updateCategoryDefaultSkillSelection: (...args: unknown[]) =>
    apiMock.updateCategoryDefaultSkillSelection(...args),
}))

const { CategorySkillDefaultsView } = await import('./CategorySkillDefaultsView')

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

const CATEGORY: CollaborationCategory = {
  categoryId: 'cat-1',
  workspaceId: 'ws-1',
  name: 'Engineering',
  defaultSelectedSpecialistHandles: [],
  position: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  apiMock.fetchCollabSkillInventory.mockResolvedValue([makeMemorySkill(), makeSkill()])
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

function render(category: CollaborationCategory = CATEGORY): void {
  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(CategorySkillDefaultsView, {
        clientOrWsUrl: 'ws://127.0.0.1:47187',
        category,
        changeKey: 0,
        onCategoryUpdated: vi.fn(),
      }),
    )
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('CategorySkillDefaultsView', () => {
  it('renders the section header', async () => {
    render()
    await flush()
    await flush()

    expect(container.textContent).toContain('Default Skill Selection')
    expect(container.textContent).toContain('newly created channels')
  })

  it('defaults to all mode when category has no skill selection', async () => {
    render()
    await flush()
    await flush()

    const allRadio = container.querySelector('input[value="all"]') as HTMLInputElement
    expect(allRadio?.checked).toBe(true)
    expect(container.textContent).toContain('available skill')
  })

  it('renders custom mode with checkboxes when category has custom selection', async () => {
    const categoryWithCustom: CollaborationCategory = {
      ...CATEGORY,
      defaultSkillSelection: {
        mode: 'custom',
        savedSelectedSkillHandles: ['brave-search'],
        resolvedSkillHandles: ['brave-search'],
        alwaysOnSkillHandles: ['memory'],
      },
    }
    render(categoryWithCustom)
    await flush()
    await flush()

    expect(container.textContent).toContain('Always on')
    expect(container.textContent).toContain('Optional skills')
    expect(container.textContent).toContain('Brave Search')
  })

  it('does not show Save when nothing changed', async () => {
    render()
    await flush()
    await flush()

    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save'),
    )
    expect(saveBtn).toBeUndefined()
  })

  it('shows Save when mode switches', async () => {
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

  it('shows missing handles warning', async () => {
    const categoryWithMissing: CollaborationCategory = {
      ...CATEGORY,
      defaultSkillSelection: {
        mode: 'custom',
        savedSelectedSkillHandles: ['removed-skill'],
        resolvedSkillHandles: [],
        alwaysOnSkillHandles: ['memory'],
        missingSkillHandles: ['removed-skill'],
      },
    }
    render(categoryWithMissing)
    await flush()
    await flush()

    expect(container.textContent).toContain('Missing skill handles')
    expect(container.textContent).toContain('removed-skill')
  })

  it('calls updateCategoryDefaultSkillSelection on save', async () => {
    const onUpdated = vi.fn()
    const updatedCategory = { ...CATEGORY, defaultSkillSelection: { mode: 'custom' as const, savedSelectedSkillHandles: [], resolvedSkillHandles: [], alwaysOnSkillHandles: ['memory'] } }
    apiMock.updateCategoryDefaultSkillSelection.mockResolvedValue(updatedCategory)

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(CategorySkillDefaultsView, {
          clientOrWsUrl: 'ws://127.0.0.1:47187',
          category: CATEGORY,
          changeKey: 0,
          onCategoryUpdated: onUpdated,
        }),
      )
    })
    await flush()
    await flush()

    // Switch to custom
    const customRadio = container.querySelector('input[value="custom"]') as HTMLInputElement
    flushSync(() => {
      customRadio.click()
    })
    await flush()

    // Save
    const saveBtn = Array.from(container.querySelectorAll('button')).find(
      (btn) => btn.textContent?.includes('Save'),
    )!
    flushSync(() => {
      saveBtn.click()
    })
    await flush()
    await flush()

    expect(apiMock.updateCategoryDefaultSkillSelection).toHaveBeenCalledWith(
      'ws://127.0.0.1:47187',
      'cat-1',
      { mode: 'custom', savedSelectedSkillHandles: [] },
    )
    expect(onUpdated).toHaveBeenCalledWith(updatedCategory)
  })

  it('shows error when inventory fetch fails', async () => {
    apiMock.fetchCollabSkillInventory.mockRejectedValue(new Error('Connection failed'))
    render()
    await flush()
    await flush()

    expect(container.textContent).toContain('Connection failed')
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

      const categoryCustom: CollaborationCategory = {
        ...CATEGORY,
        defaultSkillSelection: {
          mode: 'custom',
          savedSelectedSkillHandles: ['brave-search'], // lowercase from backend
          resolvedSkillHandles: ['brave-search'],
          alwaysOnSkillHandles: ['memory'], // lowercase from backend
        },
      }
      render(categoryCustom)
      await flush()
      await flush()

      // Brave-Search (mixed-case dir) should appear checked
      const checkboxes = container.querySelectorAll('[role="checkbox"]')
      expect(checkboxes.length).toBe(1) // only optional skills get a checkbox
      expect(checkboxes[0]?.getAttribute('data-state')).toBe('checked')
    })

    it('detects always-on skills with mixed-case directoryName', async () => {
      apiMock.fetchCollabSkillInventory.mockResolvedValue(mixedCaseInventory)

      const categoryCustom: CollaborationCategory = {
        ...CATEGORY,
        defaultSkillSelection: {
          mode: 'custom',
          savedSelectedSkillHandles: [],
          resolvedSkillHandles: [],
          alwaysOnSkillHandles: ['memory'], // lowercase
        },
      }
      render(categoryCustom)
      await flush()
      await flush()

      // Memory should be in the always-on section, not in optional
      expect(container.textContent).toContain('Always on')
      // Only one optional skill (Brave-Search), not two
      const checkboxes = container.querySelectorAll('[role="checkbox"]')
      expect(checkboxes.length).toBe(1)
    })

    it('sends normalized lowercase handles in save payload', async () => {
      apiMock.fetchCollabSkillInventory.mockResolvedValue(mixedCaseInventory)
      const updatedCategory = {
        ...CATEGORY,
        defaultSkillSelection: {
          mode: 'custom' as const,
          savedSelectedSkillHandles: ['brave-search'],
          resolvedSkillHandles: ['brave-search'],
          alwaysOnSkillHandles: ['memory'],
        },
      }
      apiMock.updateCategoryDefaultSkillSelection.mockResolvedValue(updatedCategory)

      const onUpdated = vi.fn()
      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(CategorySkillDefaultsView, {
            clientOrWsUrl: 'ws://127.0.0.1:47187',
            category: CATEGORY,
            changeKey: 0,
            onCategoryUpdated: onUpdated,
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

      // Payload should contain lowercase handle, not mixed-case
      const call = apiMock.updateCategoryDefaultSkillSelection.mock.calls[0]
      expect(call[2]).toEqual({
        mode: 'custom',
        savedSelectedSkillHandles: ['brave-search'],
      })
    })
  })
})
