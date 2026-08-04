/** @vitest-environment jsdom */

import { fireEvent, getAllByRole, getByRole } from '@testing-library/dom'
import { createElement } from 'react'
import type React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoomsInbox } from './RoomsInbox'
import type { RoomsInboxSections, RoomsInboxSessionViewModel } from './rooms-inbox-selectors'

let root: Root | null = null
let container: HTMLDivElement

function view(agentId: string, reason: RoomsInboxSessionViewModel['reason'] = 'recently_updated'): RoomsInboxSessionViewModel {
  return {
    identity: { originId: agentId.startsWith('remote') ? 'remote' : 'local', profileId: 'project-a', sessionAgentId: agentId },
    label: agentId,
    profileName: 'Project A',
    agentStatus: 'idle',
    activeWorkerCount: 0,
    pendingChoiceCount: 0,
    unreadCount: 0,
    contextRecoveryInProgress: false,
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    timestamp: '2026-08-03T10:00:00.000Z',
    reason,
  }
}

function sections(overrides: Partial<RoomsInboxSections> = {}): RoomsInboxSections {
  return {
    needsYou: [],
    active: [],
    activeOverflowCount: 0,
    activeWorkerCount: 0,
    recent: [],
    projects: [],
    projectCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root?.unmount())
  root = null
  container.remove()
})

function renderInbox(props: Partial<React.ComponentProps<typeof RoomsInbox>> = {}) {
  const defaults: React.ComponentProps<typeof RoomsInbox> = {
    sections: sections(),
    onSelectSession: vi.fn(),
    onShowProjects: vi.fn(),
    onNewProject: vi.fn(),
    onAcknowledgeNeedsYou: vi.fn(),
    onClearNeedsYou: vi.fn(),
    ...props,
  }
  flushSync(() => root?.render(createElement(RoomsInbox, defaults)))
  return defaults
}

