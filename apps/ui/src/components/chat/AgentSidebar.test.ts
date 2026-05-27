/** @vitest-environment jsdom */

import { getAllByRole, getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import { HelpProvider } from '@/components/help/HelpProvider'
import type { AgentDescriptor, AgentStatus, ManagerProfile } from '@forge/protocol'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: 'worker',
  }
}

let container: HTMLDivElement
let root: Root | null = null

// Provide a working localStorage stub for the test environment
const localStorageStore = new Map<string, string>()
const localStorageMock = {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageStore.set(key, value),
  removeItem: (key: string) => localStorageStore.delete(key),
  clear: () => localStorageStore.clear(),
  get length() { return localStorageStore.size },
  key: (index: number) => [...localStorageStore.keys()][index] ?? null,
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  localStorageStore.clear()
  vi.stubGlobal('localStorage', localStorageMock)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ scan: { summary: { needsReview: 0 } } }),
  })))
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  vi.unstubAllGlobals()
  root = null
  container.remove()
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

async function flushEffects(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

function profileFor(agent: AgentDescriptor): ManagerProfile {
  return {
    profileId: agent.agentId,
    displayName: agent.displayName || agent.agentId,
    defaultSessionAgentId: agent.agentId,
    defaultModel: { ...agent.model },
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }
}

function sessionManager(
  agentId: string,
  profileId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    profileId,
    sessionLabel: agentId === profileId ? 'Main' : agentId,
  }
}

function renderSidebar({
  agents,
  profiles,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenSettings = vi.fn(),
  onOpenCortexReview = vi.fn(),
  onOpenArchive,
  onArchiveSession,
  onArchiveProfile,
  isSettingsActive = false,
  statuses = {},
  wsUrl,
}: {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  onOpenCortexReview?: (agentId: string) => void
  onOpenArchive?: () => void
  onArchiveSession?: (agentId: string) => void
  onArchiveProfile?: (profileId: string) => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
  wsUrl?: string
}) {
  // Auto-generate profiles from managers if not explicitly provided
  const resolvedProfiles = profiles ?? agents
    .filter((a) => a.role === 'manager')
    .map(profileFor)

  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(
        HelpProvider,
        null,
        createElement(AgentSidebar, {
          connected: true,
          wsUrl,
          agents,
          profiles: resolvedProfiles,
          statuses,
          unreadCounts: {},
          selectedAgentId,
          onAddManager: vi.fn(),
          onSelectAgent,
          onDeleteAgent,
          onDeleteManager,
          onOpenSettings,
          onOpenCortexReview,
          onOpenArchive,
          onArchiveSession,
          onArchiveProfile,
          isSettingsActive,
        }),
      ),
    )
  })
}

/**
 * Helper: the sidebar renders both a desktop and mobile instance.
 * Get the desktop sidebar (the first <aside>) for scoped queries.
 */
function getDesktopSidebar(): HTMLElement {
  const asides = container.querySelectorAll('aside')
  expect(asides.length).toBeGreaterThanOrEqual(1)
  return asides[0] as HTMLElement
}

