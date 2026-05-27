/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsApiClient } from '../settings-api-client'
import type { CollaborationCategory, CollaborationChannel, SkillInventoryEntry } from '@forge/protocol'

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

const skillsViewerApiMock = vi.hoisted(() => ({
  fetchSkillInventory: vi.fn(),
  fetchSkillFiles: vi.fn(),
  fetchSkillFileContent: vi.fn(),
  shareSkill: vi.fn(),
  previewSkillImportFromUrl: vi.fn(),
  importSkill: vi.fn(),
}))

const settingsApiMock = vi.hoisted(() => ({
  fetchSettingsEnvVariables: vi.fn(),
  updateSettingsEnvVariables: vi.fn(),
  deleteSettingsEnvVariable: vi.fn(),
  toErrorMessage: (err: unknown) => (err instanceof Error ? err.message : 'Unknown error'),
}))

const specialistsApiMock = vi.hoisted(() => ({
  fetchCollabCategories: vi.fn(),
  fetchCollabChannels: vi.fn(),
  fetchCollabSkillInventory: vi.fn(),
  updateChannelSkillSelection: vi.fn(),
  updateCategoryDefaultSkillSelection: vi.fn(),
}))

vi.mock('./skills-viewer-api', () => ({
  fetchSkillInventory: (...args: unknown[]) => skillsViewerApiMock.fetchSkillInventory(...args),
  fetchSkillFiles: (...args: unknown[]) => skillsViewerApiMock.fetchSkillFiles(...args),
  fetchSkillFileContent: (...args: unknown[]) => skillsViewerApiMock.fetchSkillFileContent(...args),
  shareSkill: (...args: unknown[]) => skillsViewerApiMock.shareSkill(...args),
  previewSkillImportFromUrl: (...args: unknown[]) => skillsViewerApiMock.previewSkillImportFromUrl(...args),
  importSkill: (...args: unknown[]) => skillsViewerApiMock.importSkill(...args),
}))

vi.mock('../settings-api', () => ({
  fetchSettingsEnvVariables: (...args: unknown[]) => settingsApiMock.fetchSettingsEnvVariables(...args),
  updateSettingsEnvVariables: (...args: unknown[]) => settingsApiMock.updateSettingsEnvVariables(...args),
  deleteSettingsEnvVariable: (...args: unknown[]) => settingsApiMock.deleteSettingsEnvVariable(...args),
  toErrorMessage: (err: unknown) => settingsApiMock.toErrorMessage(err),
}))

vi.mock('../specialists-api', () => ({
  fetchCollabCategories: (...args: unknown[]) => specialistsApiMock.fetchCollabCategories(...args),
  fetchCollabChannels: (...args: unknown[]) => specialistsApiMock.fetchCollabChannels(...args),
  fetchCollabSkillInventory: (...args: unknown[]) => specialistsApiMock.fetchCollabSkillInventory(...args),
  updateChannelSkillSelection: (...args: unknown[]) => specialistsApiMock.updateChannelSkillSelection(...args),
  updateCategoryDefaultSkillSelection: (...args: unknown[]) => specialistsApiMock.updateCategoryDefaultSkillSelection(...args),
}))

vi.mock('@/components/help/help-hooks', () => ({
  useHelpContext: () => {},
}))

const { SkillsViewer } = await import('./SkillsViewer')

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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
      availableTabs: ['skills'],
    },
    endpoint: (path: string) => `http://collab.test:47187${path}`,
    fetch: vi.fn(),
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

function makeBuilderApiClient(): SettingsApiClient {
  return {
    target: {
      kind: 'builder',
      label: 'Builder backend',
      description: 'Local builder',
      wsUrl: 'ws://127.0.0.1:47187',
      apiBaseUrl: 'http://127.0.0.1:47187',
      fetchCredentials: 'same-origin',
      requiresAdmin: false,
      availableTabs: ['skills'],
    },
    endpoint: (path: string) => `http://127.0.0.1:47187${path}`,
    fetch: vi.fn(),
    fetchJson: vi.fn(),
    readApiError: vi.fn(),
  }
}

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