describe('RoomsInbox', () => {
  it('selects the origin-scoped row and does not change modes implicitly', () => {
    const onSelectSession = vi.fn()
    const onShowProjects = vi.fn()
    renderInbox({
      sections: sections({ needsYou: [view('remote-session', 'awaiting_choice')] }),
      onSelectSession,
      onShowProjects,
    })

    fireEvent.click(container.querySelector('[data-inbox-row="remote::remote-session"]') as HTMLButtonElement)

    expect(onSelectSession).toHaveBeenCalledWith({
      originId: 'remote',
      profileId: 'project-a',
      sessionAgentId: 'remote-session',
    })
    expect(onShowProjects).not.toHaveBeenCalled()
    expect(container.querySelector('[data-inbox-row="remote::remote-session"]')).not.toBeNull()
  })

  it('acknowledges Needs You rows without selecting them and Clear acknowledges every listed row', () => {
    const onSelectSession = vi.fn()
    const onAcknowledgeNeedsYou = vi.fn()
    const onClearNeedsYou = vi.fn()
    renderInbox({
      sections: sections({ needsYou: [view('needs-a', 'awaiting_choice'), view('needs-b', 'error')] }),
      onSelectSession,
      onAcknowledgeNeedsYou,
      onClearNeedsYou,
    })

    fireEvent.click(getByRole(container, 'button', { name: 'Mark "needs-a" done for Project A on local (needs-a)' }))
    expect(onAcknowledgeNeedsYou).toHaveBeenCalledWith({
      originId: 'local', profileId: 'project-a', sessionAgentId: 'needs-a',
    })
    expect(onSelectSession).not.toHaveBeenCalled()

    fireEvent.click(getByRole(container, 'button', { name: 'Clear' }))
    expect(onClearNeedsYou).toHaveBeenCalledWith([
      { originId: 'local', profileId: 'project-a', sessionAgentId: 'needs-a' },
      { originId: 'local', profileId: 'project-a', sessionAgentId: 'needs-b' },
    ])
  })

  it('gives duplicate labels distinct Done names and acknowledges from a keyboard-generated click', () => {
    const onAcknowledgeNeedsYou = vi.fn()
    const localMain = {
      ...view('main-local', 'awaiting_choice'),
      label: 'Main',
      profileName: 'Project Alpha',
    }
    const remoteMain = {
      ...view('remote-main', 'error'),
      label: 'Main',
      profileName: 'Project Beta',
    }
    renderInbox({
      sections: sections({ needsYou: [localMain, remoteMain] }),
      onAcknowledgeNeedsYou,
    })

    const doneControls = getAllByRole(container, 'button', { name: /^Mark "Main" done/ })
    const doneNames = doneControls.map((control) => control.getAttribute('aria-label'))
    expect(doneNames).toHaveLength(2)
    expect(new Set(doneNames).size).toBe(2)
    expect(doneNames).toEqual([
      'Mark "Main" done for Project Alpha on local (main-local)',
      'Mark "Main" done for Project Beta on remote (remote-main)',
    ])

    doneControls[0]?.focus()
    // Browser keyboard activation dispatches a click with detail 0 on a native button.
    fireEvent.click(doneControls[0]!, { detail: 0 })
    expect(onAcknowledgeNeedsYou).toHaveBeenCalledWith(localMain.identity)
  })

  it('keeps the explicit Active overflow mode switch but has no Projects shortcut list', () => {
    const onShowProjects = vi.fn()
    renderInbox({
      sections: sections({
        active: [view('active', 'manager_working')],
        activeOverflowCount: 2,
        activeWorkerCount: 1,
        // A session-only tree match has no shortcut-model project count.
        projectCount: 0,
      }),
      onShowProjects,
      projectTree: createElement('div', { 'data-testid': 'real-project-tree' }),
      hasInlineProjectContent: true,
    })

    fireEvent.click(getByRole(container, 'button', { name: '2 more' }))
    expect(onShowProjects).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('All 1')
    expect(container.querySelector('[data-testid="real-project-tree"]')).not.toBeNull()
  })

  it('offers New Project for an empty Inbox even when the shared project tree element is supplied', () => {
    const onNewProject = vi.fn()
    renderInbox({
      onNewProject,
      projectTree: createElement('p', null, 'No active agents.'),
      hasInlineProjectContent: false,
    })

    expect(container.querySelector('[data-testid="rooms-inbox-empty"]')).not.toBeNull()
    expect(container.textContent).not.toContain('No active agents')
    fireEvent.click(getByRole(container, 'button', { name: 'New Project' }))
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  it('uses Rooms chrome, project avatars, typed reasons, and non-overlapping trailing status pills', () => {
    const recent = { ...view('recent'), pinnedAt: '2026-08-03T09:00:00.000Z' }
    const active = {
      ...view('active', 'manager_working'),
      agentStatus: 'streaming' as const,
      activeWorkerCount: 2,
    }
    const tintedIdentity = { originId: 'local', profileId: 'project-b', sessionAgentId: '' }
    renderInbox({
      sections: sections({
        needsYou: [
          { ...view('choice', 'awaiting_choice'), identity: { ...tintedIdentity, sessionAgentId: 'choice' } },
          { ...view('unread', 'unread_result'), identity: { ...tintedIdentity, sessionAgentId: 'unread' }, unreadCount: 4 },
        ],
        active: [active, view('compact', 'compacting')],
        activeWorkerCount: 2,
        recent: [recent],
      }),
      mutedSessionIds: new Set(['recent']),
      now: new Date('2026-08-03T10:30:00.000Z'),
    })

    expect(container.querySelector('[data-inbox-section="needs-you"]')?.classList.contains('sidebar-room-inbox-section--needs-you')).toBe(true)
    expect(container.querySelector('[data-inbox-section="active"] .sidebar-room-active-dot')).not.toBeNull()
    expect(container.querySelectorAll('.sidebar-room-avatar')).toHaveLength(5)
    expect(container.querySelector('[data-inbox-row="local::choice"] .sidebar-room-status-pill--awaiting')).not.toBeNull()
    expect(container.querySelector('[aria-label="4 unread updates"]')).not.toBeNull()
    // Attention reason belongs in the status pill; avatars keep the same
    // per-project tint used by Recent and Projects.
    expect(container.querySelector('[data-inbox-row="local::choice"] .sidebar-room-avatar--violet')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::unread"] .sidebar-room-avatar--violet')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::unread"] .sidebar-room-inbox-reason--default')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::unread"] .sidebar-room-inbox-reason--unread_result')).toBeNull()
    expect(container.querySelector('[aria-label="2 workers active"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Compacting context"]')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::choice"] .sidebar-room-inbox-reason--awaiting_choice')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::recent"] [aria-label="Pinned"]')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::recent"] [aria-label="Muted"]')).not.toBeNull()
    expect(container.querySelector('[data-inbox-row="local::recent"] .sidebar-room-inbox-relative-time')).not.toBeNull()
  })

  it('uses neutral raised selection in Needs You and Recent, reserving the green inset ring for Active', () => {
    const sectionRows = sections({
      needsYou: [view('needs', 'awaiting_choice')],
      active: [view('active', 'manager_working')],
      recent: [view('recent')],
    })

    renderInbox({
      sections: sectionRows,
      selected: { originId: 'local', sessionAgentId: 'needs' },
    })
    expect(container.querySelector('[data-inbox-row="local::needs"]')?.parentElement?.classList.contains('sidebar-room-inbox-row-selected-neutral')).toBe(true)

    renderInbox({
      sections: sectionRows,
      selected: { originId: 'local', sessionAgentId: 'recent' },
    })
    expect(container.querySelector('[data-inbox-row="local::recent"]')?.parentElement?.classList.contains('sidebar-room-inbox-row-selected-neutral')).toBe(true)

    renderInbox({
      sections: sectionRows,
      selected: { originId: 'local', sessionAgentId: 'active' },
    })
    expect(container.querySelector('[data-inbox-row="local::active"]')?.parentElement?.classList.contains('sidebar-room-row-selected')).toBe(true)
  })
})
