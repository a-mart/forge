/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import { originRegistry, type OriginId } from '@/lib/origin-store'
import { RemoteOriginSections, RemoteProfileRow } from './RemoteOriginSections'
import { getRemoteVisibleProfileRows, isRemoteCortexSession } from './RemoteOriginSections.utils'

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
  originRegistry.destroyAll()
})

function makeAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'session-1',
    managerId: 'session-1',
    displayName: 'Session',
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    sessionFile: '/tmp/session-1.jsonl',
    profileId: 'project-1',
    ...overrides,
  }
}

function makeProfile(overrides: Partial<ManagerProfile> = {}): ManagerProfile {
  return {
    profileId: 'project-1',
    displayName: 'Project 1',
    defaultSessionAgentId: 'session-1',
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'high' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeSession(agent: AgentDescriptor, isDefault = true): SessionRow {
  return { sessionAgent: agent, workers: [], isDefault }
}

function makeRow(profile: ManagerProfile, sessions: SessionRow[]): ProfileTreeRow {
  return { profile, sessions }
}

describe('remote Cortex filtering', () => {
  it('identifies Cortex sessions without treating arbitrary system profiles as Cortex', () => {
    expect(isRemoteCortexSession(makeAgent({ profileId: 'cortex' }))).toBe(true)
    expect(isRemoteCortexSession(makeAgent({ archetypeId: 'cortex' }))).toBe(true)
    expect(isRemoteCortexSession(makeAgent({ sessionPurpose: 'cortex_review' }))).toBe(true)
    expect(isRemoteCortexSession(makeAgent({ sessionPurpose: 'capture_check' }))).toBe(true)
    expect(isRemoteCortexSession(makeAgent({ profileId: 'ops', archetypeId: 'manager' }))).toBe(false)
  })

  it('drops remote Cortex/system rows but keeps empty user rows', () => {
    const visibleRows = getRemoteVisibleProfileRows([
      makeRow(makeProfile({ profileId: 'empty', displayName: 'Empty Project' }), []),
      makeRow(
        makeProfile({ profileId: 'capture-only', displayName: 'Capture Only' }),
        [makeSession(makeAgent({ profileId: 'capture-only', sessionPurpose: 'capture_check' }))],
      ),
      makeRow(makeProfile({ profileId: 'cortex', displayName: 'Cortex' }), []),
      makeRow(makeProfile({ profileId: 'system', displayName: 'System', profileType: 'system' }), []),
    ])

    expect(visibleRows.map((row) => row.profile.profileId)).toEqual(['empty', 'capture-only'])
    expect(visibleRows.map((row) => row.sessions)).toEqual([[], []])
  })

  it('filters only Cortex sessions from a mixed normal profile', () => {
    const normal = makeSession(makeAgent({ agentId: 'normal-1', sessionLabel: 'Normal Session' }), true)
    const review = makeSession(makeAgent({ agentId: 'review-1', sessionPurpose: 'cortex_review' }), false)
    const capture = makeSession(makeAgent({ agentId: 'capture-1', sessionPurpose: 'capture_check' }), false)
    const [row] = getRemoteVisibleProfileRows([
      makeRow(makeProfile({ defaultSessionAgentId: 'normal-1' }), [normal, review, capture]),
    ])

    expect(row?.sessions.map((session) => session.sessionAgent.agentId)).toEqual(['normal-1'])
  })
})

describe('remote row/status rendering without nested DnD', () => {
  it('renders a remote row with globe styling, filters Cortex sessions, and selects its session', () => {
    const onSelectAgent = vi.fn()
    const [treeRow] = getRemoteVisibleProfileRows([
      makeRow(
        makeProfile({ profileId: 'project-1', displayName: 'Remote Project', defaultSessionAgentId: 'normal-1' }),
        [
          makeSession(makeAgent({ agentId: 'normal-1', sessionLabel: 'Normal Session' })),
          makeSession(makeAgent({ agentId: 'review-1', sessionLabel: 'Cortex Review', sessionPurpose: 'cortex_review' }), false),
        ],
      ),
    ])

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(RemoteProfileRow, {
        originId: 'remote:test',
        treeRow: treeRow!,
        selectedAgentId: null,
        isActiveOrigin: true,
        instanceName: 'Remote Forge',
        onSelectAgent,
      }))
    })

    expect(container.textContent).toContain('Remote Project')
    expect(container.textContent).toContain('Normal Session')
    expect(container.textContent).not.toContain('Cortex Review')
    expect(container.querySelector('[data-testid="remote-profile-row-remote:test::project-1"]')).not.toBeNull()
    const sessionButton = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Normal Session'))
    sessionButton?.click()
    expect(onSelectAgent).toHaveBeenCalledWith('remote:test', 'normal-1')
  })

  it('puts keyboard/pointer DnD semantics on the actual, instance-identified activator', () => {
    const pointerDown = vi.fn()
    const keyDown = vi.fn()
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(RemoteProfileRow, {
        originId: 'remote:test',
        treeRow: makeRow(makeProfile({ displayName: 'Empty Remote Project' }), []),
        selectedAgentId: null,
        isActiveOrigin: false,
        instanceName: 'Remote East',
        dragHandleListeners: { onPointerDown: pointerDown, onKeyDown: keyDown },
        dragHandleAttributes: {
          role: 'button',
          tabIndex: 0,
          'aria-disabled': false,
          'aria-pressed': undefined,
          'aria-roledescription': 'sortable',
          'aria-describedby': 'dnd-description',
        },
        onSelectAgent: vi.fn(),
      }))
    })

    const projectButton = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Empty Remote Project')) as HTMLButtonElement
    expect(projectButton.style.touchAction).toBe('none')
    expect(projectButton.className).toContain('cursor-grab')
    expect(projectButton.getAttribute('aria-roledescription')).toBe('sortable')
    expect(projectButton.getAttribute('aria-describedby')).toBe('dnd-description')
    expect(projectButton.getAttribute('aria-label')).toBe(
      'Open or drag remote project Empty Remote Project on Remote East',
    )
    projectButton.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(keyDown).toHaveBeenCalledOnce()
  })

  it('updates status and unread from the owning origin row subscription', () => {
    const originId = 'remote:live' as OriginId
    const store = originRegistry.createOrigin({ originId, wsUrl: 'ws://live.test', offline: true })
    const session = makeAgent({ agentId: 'live-session', sessionLabel: 'Live Session' })
    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(RemoteProfileRow, {
        originId,
        treeRow: makeRow(makeProfile(), [makeSession(session)]),
        selectedAgentId: null,
        isActiveOrigin: false,
        onSelectAgent: vi.fn(),
      }))
    })

    expect(container.querySelector('[aria-label="Manager streaming"]')).toBeNull()
    flushSync(() => {
      store.ingest({
        type: 'snapshot',
        state: {
          statuses: { 'live-session': { status: 'streaming', pendingCount: 1 } },
          unreadCounts: { 'live-session': 4 },
        },
      })
    })

    expect(container.querySelector('[aria-label="Manager streaming"]')).not.toBeNull()
    expect(container.textContent).toContain('4')
  })

  it('distinguishes duplicate remote project names by instance in accessible labels', () => {
    for (const [originId, instanceName] of [['remote:east', 'Forge East'], ['remote:west', 'Forge West']] as const) {
      const store = originRegistry.createOrigin({
        originId,
        wsUrl: `ws://${originId.replace(':', '-')}.test`,
        offline: true,
      })
      store.patchMeta({ connectionStatus: 'connected', instanceName })
    }
    const duplicateRow = makeRow(makeProfile({ displayName: 'Shared Project' }), [])

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement('div', null,
        createElement(RemoteProfileRow, {
          originId: 'remote:east',
          treeRow: duplicateRow,
          selectedAgentId: null,
          isActiveOrigin: false,
          onSelectAgent: vi.fn(),
        }),
        createElement(RemoteProfileRow, {
          originId: 'remote:west',
          treeRow: duplicateRow,
          selectedAgentId: null,
          isActiveOrigin: false,
          onSelectAgent: vi.fn(),
        }),
      ))
    })

    const labels = Array.from(container.querySelectorAll('button'))
      .map((button) => button.getAttribute('aria-label'))
      .filter((label) => label?.startsWith('Open remote'))
    expect(labels).toEqual([
      'Open remote project Shared Project on Forge East',
      'Open remote project Shared Project on Forge West',
    ])
  })

  it('renders connected-empty status without restoring the removed green dot', () => {
    const originId = 'remote:test' as OriginId
    const store = originRegistry.createOrigin({ originId, wsUrl: 'ws://remote.example/ws', offline: true })
    store.patchMeta({ connectionStatus: 'connected', authState: 'authenticated', instanceName: 'Remote Forge' })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(RemoteOriginSections, { originIds: [originId] }))
    })

    expect(container.textContent).toContain('No remote projects yet.')
    expect(container.querySelector('[aria-label="Connected"]')).toBeNull()
  })
})
