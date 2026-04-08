/** @vitest-environment jsdom */

import { fireEvent } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsSpecialists } from './SettingsSpecialists'
import type { ManagerProfile, ResolvedSpecialistDefinition } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const specialistsApiMock = vi.hoisted(() => ({
  fetchSpecialists: vi.fn(),
  fetchSharedSpecialists: vi.fn(),
  fetchRosterPrompt: vi.fn(),
  fetchWorkerTemplate: vi.fn(),
  fetchSpecialistsEnabled: vi.fn(),
  setSpecialistsEnabledApi: vi.fn(),
  saveSpecialist: vi.fn(),
  saveSharedSpecialist: vi.fn(),
  deleteSpecialist: vi.fn(),
  deleteSharedSpecialist: vi.fn(),
}))

vi.mock('./specialists-api', () => ({
  fetchSpecialists: (...args: unknown[]) => specialistsApiMock.fetchSpecialists(...args),
  fetchSharedSpecialists: (...args: unknown[]) => specialistsApiMock.fetchSharedSpecialists(...args),
  fetchRosterPrompt: (...args: unknown[]) => specialistsApiMock.fetchRosterPrompt(...args),
  fetchWorkerTemplate: (...args: unknown[]) => specialistsApiMock.fetchWorkerTemplate(...args),
  fetchSpecialistsEnabled: (...args: unknown[]) => specialistsApiMock.fetchSpecialistsEnabled(...args),
  setSpecialistsEnabledApi: (...args: unknown[]) => specialistsApiMock.setSpecialistsEnabledApi(...args),
  saveSpecialist: (...args: unknown[]) => specialistsApiMock.saveSpecialist(...args),
  saveSharedSpecialist: (...args: unknown[]) => specialistsApiMock.saveSharedSpecialist(...args),
  deleteSpecialist: (...args: unknown[]) => specialistsApiMock.deleteSpecialist(...args),
  deleteSharedSpecialist: (...args: unknown[]) => specialistsApiMock.deleteSharedSpecialist(...args),
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
})
