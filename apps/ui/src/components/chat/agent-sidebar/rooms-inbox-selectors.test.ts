import { describe, expect, it } from 'vitest'
import type { RoomsInboxOriginInput, RoomsInboxSessionInput } from './rooms-inbox-selectors'
import { selectRoomsInboxSections } from './rooms-inbox-selectors'

const NOW = new Date('2026-08-03T12:00:00.000Z')

function session(agentId: string, overrides: Partial<RoomsInboxSessionInput> = {}): RoomsInboxSessionInput {
  return {
    identity: { originId: 'local', profileId: 'project-a', sessionAgentId: agentId },
    label: agentId,
    profileName: 'Project A',
    agentStatus: 'idle',
    activeWorkerCount: 0,
    pendingChoiceCount: 0,
    unreadCount: 0,
    contextRecoveryInProgress: false,
    updatedAt: '2026-08-03T11:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
    ...overrides,
  }
}

function origin(sessions: RoomsInboxSessionInput[], originId = 'local'): RoomsInboxOriginInput {
  return {
    originId,
    connected: true,
    sessions,
    projects: [{
      originId,
      profileId: 'project-a',
      profileName: originId === 'local' ? 'Project A' : 'Remote Project',
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-03T11:00:00.000Z',
    }],
  }
}

const ids = (entries: { identity: { sessionAgentId: string } }[]) => entries.map((entry) => entry.identity.sessionAgentId)

describe('selectRoomsInboxSections', () => {
  it('assigns eager Needs You reasons by choice, error, unread priority without duplicate sessions', () => {
    const result = selectRoomsInboxSections([origin([
      session('unread', { unreadCount: 3 }),
      session('error', { agentStatus: 'error', unreadCount: 4 }),
      session('choice', { pendingChoiceCount: 2, agentStatus: 'error', unreadCount: 9 }),
      session('working-unread', { unreadCount: 1, activeWorkerCount: 2 }),
    ])], { now: NOW })

    expect(ids(result.needsYou)).toEqual(['choice', 'error', 'unread'])
    expect(result.needsYou.map((entry) => entry.reason)).toEqual(['awaiting_choice', 'error', 'unread_result'])
    expect(ids(result.active)).toEqual(['working-unread'])
    expect(result.activeWorkerCount).toBe(2)
    expect(ids(result.recent)).toEqual([])
  })

  it('dedupes the same origin-scoped session before section assignment', () => {
    const duplicate = session('same', { pendingChoiceCount: 1 })
    const result = selectRoomsInboxSections([origin([duplicate, { ...duplicate }])], { now: NOW })

    expect(ids(result.needsYou)).toEqual(['same'])
  })

  it('orders Active by selected, compaction, worker count, activity, then stable composite identity and caps at five', () => {
    const result = selectRoomsInboxSections([origin([
      session('workers', { activeWorkerCount: 3, streamingStartedAt: 20 }),
      session('compacting', { contextRecoveryInProgress: true, streamingStartedAt: 1 }),
      session('selected', { agentStatus: 'streaming', streamingStartedAt: 0 }),
      session('newer', { agentStatus: 'streaming', streamingStartedAt: 30 }),
      session('older', { agentStatus: 'streaming', streamingStartedAt: 10 }),
      session('overflow', { agentStatus: 'streaming', streamingStartedAt: 5 }),
    ])], {
      now: NOW,
      selected: { originId: 'local', sessionAgentId: 'selected' },
    })

    expect(ids(result.active)).toEqual(['selected', 'compacting', 'workers', 'newer', 'older'])
    expect(result.activeOverflowCount).toBe(1)
  })

  it('keeps Recent within seven days, excludes higher-priority sections, and caps deterministically', () => {
    const recent = Array.from({ length: 6 }, (_, index) => session(`recent-${index}`, {
      updatedAt: new Date(NOW.getTime() - index * 3_600_000).toISOString(),
    }))
    const result = selectRoomsInboxSections([origin([
      ...recent,
      session('needs', { pendingChoiceCount: 1, updatedAt: '2026-08-03T11:30:00.000Z' }),
      session('active', { agentStatus: 'streaming', updatedAt: '2026-08-03T11:20:00.000Z' }),
      session('old', { updatedAt: '2026-07-27T11:59:59.000Z' }),
    ])], { now: NOW })

    expect(ids(result.recent)).toEqual(['recent-0', 'recent-1', 'recent-2', 'recent-3', 'recent-4'])
    expect(ids(result.recent)).not.toContain('needs')
    expect(ids(result.recent)).not.toContain('active')
    expect(ids(result.recent)).not.toContain('old')
  })

  it('preserves remote composite identity, ignores disconnected origins, and caps recently used projects', () => {
    const remoteSession = session('same-id', {
      identity: { originId: 'remote', profileId: 'project-a', sessionAgentId: 'same-id' },
      pendingChoiceCount: 1,
    })
    const localSession = session('same-id', { pendingChoiceCount: 1 })
    const projects = Array.from({ length: 6 }, (_, index) => ({
      originId: 'local',
      profileId: `project-${index}`,
      profileName: `Project ${index}`,
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: `2026-08-03T${String(11 - index).padStart(2, '0')}:00:00.000Z`,
    }))
    const result = selectRoomsInboxSections([
      { ...origin([localSession]), projects },
      origin([remoteSession], 'remote'),
      { ...origin([session('offline', { pendingChoiceCount: 1 })], 'offline'), connected: false },
    ], { now: NOW })

    expect(result.needsYou.map((entry) => entry.identity.originId)).toEqual(['local', 'remote'])
    expect(result.projectCount).toBe(7)
    expect(result.projects).toHaveLength(5)
  })
})
