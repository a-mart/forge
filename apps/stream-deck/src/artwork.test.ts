import { describe, expect, it } from 'vitest'
import { renderKey, shouldAnimateKey } from './artwork.js'
import type { ForgeActionKind, ForgeActionSettings, StreamDeckSnapshot } from './types.js'

const kinds: ForgeActionKind[] = [
  'pulse',
  'session',
  'attention',
  'workers',
  'context',
  'stats',
  'view',
  'mission',
  'control',
  'new-session',
]

describe('Stream Deck attention animation', () => {
  it('keeps all normal, running, unread, and worker states still', () => {
    const snapshot = createSnapshot({
      runningSessionCount: 1,
      activeWorkerCount: 3,
      unreadCount: 4,
    })

    for (const kind of kinds) {
      expect(shouldAnimateKey(kind, snapshot, settingsFor(kind))).toBe(false)
      expect(renderKey(kind, snapshot, settingsFor(kind), 0, true))
        .toBe(renderKey(kind, snapshot, settingsFor(kind), 17, true))
    }
  })

  it('animates only global attention and the session asking a question', () => {
    const snapshot = createSnapshot({ pendingChoiceCount: 1 })

    expect(shouldAnimateKey('pulse', snapshot, {})).toBe(true)
    expect(shouldAnimateKey('attention', snapshot, {})).toBe(true)
    expect(shouldAnimateKey('session', snapshot, { targetMode: 'slot', slot: 0 })).toBe(true)
    expect(shouldAnimateKey('workers', snapshot, {})).toBe(false)
    expect(shouldAnimateKey('view', snapshot, { view: 'terminal' })).toBe(false)
    expect(renderKey('attention', snapshot, {}, 0, true))
      .not.toBe(renderKey('attention', snapshot, {}, 1, true))
    expect(renderKey('view', snapshot, { view: 'terminal' }, 0, true))
      .toBe(renderKey('view', snapshot, { view: 'terminal' }, 1, true))
  })
})

function settingsFor(kind: ForgeActionKind): ForgeActionSettings {
  if (kind === 'session') return { targetMode: 'slot', slot: 0 }
  if (kind === 'view') return { view: 'git' }
  if (kind === 'control') return { control: 'toggle' }
  return {}
}

function createSnapshot(summaryOverrides: Partial<StreamDeckSnapshot['summary']>): StreamDeckSnapshot {
  const pendingChoiceCount = summaryOverrides.pendingChoiceCount ?? 0
  return {
    protocolVersion: 2,
    serverTime: '2026-07-26T16:00:00.000Z',
    serverVersion: 'test',
    summary: {
      profileCount: 1,
      sessionCount: 1,
      runningSessionCount: 0,
      activeWorkerCount: 0,
      pendingChoiceCount,
      unreadCount: 0,
      ...summaryOverrides,
    },
    focusSessionAgentId: 'forge',
    profiles: [{
      profileId: 'forge',
      displayName: 'Forge',
      updatedAt: '2026-07-26T16:00:00.000Z',
      sessionCount: 1,
      activeSessionCount: 1,
      unreadCount: summaryOverrides.unreadCount ?? 0,
    }],
    sessions: [{
      agentId: 'forge',
      profileId: 'forge',
      profileName: 'Forge',
      label: 'Main',
      status: summaryOverrides.runningSessionCount ? 'streaming' : 'idle',
      updatedAt: '2026-07-26T16:00:00.000Z',
      contextPercent: 42,
      workerCount: summaryOverrides.activeWorkerCount ?? 0,
      activeWorkerCount: summaryOverrides.activeWorkerCount ?? 0,
      pendingChoiceCount,
      unreadCount: summaryOverrides.unreadCount ?? 0,
      compactionCount: 0,
    }],
    stats: null,
  }
}
