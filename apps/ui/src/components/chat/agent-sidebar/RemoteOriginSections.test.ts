/** @vitest-environment jsdom */

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import type { ProfileTreeRow, SessionRow } from '@/lib/agent-hierarchy'
import { originRegistry, type OriginId } from '@/lib/origin-store'
import { RemoteOriginSections } from './RemoteOriginSections'
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

  it('drops a dedicated Cortex profile row', () => {
    const rows = [
      makeRow(
        makeProfile({ profileId: 'cortex', displayName: 'Cortex' }),
        [makeSession(makeAgent({ agentId: 'cortex', profileId: 'cortex' }))],
      ),
    ]

    expect(getRemoteVisibleProfileRows(rows)).toEqual([])
  })

  it('keeps a mixed normal profile when the representative session is normal and filters only Cortex sessions', () => {
    const normal = makeSession(makeAgent({ agentId: 'normal-1', sessionLabel: 'Normal Session' }), true)
    const review = makeSession(makeAgent({ agentId: 'review-1', sessionLabel: 'Cortex Review', sessionPurpose: 'cortex_review' }), false)
    const [row] = getRemoteVisibleProfileRows([makeRow(makeProfile({ defaultSessionAgentId: 'normal-1' }), [normal, review])])

    expect(row?.sessions.map((session) => session.sessionAgent.agentId)).toEqual(['normal-1'])
  })

  it('keeps a mixed normal profile when the representative/default session is Cortex and preserves normal sessions', () => {
    const review = makeSession(makeAgent({ agentId: 'review-1', sessionLabel: 'Cortex Review', sessionPurpose: 'cortex_review' }), true)
    const normal = makeSession(makeAgent({ agentId: 'normal-1', sessionLabel: 'Normal Session' }), false)
    const [row] = getRemoteVisibleProfileRows([makeRow(makeProfile({ defaultSessionAgentId: 'review-1' }), [review, normal])])

    expect(row?.sessions.map((session) => session.sessionAgent.agentId)).toEqual(['normal-1'])
  })

  it('filters Cortex capture-check sessions from mixed normal profile rows', () => {
    const normal = makeSession(makeAgent({ agentId: 'normal-1', sessionLabel: 'Normal Session' }), true)
    const captureCheck = makeSession(makeAgent({ agentId: 'capture-1', sessionLabel: 'Capture check', sessionPurpose: 'capture_check' }), false)
    const [row] = getRemoteVisibleProfileRows([makeRow(makeProfile({ defaultSessionAgentId: 'normal-1' }), [normal, captureCheck])])

    expect(row?.sessions.map((session) => session.sessionAgent.agentId)).toEqual(['normal-1'])
  })
})

describe('RemoteOriginSections', () => {
  it('renders connected remote project rows, hides remote Cortex rows/sessions, and selects by origin', () => {
    const originId = 'remote:test' as OriginId
    const onSelectAgent = vi.fn()
    const normalSession = makeAgent({
      agentId: 'normal-1',
      profileId: 'project-1',
      sessionLabel: 'Normal Session',
      updatedAt: '2026-01-03T00:00:00.000Z',
    })
    const reviewSession = makeAgent({
      agentId: 'review-1',
      profileId: 'project-1',
      sessionLabel: 'Cortex Review',
      sessionPurpose: 'cortex_review',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    const cortexSession = makeAgent({
      agentId: 'cortex',
      profileId: 'cortex',
      sessionLabel: 'Cortex Root',
      archetypeId: 'cortex',
    })
    const profiles = [
      makeProfile({ profileId: 'project-1', displayName: 'Remote Project', defaultSessionAgentId: 'normal-1' }),
      makeProfile({ profileId: 'cortex', displayName: 'Cortex', defaultSessionAgentId: 'cortex' }),
    ]
    const agents = [normalSession, reviewSession, cortexSession]
    const store = originRegistry.createOrigin({ originId, wsUrl: 'ws://remote.example/ws', offline: true })
    store.ingest({ type: 'snapshot', state: { agents, profiles } })
    store.patchMeta({ connectionStatus: 'connected', authState: 'authenticated', instanceName: 'Remote Forge' })

    root = createRoot(container)
    flushSync(() => {
      root?.render(createElement(RemoteOriginSections, {
        originIds: [originId],
        selectedAgentId: null,
        activeOriginId: originId,
        onSelectAgent,
      }))
    })

    expect(container.textContent).toContain('Remote Project')
    expect(container.textContent).toContain('Normal Session')
    expect(container.textContent).not.toContain('Cortex Review')
    expect(container.textContent).not.toContain('Cortex Root')

    const button = Array.from(container.querySelectorAll('button'))
      .find((candidate) => candidate.textContent?.includes('Normal Session'))
    expect(button).toBeTruthy()
    button?.click()

    expect(onSelectAgent).toHaveBeenCalledWith(originId, 'normal-1')
  })
})
