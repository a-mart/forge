/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, getByText, waitFor } from '@testing-library/dom'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import { ProfileGroup } from './ProfileGroup'
import type { ProfileGroupProps } from './types'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) flushSync(() => root?.unmount())
  root = null
  container.remove()
})

function makeAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'session-1',
    managerId: 'session-1',
    displayName: 'Project Alpha',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: '/tmp/session-1.jsonl',
    profileId: 'project-alpha',
    sessionLabel: 'Main',
    ...overrides,
  }
}

function makeProfile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: 'project-alpha',
    displayName: 'Project Alpha',
    defaultSessionAgentId: 'session-1',
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSession(agent: AgentDescriptor, workers: AgentDescriptor[] = []): SessionRow {
  return { sessionAgent: agent, workers, isDefault: true }
}

function makeWorker(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return makeAgent({
    agentId: 'worker-1',
    managerId: 'session-1',
    displayName: 'Worker 1',
    role: 'worker',
    sessionLabel: undefined,
    ...overrides,
  })
}

function renderGroup(overrides: Partial<ProfileGroupProps> = {}) {
  const session = makeSession(makeAgent(), [makeWorker()])
  const treeRow: ProfileTreeRow = {
    profile: makeProfile(),
    sessions: [session],
  }
  const props: ProfileGroupProps = {
    treeRow,
    statuses: {},
    unreadCounts: {},
    selectedAgentId: null,
    isSettingsActive: false,
    isCollapsed: false,
    collapsedSessionIds: new Set(),
    visibleSessionLimit: 5,
    expandedWorkerListSessionIds: new Set(),
    onToggleProfileCollapsed: vi.fn(),
    onToggleSessionCollapsed: vi.fn(),
    onShowMoreSessions: vi.fn(),
    onShowLessSessions: vi.fn(),
    onToggleWorkerListExpanded: vi.fn(),
    onSelect: vi.fn(),
    onDeleteAgent: vi.fn(),
    onDeleteManager: vi.fn(),
    onOpenSettings: vi.fn(),
    onCreateSession: vi.fn(),
    ...overrides,
  }

  root = createRoot(container)
  flushSync(() => {
    root?.render(createElement(ProfileGroup, props))
  })

  return props
}

function projectHeaderButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => {
    const label = candidate.getAttribute('aria-label') ?? ''
    return label.includes('project Project Alpha')
  })
  expect(button).toBeTruthy()
  return button as HTMLButtonElement
}

describe('ProfileGroup project row expand/collapse', () => {
  it('omits a dedicated project expand/collapse chevron', () => {
    renderGroup()
    const header = projectHeaderButton().parentElement
    expect(header).toBeTruthy()
    // No absolute-positioned chevron control inside the project header row
    expect(header!.querySelector('button.absolute')).toBeNull()
    expect(header!.querySelector('svg.lucide-chevron-right, svg.lucide-chevron-down')).toBeNull()
    expect(container.querySelector('[aria-label="Expand Project Alpha"]')).toBeNull()
    expect(container.querySelector('[aria-label="Collapse Project Alpha"]')).toBeNull()
  })

  it('toggles the project when the row itself is clicked', () => {
    const onToggleProfileCollapsed = vi.fn()
    renderGroup({ onToggleProfileCollapsed })
    flushSync(() => projectHeaderButton().click())
    expect(onToggleProfileCollapsed).toHaveBeenCalledTimes(1)
  })

  it('does not toggle when the embedded new-session action is clicked', () => {
    const onToggleProfileCollapsed = vi.fn()
    const onCreateSession = vi.fn()
    renderGroup({ onToggleProfileCollapsed, onCreateSession })

    const plus = container.querySelector('[aria-label="New session for Project Alpha"]') as HTMLButtonElement
    expect(plus).toBeTruthy()
    flushSync(() => plus.click())
    expect(onCreateSession).toHaveBeenCalledWith('project-alpha')
    expect(onToggleProfileCollapsed).not.toHaveBeenCalled()
  })

  it('opens Project Secrets for the exact project without selecting a task', async () => {
    const onOpenProjectSecrets = vi.fn()
    const onSelect = vi.fn()
    renderGroup({ onOpenProjectSecrets, onSelect })

    fireEvent.contextMenu(projectHeaderButton())
    const menuItem = await waitFor(() => getByText(document.body, 'Project Secrets'))
    fireEvent.click(menuItem)

    expect(onOpenProjectSecrets).toHaveBeenCalledWith('project-alpha')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('offers project settings from both the context menu and hover/focus ellipsis menu', async () => {
    const onOpenProjectSettings = vi.fn()
    const onSelect = vi.fn()
    renderGroup({ onOpenProjectSettings, onSelect })

    fireEvent.contextMenu(projectHeaderButton())
    const contextItem = await waitFor(() => getByText(document.body, 'Project Settings'))
    fireEvent.click(contextItem)
    expect(onOpenProjectSettings).toHaveBeenCalledWith('project-alpha')
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: 'Escape' })

    const ellipsis = container.querySelector('[aria-label="Project actions for Project Alpha"]') as HTMLButtonElement
    expect(ellipsis).toBeTruthy()
    expect(ellipsis.className).toContain('group-hover:opacity-100')
    fireEvent.pointerDown(ellipsis, { button: 0, ctrlKey: false, pointerType: 'mouse' })
    const dropdown = await waitFor(() => {
      const content = document.body.querySelector('[data-slot="dropdown-menu-content"]')
      expect(content).toBeTruthy()
      return content as HTMLElement
    })
    fireEvent.click(getByText(dropdown, 'Project Settings'))

    expect(onOpenProjectSettings).toHaveBeenLastCalledWith('project-alpha')
    expect(onOpenProjectSettings).toHaveBeenCalledTimes(2)
  })

  it('keeps session worker expand controls', () => {
    const onToggleSessionCollapsed = vi.fn()
    renderGroup({ onToggleSessionCollapsed })

    const workerToggle = container.querySelector('[aria-label="Expand session workers"]') as HTMLButtonElement
    expect(workerToggle).toBeTruthy()
    flushSync(() => workerToggle.click())
    expect(onToggleSessionCollapsed).toHaveBeenCalledWith('session-1')
  })
})
