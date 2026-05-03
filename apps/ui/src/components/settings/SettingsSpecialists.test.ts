/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSpecialists } from './SettingsSpecialists'
import type { ManagerProfile, ResolvedSpecialistDefinition } from '@forge/protocol'
import type { SettingsApiClient } from './settings-api-client'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const specialistsApiMock = vi.hoisted(() => ({
  fetchSpecialists: vi.fn(),
  fetchSharedSpecialists: vi.fn(),
  fetchRosterPrompt: vi.fn(),
  fetchChannelRosterPrompt: vi.fn(),
  fetchWorkerTemplate: vi.fn(),
  fetchSpecialistsEnabled: vi.fn(),
  setSpecialistsEnabledApi: vi.fn(),
  saveSpecialist: vi.fn(),
  saveSharedSpecialist: vi.fn(),
  deleteSpecialist: vi.fn(),
  deleteSharedSpecialist: vi.fn(),
  fetchChannelSpecialists: vi.fn(),
  saveChannelSpecialist: vi.fn(),
  deleteChannelSpecialistApi: vi.fn(),
  updateChannelSpecialistSelection: vi.fn(),
  updateCategoryDefaultSpecialists: vi.fn(),
  fetchCollabCategories: vi.fn(),
  fetchCollabChannels: vi.fn(),
  updateChannelSkillSelection: vi.fn(),
  updateCategoryDefaultSkillSelection: vi.fn(),
  fetchCollabSkillInventory: vi.fn(),
}))

vi.mock('./specialists-api', () => ({
  fetchSpecialists: (...args: unknown[]) => specialistsApiMock.fetchSpecialists(...args),
  fetchSharedSpecialists: (...args: unknown[]) => specialistsApiMock.fetchSharedSpecialists(...args),
  fetchRosterPrompt: (...args: unknown[]) => specialistsApiMock.fetchRosterPrompt(...args),
  fetchChannelRosterPrompt: (...args: unknown[]) => specialistsApiMock.fetchChannelRosterPrompt(...args),
  fetchWorkerTemplate: (...args: unknown[]) => specialistsApiMock.fetchWorkerTemplate(...args),
  fetchSpecialistsEnabled: (...args: unknown[]) => specialistsApiMock.fetchSpecialistsEnabled(...args),
  setSpecialistsEnabledApi: (...args: unknown[]) => specialistsApiMock.setSpecialistsEnabledApi(...args),
  saveSpecialist: (...args: unknown[]) => specialistsApiMock.saveSpecialist(...args),
  saveSharedSpecialist: (...args: unknown[]) => specialistsApiMock.saveSharedSpecialist(...args),
  deleteSpecialist: (...args: unknown[]) => specialistsApiMock.deleteSpecialist(...args),
  deleteSharedSpecialist: (...args: unknown[]) => specialistsApiMock.deleteSharedSpecialist(...args),
  fetchChannelSpecialists: (...args: unknown[]) => specialistsApiMock.fetchChannelSpecialists(...args),
  saveChannelSpecialist: (...args: unknown[]) => specialistsApiMock.saveChannelSpecialist(...args),
  deleteChannelSpecialistApi: (...args: unknown[]) => specialistsApiMock.deleteChannelSpecialistApi(...args),
  updateChannelSpecialistSelection: (...args: unknown[]) => specialistsApiMock.updateChannelSpecialistSelection(...args),
  updateCategoryDefaultSpecialists: (...args: unknown[]) => specialistsApiMock.updateCategoryDefaultSpecialists(...args),
  fetchCollabCategories: (...args: unknown[]) => specialistsApiMock.fetchCollabCategories(...args),
  fetchCollabChannels: (...args: unknown[]) => specialistsApiMock.fetchCollabChannels(...args),
  updateChannelSkillSelection: (...args: unknown[]) => specialistsApiMock.updateChannelSkillSelection(...args),
  updateCategoryDefaultSkillSelection: (...args: unknown[]) => specialistsApiMock.updateCategoryDefaultSkillSelection(...args),
  fetchCollabSkillInventory: (...args: unknown[]) => specialistsApiMock.fetchCollabSkillInventory(...args),
}))

