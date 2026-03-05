import { describe, expect, it } from 'vitest'
import type { FeedbackState } from '@/lib/feedback-types'
import { resolveFeedbackTargetIdForKind } from '@/lib/use-feedback'

function makeState(
  targetId: string,
  kind: FeedbackState['kind'],
): FeedbackState {
  return {
    targetId,
    scope: 'message',
    kind,
    value: kind === 'comment' ? 'comment' : 'up',
    latestEventId: 'event-1',
    latestAt: '2026-03-05T00:00:00.000Z',
  }
}

describe('resolveFeedbackTargetIdForKind', () => {
  it('keeps id-first behavior when id-keyed state exists', () => {
    const states = new Map<string, FeedbackState>()
    states.set('msg-entry-1', makeState('msg-entry-1', 'vote'))
    states.set('2026-03-05T00:00:00.000Z', makeState('2026-03-05T00:00:00.000Z', 'vote'))

    expect(
      resolveFeedbackTargetIdForKind(
        states,
        'vote',
        'msg-entry-1',
        '2026-03-05T00:00:00.000Z',
      ),
    ).toBe('msg-entry-1')
  })

  it('falls back to legacy timestamp id when only legacy vote exists', () => {
    const states = new Map<string, FeedbackState>()
    states.set('2026-03-05T00:00:00.000Z', makeState('2026-03-05T00:00:00.000Z', 'vote'))

    expect(
      resolveFeedbackTargetIdForKind(
        states,
        'vote',
        'msg-entry-1',
        '2026-03-05T00:00:00.000Z',
      ),
    ).toBe('2026-03-05T00:00:00.000Z')
  })

  it('resolves kind-specific fallback keys to avoid cross-kind collisions', () => {
    const states = new Map<string, FeedbackState>()
    states.set('2026-03-05T00:00:00.000Z', makeState('2026-03-05T00:00:00.000Z', 'vote'))
    states.set(
      '2026-03-05T00:00:00.000Z:comment',
      makeState('2026-03-05T00:00:00.000Z', 'comment'),
    )

    expect(
      resolveFeedbackTargetIdForKind(
        states,
        'comment',
        'msg-entry-1',
        '2026-03-05T00:00:00.000Z',
      ),
    ).toBe('2026-03-05T00:00:00.000Z')

    expect(
      resolveFeedbackTargetIdForKind(states, 'vote', 'msg-entry-2', '2026-03-06T00:00:00.000Z'),
    ).toBe('msg-entry-2')
  })
})