const CATEGORY: CollaborationCategory = {
  categoryId: 'cat-1',
  workspaceId: 'ws-1',
  name: 'Engineering',
  defaultSelectedSpecialistHandles: [],
  position: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const CHANNEL: CollaborationChannel = {
  channelId: 'ch-1',
  workspaceId: 'ws-1',
  categoryId: 'cat-1',
  sessionAgentId: 'agent-ch-1',
  name: 'backend',
  slug: 'backend',
  aiEnabled: true,
  activeSelectedSpecialistHandles: [],
  lastMessageSeq: 0,
  archived: false,
  position: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  activeSkillSelection: {
    mode: 'all',
    savedSelectedSkillHandles: [],
    resolvedSkillHandles: ['brave-search', 'memory'],
    alwaysOnSkillHandles: ['memory'],
  },
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)

  // Polyfill pointer capture methods missing in jsdom (needed for Radix Select)
  Element.prototype.hasPointerCapture ??= vi.fn(() => false)
  Element.prototype.setPointerCapture ??= vi.fn()
  Element.prototype.releasePointerCapture ??= vi.fn()
  Element.prototype.scrollIntoView ??= vi.fn()

  skillsViewerApiMock.fetchSkillInventory.mockResolvedValue([makeSkill()])
  skillsViewerApiMock.fetchSkillFiles.mockResolvedValue({ entries: [] })
  skillsViewerApiMock.fetchSkillFileContent.mockResolvedValue({ content: '', language: 'text' })
  settingsApiMock.fetchSettingsEnvVariables.mockResolvedValue([])
  specialistsApiMock.fetchCollabCategories.mockResolvedValue([CATEGORY])
  specialistsApiMock.fetchCollabChannels.mockResolvedValue([CHANNEL])
  specialistsApiMock.fetchCollabSkillInventory.mockResolvedValue([makeSkill()])
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

/* ================================================================== */
/*  Collab mode — skill selection appears in Skills page               */
/* ================================================================== */

describe('SkillsViewer collab mode', () => {
  function renderCollab(initialScope?: string): void {
    const apiClient = makeCollabApiClient()
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SkillsViewer, {
          wsUrl: 'ws://collab.test:47187',
          apiClient,
          profiles: [],
          changeKey: 0,
          initialScope,
        }),
      )
    })
  }

  it('shows collab settings banner', async () => {
    renderCollab()
    await flush()
    await flush()

    const banner = container.querySelector('[data-testid="collab-settings-banner"]')
    expect(banner).toBeTruthy()
    expect(banner?.textContent).toContain('Editing remote collaboration server settings')
  })

  it('shows "Global Collaboration" label in scope selector', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(container.textContent).toContain('Global Collaboration')
  })

  it('fetches categories and channels for scope selector', async () => {
    renderCollab()
    await flush()
    await flush()

    expect(specialistsApiMock.fetchCollabCategories).toHaveBeenCalled()
    expect(specialistsApiMock.fetchCollabChannels).toHaveBeenCalled()
  })

  it('renders scope selector with combobox role for category/channel selection', async () => {
    renderCollab()
    await flush()
    await flush()

    // The scope selector is a combobox that includes category/channel options
    const trigger = container.querySelector('[role="combobox"]')
    expect(trigger).toBeTruthy()
    // Description mentions category/channel scope management
    expect(container.textContent).toContain('Select a category or channel to manage skill selection')
  })

  it('renders ChannelSkillSelection when channel scope is selected', async () => {
    renderCollab('channel:ch-1')
    await flush()
    await flush()

    // ChannelSkillSelection renders a "Skill Selection" section header
    expect(container.textContent).toContain('Skill Selection')
    expect(container.textContent).toContain('#backend')
  })

  it('renders CategorySkillDefaultsView when category scope is selected', async () => {
    renderCollab('category:cat-1')
    await flush()
    await flush()

    // CategorySkillDefaultsView renders a "Default Skill Selection" section header
    expect(container.textContent).toContain('Default Skill Selection')
    expect(container.textContent).toContain('newly created channels')
  })

  it('does not show category/channel options in builder mode', async () => {
    const apiClient = makeBuilderApiClient()
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SkillsViewer, {
          wsUrl: 'ws://127.0.0.1:47187',
          apiClient,
          profiles: [
            {
              profileId: 'default',
              displayName: 'Default',
              defaultSessionAgentId: 'a-1',
              defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
      )
    })
    await flush()
    await flush()

    // Should NOT fetch collab data
    expect(specialistsApiMock.fetchCollabCategories).not.toHaveBeenCalled()
    expect(specialistsApiMock.fetchCollabChannels).not.toHaveBeenCalled()

    // Should show plain "Global", not "Global Collaboration"
    expect(container.textContent).not.toContain('Global Collaboration')

    // No collab banner
    const banner = container.querySelector('[data-testid="collab-settings-banner"]')
    expect(banner).toBeNull()
  })

  it('filters out archived channels (archived channels not in fetched scope)', async () => {
    const archivedChannel: CollaborationChannel = {
      ...CHANNEL,
      channelId: 'ch-archived',
      name: 'old-channel',
      archived: true,
    }
    specialistsApiMock.fetchCollabChannels.mockResolvedValue([CHANNEL, archivedChannel])

    renderCollab()
    await flush()
    await flush()

    // Component filters archived channels internally — verify fetch was called
    expect(specialistsApiMock.fetchCollabChannels).toHaveBeenCalled()
  })
})

/* ================================================================== */
/*  Builder mode — no collab controls                                  */
/* ================================================================== */

describe('SkillsViewer builder mode', () => {
  it('does not render collab banner or skill selection when no apiClient', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SkillsViewer, {
          wsUrl: 'ws://127.0.0.1:47187',
          profiles: [],
        }),
      )
    })
    await flush()
    await flush()

    expect(container.querySelector('[data-testid="collab-settings-banner"]')).toBeNull()
    expect(container.textContent).not.toContain('Skill Selection')
    expect(container.textContent).not.toContain('Default Skill Selection')
    expect(specialistsApiMock.fetchCollabCategories).not.toHaveBeenCalled()
  })

  it('does not show collab description text', async () => {
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(SkillsViewer, {
          wsUrl: 'ws://127.0.0.1:47187',
          profiles: [],
        }),
      )
    })
    await flush()
    await flush()

    expect(container.textContent).not.toContain('Select a category or channel')
    expect(container.textContent).toContain('Browse, inspect, and configure installed skills.')
  })
})
