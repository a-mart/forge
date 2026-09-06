import { describe, expect, it } from 'vitest'
import type { SessionAttention, SessionAttentionReason } from '@forge/protocol'
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

function attention(
  sessionAgentId: string,
  reason: SessionAttentionReason = 'work_settled',
  raisedAt = '2026-08-03T11:30:00.000Z',
): SessionAttention {
  return {
    attentionId: `attention-${sessionAgentId}`,
    sessionAgentId,
    profileId: 'project-a',
    reason,
    raisedAt,
  }
}

function origin(
  sessions: RoomsInboxSessionInput[],
  originId = 'local',
  attentions: SessionAttention[] = [],
): RoomsInboxOriginInput {
  return {
    originId,
    connected: true,
    attentionAvailable: true,
    attentions,
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
  it('uses server attention only and never infers Needs You from unread, choices, or errors', () => {
    const sessions = [
      session('unread', { unreadCount: 3 }),
      session('error', { agentStatus: 'error', unreadCount: 4 }),
      session('choice', { pendingChoiceCount: 2, agentStatus: 'error', unreadCount: 9 }),
      session('settled'),
      session('working-unread', { unreadCount: 1, activeWorkerCount: 2 }),
    ]
    const result = selectRoomsInboxSections([
      origin(sessions, 'local', [attention('settled', 'plan_completed')]),
    ], { now: NOW })

    expect(ids(result.needsYou)).toEqual(['settled'])
    expect(result.needsYou[0]).toMatchObject({
      reason: 'plan_completed',
      attentionId: 'attention-settled',
      timestamp: '2026-08-03T11:30:00.000Z',
    })
    expect(ids(result.active)).toEqual(['working-unread'])
    expect(result.activeWorkerCount).toBe(2)
  })

  it('orders server attention by raisedAt and dedupes origin-scoped sessions', () => {
    const duplicate = session('same')
    const result = selectRoomsInboxSections([origin(
      [duplicate, { ...duplicate }, session('older')],
      'local',
      [
        attention('older', 'work_settled', '2026-08-03T10:00:00.000Z'),
        attention('same', 'awaiting_review', '2026-08-03T11:00:00.000Z'),
      ],
    )], { now: NOW })

    expect(ids(result.needsYou)).toEqual(['same', 'older'])
    expect(result.needsYou.map((entry) => entry.reason)).toEqual(['awaiting_review', 'work_settled'])
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

  it('keeps Recent within seven days, excludes higher-priority sections, and reports overflow past five', () => {
    const recent = Array.from({ length: 6 }, (_, index) => session(`recent-${index}`, {
      updatedAt: new Date(NOW.getTime() - index * 3_600_000).toISOString(),
    }))
    const sessions = [
      ...recent,
      session('needs', { updatedAt: '2026-08-03T11:30:00.000Z' }),
      session('active', { agentStatus: 'streaming', updatedAt: '2026-08-03T11:20:00.000Z' }),
      session('old', { updatedAt: '2026-07-27T11:59:59.000Z' }),
    ]
    const result = selectRoomsInboxSections([
      origin(sessions, 'local', [attention('needs')]),
    ], { now: NOW })

    expect(ids(result.recent)).toEqual(['recent-0', 'recent-1', 'recent-2', 'recent-3', 'recent-4', 'recent-5'])
    expect(result.recentOverflowCount).toBe(1)
    expect(ids(result.recent)).not.toContain('needs')
    expect(ids(result.recent)).not.toContain('active')
    expect(ids(result.recent)).not.toContain('old')
  })

  it('hides locally muted sessions from Needs You without dismissing server attention or remote rooms', () => {
    const remoteMutedTwin = session('muted-local', {
      identity: { originId: 'remote', profileId: 'project-a', sessionAgentId: 'muted-local' },
    })
    const result = selectRoomsInboxSections([
      origin([
        session('muted-local'),
        session('visible'),
      ], 'local', [
        attention('muted-local'),
        attention('visible', 'awaiting_review'),
      ]),
      origin([remoteMutedTwin], 'remote', [attention('muted-local', 'decision_waiting')]),
    ], {
      now: NOW,
      mutedSessionIds: new Set(['muted-local']),
    })

    expect(result.needsYou.map((entry) => `${entry.identity.originId}::${entry.identity.sessionAgentId}`))
      .toEqual(['remote::muted-local', 'local::visible'])
    expect(ids(result.recent)).toContain('muted-local')
  })

  it('keeps colliding agent IDs origin-scoped and hides attention from disconnected or unsupported origins', () => {
    const remoteSession = session('same-id', {
      identity: { originId: 'remote', profileId: 'project-a', sessionAgentId: 'same-id' },
    })
    const localSession = session('same-id')
    const projects = Array.from({ length: 6 }, (_, index) => ({
      originId: 'local',
      profileId: `project-${index}`,
      profileName: `Project ${index}`,
      createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: `2026-08-03T${String(11 - index).padStart(2, '0')}:00:00.000Z`,
    }))
    const result = selectRoomsInboxSections([
      { ...origin([localSession], 'local', [attention('same-id')]), projects },
      origin([remoteSession], 'remote', [attention('same-id', 'decision_waiting')]),
      { ...origin([session('offline')], 'offline', [attention('offline')]), connected: false },
      { ...origin([session('unsupported')], 'unsupported', [attention('unsupported')]), attentionAvailable: false },
    ], { now: NOW })

    expect(result.needsYou.map((entry) => entry.identity.originId)).toEqual(['local', 'remote'])
    expect(result.projectCount).toBe(8)
    expect(result.projects).toHaveLength(5)
    expect(ids(result.needsYou)).not.toContain('offline')
    expect(ids(result.needsYou)).not.toContain('unsupported')
  })
})
