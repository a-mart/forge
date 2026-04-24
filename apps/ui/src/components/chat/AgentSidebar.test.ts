/** @vitest-environment jsdom */

import { getAllByRole, getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
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
      modelId: 'gpt-5.3-codex',
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
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
    const mgr = sessionManager('manager-pi', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.3-codex' })
    const wrkOpus = worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' })
    const wrkCodex = worker('worker-codex', 'manager-pi', { provider: 'openai-codex-app-server', modelId: 'default' })

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
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const p2: ManagerProfile = {
      profileId: 'beta-mgr',
      displayName: 'beta-mgr',
      defaultSessionAgentId: 'beta-mgr',
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
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
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
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
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
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
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
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
      defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.3-codex', thinkingLevel: 'medium' },
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
})