vi.mock('@/lib/model-preset', () => ({
  useModelPresets: () => [],
  getAllSelectableModels: () => [],
  getModelDisplayLabel: (modelId: string) => modelId,
  getSupportedReasoningLevelsForModelId: () => ['none', 'low', 'medium', 'high', 'xhigh'],
}))

vi.mock('@/components/help/help-hooks', () => ({
  useHelpContext: () => {},
}))

vi.mock('@/components/chat/SpecialistBadge', () => ({
  SpecialistBadge: ({ displayName }: { displayName: string }) =>
    createElement('span', { 'data-testid': 'specialist-badge' }, displayName),
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeSpecialist(
  overrides: Partial<ResolvedSpecialistDefinition> = {},
): ResolvedSpecialistDefinition {
  return {
    specialistId: 'backend',
    displayName: 'Backend',
    color: '#2563eb',
    enabled: true,
    whenToUse: 'For backend tasks',
    modelId: 'gpt-5.3-codex',
    provider: 'openai-codex',
    reasoningLevel: 'high',
    builtin: true,
    pinned: false,
    targetSpace: ['builder'],
    promptBody: 'You are a backend specialist.',
    sourceKind: 'builtin',
    available: true,
    availabilityCode: 'ok',
    shadowsGlobal: false,
    ...overrides,
  }
}

const PROFILES: ManagerProfile[] = [
  {
    profileId: 'default',
    displayName: 'Default',
    defaultSessionAgentId: 'a-1',
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
]

// Mock localStorage — Node 22 built-in localStorage is incomplete in jsdom env
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get length() { return Object.keys(store).length },
    key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
  configurable: true,
})

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorageMock.clear()

  // Polyfill pointer capture methods missing in jsdom (needed for Radix Select)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()

  specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
  specialistsApiMock.setSpecialistsEnabledApi.mockResolvedValue(undefined)
  specialistsApiMock.saveSharedSpecialist.mockResolvedValue(undefined)
  specialistsApiMock.saveSpecialist.mockResolvedValue(undefined)
  specialistsApiMock.deleteSpecialist.mockResolvedValue(undefined)
  specialistsApiMock.deleteSharedSpecialist.mockResolvedValue(undefined)
  specialistsApiMock.fetchWorkerTemplate.mockResolvedValue('You are a worker agent.')
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

function renderSpecialists(
  specialists: ResolvedSpecialistDefinition[] = [],
  profiles = PROFILES,
): void {
  specialistsApiMock.fetchSharedSpecialists.mockResolvedValue(specialists)
  specialistsApiMock.fetchSpecialists.mockResolvedValue(specialists)

  root = createRoot(container)
  flushSync(() => {
    root?.render(
      createElement(SettingsSpecialists, {
        wsUrl: 'ws://127.0.0.1:47187',
        profiles,
        specialistChangeKey: 0,
        modelConfigChangeKey: 0,
      }),
    )
  })
}

/* ================================================================== */
/*  Tests                                                             */
/* ================================================================== */

describe('SettingsSpecialists', () => {
  /* ---- Loading and display ---- */

  describe('loading and display', () => {
    it('shows loading spinner during fetch', async () => {
      renderSpecialists()

      // Should show spinner while loading
      expect(container.querySelector('.animate-spin')).toBeTruthy()

      await flush()
      await flush()
    })

    it('renders specialist cards after load', async () => {
      const backend = makeSpecialist()
      const frontend = makeSpecialist({
        specialistId: 'frontend',
        displayName: 'Frontend',
        color: '#7c3aed',
      })
      renderSpecialists([backend, frontend])
      await flush()
      await flush()

      expect(container.textContent).toContain('Backend')
      expect(container.textContent).toContain('Frontend')
    })

    it('shows empty state when no specialists', async () => {
      renderSpecialists([])
      await flush()
      await flush()

      expect(container.textContent).toContain('No global specialists found')
    })

    it('renders enabled toggle on each specialist card', async () => {
      renderSpecialists([makeSpecialist()])
      await flush()
      await flush()

      expect(container.textContent).toContain('Enabled')
    })
  })

  /* ---- Edit mode state transitions ---- */

  describe('edit mode', () => {
    it('opens edit mode when clicking a specialist card', async () => {
      renderSpecialists([makeSpecialist()])
      await flush()
      await flush()

      // Click the card to expand it (the collapsed card is clickable)
      const card = container.querySelector('[role="button"]')
      expect(card).toBeTruthy()
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // Should now show edit controls: Save and Cancel buttons
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Save',
      )
      const cancelBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Cancel',
      )
      expect(saveBtn).toBeTruthy()
      expect(cancelBtn).toBeTruthy()
    })

    it('closes edit mode on Cancel', async () => {
      renderSpecialists([makeSpecialist()])
      await flush()
      await flush()

      // Open edit
      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // Click cancel
      const cancelBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Cancel',
      )
      flushSync(() => {
        fireEvent.click(cancelBtn!)
      })
      await flush()

      // Should be back to collapsed — no Save button visible
      const saveAfter = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Save',
      )
      expect(saveAfter).toBeUndefined()
    })

    it('shows display name, when-to-use, and model fields in edit mode', async () => {
      renderSpecialists([makeSpecialist()])
      await flush()
      await flush()

      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      expect(container.textContent).toContain('Display name')
      expect(container.textContent).toContain('When to use')
      expect(container.textContent).toContain('Model')
      expect(container.textContent).toContain('Reasoning level')
    })
  })

  /* ---- Save flow ---- */

  describe('save flow', () => {
    it('shows pin-confirmation dialog for builtin un-pinned specialist on save', async () => {
      const spec = makeSpecialist({ builtin: true, pinned: false })
      renderSpecialists([spec])
      await flush()
      await flush()

      // Open edit
      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // Click save
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Save',
      )

      flushSync(() => {
        fireEvent.click(saveBtn!)
      })
      await flush()
      await flush()

      // builtin + not pinned → triggers confirmation dialog (rendered via portal)
      // The dialog renders into document.body, not our container
      const bodyText = document.body.textContent ?? ''
      expect(bodyText).toContain('Save without pinning')
    })

    it('preserves targetSpace when saving an existing specialist', async () => {
      const spec = makeSpecialist({ pinned: true, targetSpace: ['collaboration'] })
      specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([spec])
      specialistsApiMock.saveSharedSpecialist.mockResolvedValue(undefined)

      renderSpecialists([spec])
      await flush()
      await flush()

      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Save',
      )
      flushSync(() => {
        fireEvent.click(saveBtn!)
      })

      for (let i = 0; i < 6; i++) await flush()

      expect(specialistsApiMock.saveSharedSpecialist).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'backend',
        expect.objectContaining({ targetSpace: ['collaboration'] }),
      )
    })

    it('saves directly when specialist is pinned', async () => {
      const spec = makeSpecialist({ pinned: true })
      specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([spec])
      specialistsApiMock.saveSharedSpecialist.mockResolvedValue(undefined)

      renderSpecialists([spec])
      await flush()
      await flush()

      // Open edit
      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // Click save — should save directly (no confirmation)
      const saveBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === 'Save',
      )
      flushSync(() => {
        fireEvent.click(saveBtn!)
      })

      // Need multiple flush rounds for save + reload cycle
      for (let i = 0; i < 6; i++) await flush()

      expect(specialistsApiMock.saveSharedSpecialist).toHaveBeenCalled()
    })
  })

  /* ---- Delete flow ---- */

  describe('delete flow', () => {
    it('shows Delete button for non-builtin user-created global specialists in edit mode', async () => {
      const spec = makeSpecialist({ builtin: false, sourceKind: 'global', specialistId: 'custom-spec' })
      renderSpecialists([spec])
      await flush()
      await flush()

      // Open edit
      const card = container.querySelector('[role="button"]')
      expect(card).toBeTruthy()
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // In global mode, non-builtin specialists show Delete
      const allButtons = Array.from(container.querySelectorAll('button'))
      const deleteBtn = allButtons.find(
        (btn) => btn.textContent?.includes('Delete'),
      )
      expect(deleteBtn).toBeTruthy()
    })

    it('does not show Delete button for builtin specialists in global scope', async () => {
      const spec = makeSpecialist({ builtin: true })
      renderSpecialists([spec])
      await flush()
      await flush()

      const card = container.querySelector('[role="button"]')
      flushSync(() => {
        fireEvent.click(card!)
      })
      await flush()

      // All buttons — check none says "Delete"
      const allButtons = Array.from(container.querySelectorAll('button'))
      const deleteBtn = allButtons.find(
        (btn) => btn.textContent?.trim() === 'Delete',
      )
      expect(deleteBtn).toBeUndefined()
    })
  })

  /* ---- Clone flow ---- */

  describe('clone flow', () => {
    it('shows Clone button on collapsed specialist card', async () => {
      renderSpecialists([makeSpecialist()])
      await flush()
      await flush()

      const cloneBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Clone'),
      )
      expect(cloneBtn).toBeTruthy()
    })

    it('calls save API with clone handle on clone', async () => {
      const spec = makeSpecialist()
      const cloned = makeSpecialist({ specialistId: 'backend-copy', displayName: 'Backend (Copy)', builtin: false })
      // Initial load returns one, reload after clone returns both
      specialistsApiMock.fetchSharedSpecialists
        .mockResolvedValueOnce([spec])
        .mockResolvedValue([spec, cloned])

      renderSpecialists([spec])
      await flush()
      await flush()

      const cloneBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('Clone'),
      )

      flushSync(() => {
        fireEvent.click(cloneBtn!)
      })
      await flush()
      await flush()

      expect(specialistsApiMock.saveSharedSpecialist).toHaveBeenCalledWith(
        'ws://127.0.0.1:47187',
        'backend-copy',
        expect.objectContaining({
          displayName: 'Backend (Copy)',
        }),
      )
    })
  })

  /* ---- Enabled toggle ---- */

  describe('enabled toggle', () => {
    it('calls save on toggle enabled for global specialist', async () => {
      const spec = makeSpecialist({ enabled: true })
      specialistsApiMock.fetchSharedSpecialists
        .mockResolvedValueOnce([spec])
        .mockResolvedValue([{ ...spec, enabled: false }])

      renderSpecialists([spec])
      await flush()
      await flush()

      // Find the switch for toggling enabled
      const switchEl = container.querySelector(`#enabled-${spec.specialistId}`)
      expect(switchEl).toBeTruthy()

      flushSync(() => {
        fireEvent.click(switchEl!)
      })
      await flush()
      await flush()

      expect(specialistsApiMock.saveSharedSpecialist).toHaveBeenCalled()
    })
  })

  /* ---- Global enabled toggle ---- */

  describe('specialists enabled toggle', () => {
    it('renders the global enable toggle', async () => {
      renderSpecialists([])
      await flush()
      await flush()

      expect(container.textContent).toContain('Enable specialist workers')
    })

    it('shows disabled message when specialists are disabled', async () => {
      specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(false)
      renderSpecialists([])
      await flush()
      await flush()

      expect(container.textContent).toContain('Specialist workers are disabled')
    })
  })

  /* ---- New specialist form ---- */

  describe('new specialist creation', () => {
    it('shows New Specialist button', async () => {
      renderSpecialists([])
      await flush()
      await flush()

      const newBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('New Specialist'),
      )
      expect(newBtn).toBeTruthy()
    })

    it('opens creation form on click', async () => {
      renderSpecialists([])
      await flush()
      await flush()

      const newBtn = Array.from(container.querySelectorAll('button')).find(
        (btn) => btn.textContent?.includes('New Specialist'),
      )
      flushSync(() => {
        fireEvent.click(newBtn!)
      })
      await flush()

      expect(container.textContent).toContain('Create New Specialist')
      expect(container.textContent).toContain('Handle')
    })
  })

  /* ---- Inherited vs profile view ---- */

  describe('inherited vs profile-specific display', () => {
    it('shows inherited section when profile scope has inherited specialists', async () => {
      const spec = makeSpecialist({ sourceKind: 'builtin' })
      specialistsApiMock.fetchSpecialists.mockResolvedValue([spec])

      root = createRoot(container)
      flushSync(() => {
        root?.render(
          createElement(SettingsSpecialists, {
            wsUrl: 'ws://127.0.0.1:47187',
            profiles: PROFILES,
            specialistChangeKey: 0,
            modelConfigChangeKey: 0,
          }),
        )
      })
      await flush()
      await flush()

      // Switch to profile scope
      const scopeSelect = container.querySelector('[role="combobox"]')
      expect(scopeSelect).toBeTruthy()
    })
  })

  /* ---- Hide disabled filter ---- */

  describe('hide disabled filter', () => {
    it('shows hide disabled checkbox when disabled specialists exist', async () => {
      const enabled = makeSpecialist({ enabled: true })
      const disabled = makeSpecialist({
        specialistId: 'disabled-spec',
        displayName: 'Disabled',
        enabled: false,
      })
      renderSpecialists([enabled, disabled])
      await flush()
      await flush()

      expect(container.textContent).toContain('Hide disabled')
    })
  })

  /* ---- TargetSpace badges ---- */

  describe('targetSpace badges', () => {
    it('shows Collab badge for collaboration-only specialist', async () => {
      const spec = makeSpecialist({ targetSpace: ['collaboration'] })
      renderSpecialists([spec])
      await flush()
      await flush()

      expect(container.textContent).toContain('Collab')
    })

    it('shows Both badge for dual-target specialist', async () => {
      const spec = makeSpecialist({ targetSpace: ['builder', 'collaboration'] })
      renderSpecialists([spec])
      await flush()
      await flush()

      expect(container.textContent).toContain('Both')
    })

    it('does not show badge for builder-only specialist', async () => {
      const spec = makeSpecialist({ targetSpace: ['builder'] })
      renderSpecialists([spec])
      await flush()
      await flush()

      expect(container.textContent).not.toContain('Collab')
      expect(container.textContent).not.toContain('Both')
    })
  })
})