describe('AgentSidebar', () => {
  it('opens Archive from the sidebar entry', () => {
    const onOpenArchive = vi.fn()
    renderSidebar({ agents: [sessionManager('manager-alpha', 'manager-alpha')], onOpenArchive })

    click(getByRole(getDesktopSidebar(), 'button', { name: 'Archive' }))

    expect(onOpenArchive).toHaveBeenCalledTimes(1)
  })

  it('shows archive actions and disables direct archive for the default session with explanatory copy', async () => {
    const onArchiveSession = vi.fn()
    const onArchiveProfile = vi.fn()
    const defaultSession = sessionManager('project-a', 'project-a')
    const extraSession = sessionManager('project-a--s2', 'project-a')
    const projectProfile: ManagerProfile = {
      ...profileFor(defaultSession),
      profileId: 'project-a',
      displayName: 'Project A',
      defaultSessionAgentId: 'project-a',
    }

    renderSidebar({
      agents: [defaultSession, extraSession],
      profiles: [projectProfile],
      selectedAgentId: 'project-a',
      onArchiveSession,
      onArchiveProfile,
    })
    const sidebar = getDesktopSidebar()

    const sessionRow = getByText(sidebar, 'project-a--s2')
    flushSync(() => {
      sessionRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    const archiveSessionItem = getAllByRole(document.body, 'menuitem').find((item) => item.textContent === 'Archive')
    expect(archiveSessionItem).toBeTruthy()
    click(archiveSessionItem as HTMLElement)
    expect(onArchiveSession).toHaveBeenCalledWith('project-a--s2')

    const defaultRow = getByText(sidebar, 'Main')
    flushSync(() => {
      defaultRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    expect(queryByText(document.body, 'The default session for a project can’t be archived directly.')).toBeTruthy()

    const profileHeader = getByText(sidebar, 'Project A').closest('button')
    expect(profileHeader).toBeTruthy()
    flushSync(() => {
      profileHeader!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()
    const archiveProjectItem = getAllByRole(document.body, 'menuitem').find((item) => item.textContent?.includes('Archive Project'))
    expect(archiveProjectItem).toBeTruthy()
    click(archiveProjectItem as HTMLElement)
    expect(onArchiveProfile).toHaveBeenCalledWith('project-a')
  })

  it('shows workers under sessions and allows collapsing profile groups', () => {
    const mgr = sessionManager('manager-alpha', 'manager-alpha')
    const wrk = worker('worker-alpha', 'manager-alpha')

    renderSidebar({ agents: [mgr, wrk] })

    const sidebar = getDesktopSidebar()

    // Profile header shows the displayName
    expect(queryByText(sidebar, 'manager-alpha')).toBeTruthy()
    // Ensure the profile group + session workers are expanded before checking worker visibility.
    const maybeExpandProfileButton = sidebar.querySelector(
      'button[aria-label="Expand manager-alpha"]',
    ) as HTMLButtonElement | null
    if (maybeExpandProfileButton) {
      click(maybeExpandProfileButton)
    }

    const maybeExpandWorkersButton = sidebar.querySelector(
      'button[aria-label="Expand session workers"]',
    ) as HTMLButtonElement | null
    if (maybeExpandWorkersButton) {
      click(maybeExpandWorkersButton)
    }

    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()

    // Collapse the profile group
    click(getByRole(sidebar, 'button', { name: 'Collapse manager-alpha' }))
    // Session row and worker should be hidden
    expect(queryByText(sidebar, 'worker-alpha')).toBeNull()

    // Expand again
    click(getByRole(sidebar, 'button', { name: 'Expand manager-alpha' }))
    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()
  })

  it('renders profile and worker rows for mixed model providers without relying on runtime icons', () => {
    const mgr = sessionManager('manager-pi', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.5' })
    const wrkOpus = worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' })
    const wrkCodex = worker('worker-codex', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.4' })

    renderSidebar({ agents: [mgr, wrkOpus, wrkCodex] })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'manager-pi')).toBeTruthy()

    const maybeExpandWorkersButton = sidebar.querySelector(
      'button[aria-label="Expand session workers"]',
    ) as HTMLButtonElement | null
    if (maybeExpandWorkersButton) {
      click(maybeExpandWorkersButton)
    }

    expect(queryByText(sidebar, 'worker-opus')).toBeTruthy()
    expect(queryByText(sidebar, 'worker-codex')).toBeTruthy()
  })

  it('keeps profile/session selection behavior working', () => {
    const onSelectAgent = vi.fn()
    const mgr = sessionManager('manager-alpha', 'manager-alpha')
    const wrk = worker('worker-alpha', 'manager-alpha')

    renderSidebar({
      agents: [mgr, wrk],
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()

    // Clicking the profile header selects the default session
    const profileButton = getByText(sidebar, 'manager-alpha').closest('button') as HTMLButtonElement
    click(profileButton)
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn()
    const mgr = sessionManager('manager-alpha', 'manager-alpha')

    renderSidebar({
      agents: [mgr],
      onOpenSettings,
    })

    const sidebar = getDesktopSidebar()

    // Use the bottom Settings button (aria-pressed attribute distinguishes it)
    const settingsButtons = getAllByRole(sidebar, 'button', { name: 'Settings' })
    // The last one is the bottom-nav settings button (not from context menus)
    const bottomSettingsBtn = settingsButtons[settingsButtons.length - 1]
    click(bottomSettingsBtn)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('renders multiple profiles sorted by createdAt', () => {
    const mgr1 = sessionManager('alpha-mgr', 'alpha-mgr')
    const mgr2 = {
      ...sessionManager('beta-mgr', 'beta-mgr'),
      displayName: 'beta-mgr',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }

    const p1: ManagerProfile = {
      profileId: 'alpha-mgr',
      displayName: 'alpha-mgr',
      defaultSessionAgentId: 'alpha-mgr',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const p2: ManagerProfile = {
      profileId: 'beta-mgr',
      displayName: 'beta-mgr',
      defaultSessionAgentId: 'beta-mgr',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [mgr1, mgr2],
      profiles: [p1, p2],
    })

    const sidebar = getDesktopSidebar()

    // Both profile names should be visible
    expect(queryByText(sidebar, 'alpha-mgr')).toBeTruthy()
    expect(queryByText(sidebar, 'beta-mgr')).toBeTruthy()
  })

  it('shows the outstanding Cortex review count badge and keeps review-run sessions hidden from the default sidebar list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ scan: { summary: { needsReview: 7 } } }),
    })))

    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const onOpenCortexReview = vi.fn()
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      onOpenCortexReview,
      wsUrl: 'ws://127.0.0.1:47187/ws',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'Review Run · Full Queue')).toBeNull()
    expect(getByText(sidebar, 'Review 7')).toBeTruthy()
    const reviewHint = getByRole(sidebar, 'button', { name: '1 review run hidden here — open them from Cortex Review.' })
    expect(reviewHint).toBeTruthy()

    click(reviewHint)
    expect(onOpenCortexReview).toHaveBeenCalledWith('cortex')
  })

  it('hides the Cortex review badge when there are no outstanding sessions needing review', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot],
      profiles: [cortexProfile],
      wsUrl: 'ws://127.0.0.1:47187/ws',
    })
    await flushEffects()

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, /^Review \d+$/)).toBeNull()
  })

  it('shows a running indicator when a hidden Cortex review run is active', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      status: 'streaming',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      statuses: {
        'cortex--s2': { status: 'streaming', pendingCount: 0 },
      },
    })

    const sidebar = getDesktopSidebar()
    expect(getByText(sidebar, 'Running')).toBeTruthy()
  })

  it('hides CLI sessions when the hide-cli-sessions localStorage pref is set', () => {
    // Set the hide pref before rendering
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
    })

    const sidebar = getDesktopSidebar()

    // Regular session should be visible
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    // CLI session should be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()

  })

  it('selects the first visible session from a profile header when CLI sessions are hidden', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')
    const onSelectAgent = vi.fn()

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      updatedAt: '2026-01-02T00:00:00.000Z',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
      onSelectAgent,
    })

    const sidebar = getDesktopSidebar()
    const profileButton = getByText(sidebar, 'My Project').closest('button') as HTMLButtonElement
    click(profileButton)
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('regular-session')
  })

  it('keeps a selected CLI session visible even when hide-cli-sessions is set', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
      selectedAgentId: 'cli-session',
    })

    const sidebar = getDesktopSidebar()

    // Selected CLI session should still be visible
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('keeps a CLI session visible when one of its workers is selected', () => {
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const cliWorker = worker('cli-worker', 'cli-session')
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession, cliWorker],
      profiles: [profile],
      selectedAgentId: 'cli-worker',
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('toggles CLI session visibility at runtime when localStorage pref changes', async () => {
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    renderSidebar({
      agents: [regularSession, cliSession],
      profiles: [profile],
    })

    const sidebar = getDesktopSidebar()

    // Both sessions should be visible initially
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Simulate the toggle to hide: write to localStorage and dispatch the pref-change event
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')
    flushSync(() => {
      window.dispatchEvent(new CustomEvent('forge-sidebar-pref-change', { detail: { key: 'forge-sidebar-hide-cli-sessions', value: true } }))
    })
    await flushEffects()

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()

    // Toggle back to show: clear the pref and dispatch the event again
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'false')
    flushSync(() => {
      window.dispatchEvent(new CustomEvent('forge-sidebar-pref-change', { detail: { key: 'forge-sidebar-hide-cli-sessions', value: false } }))
    })
    await flushEffects()

    // CLI session should be visible again
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
  })

  it('toggleHideCliSessions correctly persists true under StrictMode (regression: double-invoke must not flip back)', async () => {
    // Renders under <StrictMode> so React 19 double-invokes state updaters.
    // The old implementation placed a localStorage side-effect inside a functional
    // updater (prev => !prev), which React called twice — the second call received
    // the first's result as prev, flipping true back to false. This test fails with
    // the old code and passes with the fixed direct-read-then-set approach.
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    // Render under StrictMode to trigger double-invocation of updaters
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(StrictMode, null,
          createElement(HelpProvider, null,
            createElement(AgentSidebar, {
              connected: true,
              agents: [regularSession, cliSession],
              profiles: [profile],
              statuses: {},
              unreadCounts: {},
              selectedAgentId: 'regular-session',
              onAddManager: vi.fn(),
              onSelectAgent: vi.fn(),
              onDeleteAgent: vi.fn(),
              onDeleteManager: vi.fn(),
              onOpenSettings: vi.fn(),
              isSettingsActive: false,
            }),
          ),
        ),
      )
    })

    const sidebar = getDesktopSidebar()

    // Both sessions should be visible initially
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()
    expect(localStorageMock.getItem('forge-sidebar-hide-cli-sessions')).toBeNull()

    // Right-click the CLI session to open context menu, then click "Hide CLI Sessions"
    const cliRow = getByText(sidebar, 'CLI Run')
    const cliContextTrigger = cliRow.closest('[data-state]')?.parentElement ?? cliRow
    flushSync(() => {
      cliContextTrigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems = getAllByRole(document.body, 'menuitem')
    const hideMenuItem = menuItems.find((item) => item.textContent?.includes('Hide CLI Sessions'))
    expect(hideMenuItem).toBeTruthy()

    flushSync(() => {
      hideMenuItem!.click()
    })
    await flushEffects()

    // The localStorage pref must be 'true' after a single toggle — never 'false'.
    // With the old updater-side-effect implementation this would be 'false' under StrictMode.
    expect(localStorageMock.getItem('forge-sidebar-hide-cli-sessions')).toBe('true')
  })

  it('hides a previously-selected CLI session once selection moves to a non-CLI session', () => {
    // This verifies the complete hide-CLI-sessions UX lifecycle:
    // 1. CLI session is selected with hide pref ON → stays visible (selected exception)
    // 2. Selection moves to a non-CLI session → CLI session now properly hidden
    // In production, step 2 is triggered automatically by handleToggleHideCliSessions.
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const onSelectAgent = vi.fn()
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const sidebarProps = {
      connected: true,
      agents: [regularSession, cliSession],
      profiles: [profile],
      statuses: {} as Record<string, { status: AgentStatus; pendingCount: number }>,
      unreadCounts: {},
      onAddManager: vi.fn(),
      onSelectAgent,
      onDeleteAgent: vi.fn(),
      onDeleteManager: vi.fn(),
      onOpenSettings: vi.fn(),
      isSettingsActive: false,
    }

    // Phase 1: CLI session selected with hide ON — it stays visible (exception for selected)
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'cli-session',
      })))
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Phase 2: Selection moves to regular session (simulates auto-navigate)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'regular-session',
      })))
    })

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
  })

  it('hides a CLI session when selection moves away from its worker', () => {
    // Verifies the UX fix also works when a worker of a CLI session is selected:
    // auto-navigate should move selection to a non-CLI session.
    localStorageMock.setItem('forge-sidebar-hide-cli-sessions', 'true')

    const onSelectAgent = vi.fn()
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const cliWorker = worker('cli-worker', 'cli-session')
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    const sidebarProps = {
      connected: true,
      agents: [regularSession, cliSession, cliWorker],
      profiles: [profile],
      statuses: {} as Record<string, { status: AgentStatus; pendingCount: number }>,
      unreadCounts: {},
      onAddManager: vi.fn(),
      onSelectAgent,
      onDeleteAgent: vi.fn(),
      onDeleteManager: vi.fn(),
      onOpenSettings: vi.fn(),
      isSettingsActive: false,
    }

    // Phase 1: Worker of CLI session is selected — CLI session stays visible
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'cli-worker',
      })))
    })

    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Phase 2: Selection moves to regular session (simulates auto-navigate)
    flushSync(() => {
      root?.render(createElement(HelpProvider, null, createElement(AgentSidebar, {
        ...sidebarProps,
        selectedAgentId: 'regular-session',
      })))
    })

    // CLI session should now be hidden
    expect(queryByText(sidebar, 'CLI Run')).toBeNull()
    expect(queryByText(sidebar, 'regular-session')).toBeTruthy()
  })

  it('shows the selected Cortex review-run session so it stays directly reachable', () => {
    const createdAt = '2026-01-01T00:00:00.000Z'
    const updatedAt = createdAt
    const cortexRoot = {
      ...sessionManager('cortex', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Main',
      createdAt,
      updatedAt,
    }
    const reviewRunSession: AgentDescriptor = {
      ...sessionManager('cortex--s2', 'cortex'),
      displayName: 'Cortex',
      archetypeId: 'cortex',
      sessionLabel: 'Review Run · Full Queue',
      sessionPurpose: 'cortex_review',
      createdAt,
      updatedAt,
    }
    const cortexProfile: ManagerProfile = {
      profileId: 'cortex',
      displayName: 'Cortex',
      defaultSessionAgentId: 'cortex',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt,
      updatedAt,
    }

    renderSidebar({
      agents: [cortexRoot, reviewRunSession],
      profiles: [cortexProfile],
      selectedAgentId: 'cortex--s2',
    })

    const sidebar = getDesktopSidebar()
    expect(getByText(sidebar, 'Review Run · Full Queue')).toBeTruthy()
  })

  it('toggleHideCliSessions falls back to ref state when localStorage.getItem throws', async () => {
    // Verifies that when localStorage is completely unavailable (e.g. security
    // policy, quota error), the toggle still flips correctly using in-memory
    // ref state. We render under StrictMode to also exercise double-invoke.
    const regularSession = sessionManager('regular-session', 'mgr-profile')
    const cliSession: AgentDescriptor = {
      ...sessionManager('cli-session', 'mgr-profile'),
      sessionLabel: 'CLI Run',
      cli: { createdBy: 'forge-cli', runId: 'run-1', command: 'run', startedAt: '2026-01-01T00:00:00.000Z' },
    }
    const profile: ManagerProfile = {
      profileId: 'mgr-profile',
      displayName: 'My Project',
      defaultSessionAgentId: 'regular-session',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    // Start with hideCliSessions = false (default) via normal localStorage
    root = createRoot(container)
    flushSync(() => {
      root?.render(
        createElement(StrictMode, null,
          createElement(HelpProvider, null,
            createElement(AgentSidebar, {
              connected: true,
              agents: [regularSession, cliSession],
              profiles: [profile],
              statuses: {},
              unreadCounts: {},
              selectedAgentId: 'regular-session',
              onAddManager: vi.fn(),
              onSelectAgent: vi.fn(),
              onDeleteAgent: vi.fn(),
              onDeleteManager: vi.fn(),
              onOpenSettings: vi.fn(),
              isSettingsActive: false,
            }),
          ),
        ),
      )
    })
    await flushEffects()

    // CLI session should be visible initially (hideCliSessions = false)
    const sidebar = getDesktopSidebar()
    expect(queryByText(sidebar, 'CLI Run')).toBeTruthy()

    // Now make localStorage.getItem throw (simulates security/quota errors)
    // Keep setItem working so storeHideCliSessionsPref can still write.
    const throwingGetItem = (_key: string): string | null => { throw new Error('SecurityError') }
    vi.stubGlobal('localStorage', { ...localStorageMock, getItem: throwingGetItem })

    // Toggle hide → should use ref fallback (false) and compute next = true
    const cliRow = getByText(sidebar, 'CLI Run')
    const cliContextTrigger = cliRow.closest('[data-state]')?.parentElement ?? cliRow
    flushSync(() => {
      cliContextTrigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems = getAllByRole(document.body, 'menuitem')
    const hideMenuItem = menuItems.find((item) => item.textContent?.includes('Hide CLI Sessions'))
    expect(hideMenuItem).toBeTruthy()

    flushSync(() => {
      hideMenuItem!.click()
    })
    await flushEffects()

    // Despite getItem throwing, the toggle should have flipped to true via ref fallback.
    // storeHideCliSessionsPref calls setItem (which works) and dispatches a pref-change event.
    // The ref was in sync with the React state (false), so next = !false = true.
    // Check that localStorage received 'true' (setItem still works):
    expect(localStorageStore.get('forge-sidebar-hide-cli-sessions')).toBe('true')

    // Restore getItem for the reverse toggle test
    vi.stubGlobal('localStorage', { ...localStorageMock, getItem: throwingGetItem })

    // Now the ref should have updated to true (via the useEffect sync).
    // Toggle again → should read ref (true) and compute next = false.
    // Re-open context menu on the regular session (CLI is now hidden).
    // Use the profile header context menu instead since CLI row may be gone.
    const profileHeader = getByText(sidebar, 'My Project').closest('button')
    expect(profileHeader).toBeTruthy()
    flushSync(() => {
      profileHeader!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    await flushEffects()

    const menuItems2 = getAllByRole(document.body, 'menuitem')
    const showMenuItem = menuItems2.find((item) => item.textContent?.includes('Show CLI Sessions'))
    expect(showMenuItem).toBeTruthy()

    flushSync(() => {
      showMenuItem!.click()
    })
    await flushEffects()

    // Reverse toggle should have flipped back to false
    expect(localStorageStore.get('forge-sidebar-hide-cli-sessions')).toBe('false')

    // Restore original localStorage for cleanup
    vi.stubGlobal('localStorage', localStorageMock)
  })
})
