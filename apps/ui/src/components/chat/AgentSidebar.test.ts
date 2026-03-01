/** @vitest-environment jsdom */

import { getAllByRole, getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import type { AgentDescriptor, AgentStatus, ManagerProfile } from '@middleman/protocol'

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
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function profileFor(agent: AgentDescriptor): ManagerProfile {
  return {
    profileId: agent.agentId,
    displayName: agent.displayName || agent.agentId,
    defaultSessionAgentId: agent.agentId,
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
  isSettingsActive = false,
  statuses = {},
}: {
  agents: AgentDescriptor[]
  profiles?: ManagerProfile[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
}) {
  // Auto-generate profiles from managers if not explicitly provided
  const resolvedProfiles = profiles ?? agents
    .filter((a) => a.role === 'manager')
    .map(profileFor)

  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(AgentSidebar, {
        connected: true,
        agents,
        profiles: resolvedProfiles,
        statuses,
        selectedAgentId,
        onAddManager: vi.fn(),
        onSelectAgent,
        onDeleteAgent,
        onDeleteManager,
        onOpenSettings,
        isSettingsActive,
      }),
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
    // Worker visible (sessions with workers are expanded by default via toggle)
    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()

    // Collapse the profile group
    click(getByRole(sidebar, 'button', { name: 'Collapse manager-alpha' }))
    // Session row and worker should be hidden
    expect(queryByText(sidebar, 'worker-alpha')).toBeNull()

    // Expand again
    click(getByRole(sidebar, 'button', { name: 'Expand manager-alpha' }))
    expect(queryByText(sidebar, 'worker-alpha')).toBeTruthy()
  })

  it('shows runtime icons from model presets on profile headers', () => {
    const mgr = sessionManager('manager-pi', 'manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.3-codex' })
    const wrkOpus = worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' })
    const wrkCodex = worker('worker-codex', 'manager-pi', { provider: 'openai-codex-app-server', modelId: 'default' })

    renderSidebar({ agents: [mgr, wrkOpus, wrkCodex] })

    // Profile header uses the default session's runtime badge
    expect(container.querySelector('img[src="/pi-logo.svg"]')).toBeTruthy()
    expect(container.querySelector('img[src="/agents/codex-logo.svg"]')).toBeTruthy()
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
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const p2: ManagerProfile = {
      profileId: 'beta-mgr',
      displayName: 'beta-mgr',
      defaultSessionAgentId: 'beta-mgr',
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
})