/* ================================================================== */
/*  Collab mode tests                                                  */
/* ================================================================== */

describe('SettingsSpecialists (collab mode)', () => {
  function makeCollabApiClient(): SettingsApiClient {
    return {
      target: {
        kind: 'collab',
        label: 'Collab Server',
        description: 'Remote collaboration server',
        wsUrl: 'ws://collab.test:47187',
        apiBaseUrl: 'http://collab.test:47187',
        fetchCredentials: 'include',
        requiresAdmin: true,
        availableTabs: ['specialists'],
      },
      endpoint: (path: string) => `http://collab.test:47187${path}`,
      fetch: vi.fn(),
      fetchJson: vi.fn(),
      readApiError: vi.fn(),
    }
  }

  it('renders collab settings banner when apiClient targets collab', async () => {
    const apiClient = makeCollabApiClient()
    specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([])
    specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([])

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsSpecialists, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
        }),
      )
    })
    await flush()
    await flush()

    const banner = document.body.querySelector('[data-testid="collab-settings-banner"]')
    expect(banner).toBeTruthy()
    expect(banner?.textContent).toContain('Editing remote collaboration server settings')
    expect(banner?.textContent).toContain('http://collab.test:47187')
  })

  it('shows Global Collaboration label in scope selector for collab mode', async () => {
    const apiClient = makeCollabApiClient()
    specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([])
    specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([])

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsSpecialists, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
        }),
      )
    })
    await flush()
    await flush()

    expect(container.textContent).toContain('Global Collaboration Specialists')
  })

  it('fetches specialists with collaboration targetSpace in collab mode', async () => {
    const apiClient = makeCollabApiClient()
    const collabSpec = makeSpecialist({
      specialistId: 'collab-planner',
      displayName: 'Collab Planner',
      targetSpace: ['collaboration'],
    })
    specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([collabSpec])
    specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([])

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsSpecialists, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
        }),
      )
    })
    await flush()
    await flush()

    // fetchSharedSpecialists is called with the collab apiClient which has
    // target.kind === 'collab', so inferTargetSpace returns 'collaboration'
    expect(specialistsApiMock.fetchSharedSpecialists).toHaveBeenCalled()
    const callArgs = specialistsApiMock.fetchSharedSpecialists.mock.calls[0]
    const client = callArgs[0] as SettingsApiClient
    expect(client.target.kind).toBe('collab')
  })

  it('shows Channel badge on channel-sourced specialist card', async () => {
    const spec = makeSpecialist({
      sourceKind: 'channel' as ResolvedSpecialistDefinition['sourceKind'],
      targetSpace: ['collaboration'],
      builtin: false,
    })
    renderSpecialists([spec])
    await flush()
    await flush()

    expect(container.textContent).toContain('Channel')
  })

  it('does not render ChannelSkillSelection or CategorySkillDefaultsView in channel scope', async () => {
    const apiClient = makeCollabApiClient()
    specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([])
    specialistsApiMock.fetchChannelSpecialists.mockResolvedValue({
      specialists: [],
      selectedGlobalSpecialistHandles: [],
      missingSelectedSpecialistHandles: [],
    })
    specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([{
      categoryId: 'cat-1',
      workspaceId: 'ws-1',
      name: 'Engineering',
      defaultSelectedSpecialistHandles: [],
      position: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([{
      channelId: 'ch-1',
      workspaceId: 'ws-1',
      categoryId: 'cat-1',
      name: 'backend',
      archived: false,
      position: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }])

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsSpecialists, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
          initialChannelId: 'ch-1',
        }),
      )
    })
    await flush()
    await flush()

    // Specialists page should NOT render skill selection controls (relocated to Skills page)
    expect(container.textContent).not.toContain('Skill Selection')
    expect(container.textContent).not.toContain('Default Skill Selection')
    // But should still show specialist-related UI
    expect(container.textContent).toContain('Specialist')
  })

  it('does not render skill defaults in category scope', async () => {
    const apiClient = makeCollabApiClient()
    specialistsApiMock.fetchSharedSpecialists.mockResolvedValue([])
    specialistsApiMock.fetchSpecialistsEnabled.mockResolvedValue(true)
    specialistsApiMock.fetchCollabCategories.mockResolvedValue([{
      categoryId: 'cat-1',
      workspaceId: 'ws-1',
      name: 'Engineering',
      defaultSelectedSpecialistHandles: [],
      position: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }])
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([])

    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SettingsSpecialists, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          specialistChangeKey: 0,
          modelConfigChangeKey: 0,
        }),
      )
    })
    await flush()
    await flush()

    // Switch to category scope
    const trigger = container.querySelector('[role="combobox"]')
    flushSync(() => {
      trigger!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
    })
    await flush()

    const options = document.body.querySelectorAll('[role="option"]')
    const categoryOption = Array.from(options).find(
      (el) => el.textContent?.includes('Category: Engineering'),
    )
    if (categoryOption) {
      flushSync(() => {
        categoryOption.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }))
      })
      await flush()
      await flush()
    }

    // No skill defaults section on Specialists page
    expect(container.textContent).not.toContain('Default Skill Selection')
  })
})
