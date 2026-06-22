import { describe, expect, it } from 'vitest'
import type { CollabChoiceRequest } from '../collab-ws-state'
import {
  COLLAB_NON_PENDING_CHOICE_CAP,
  upsertCollabChoiceRequest,
} from './choice-requests'

function choice(overrides: Partial<CollabChoiceRequest> = {}): CollabChoiceRequest {
  return {
    agentId: 'agent-1',
    choiceId: 'choice-1',
    questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    status: 'pending',
    timestamp: '2026-04-10T12:00:00.000Z',
    ...overrides,
  }
}

describe('upsertCollabChoiceRequest', () => {
  it('adds a pending row', () => {
    const result = upsertCollabChoiceRequest([], choice())
    expect(result).toEqual([choice()])
  })

  it('adds answered/cancelled/expired rows without a prior pending row', () => {
    const answered = choice({ status: 'answered', answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }] })
    const cancelled = choice({ choiceId: 'choice-2', status: 'cancelled' })
    const expired = choice({ choiceId: 'choice-3', status: 'expired' })

    expect(upsertCollabChoiceRequest([], answered)).toEqual([answered])
    expect(upsertCollabChoiceRequest([], cancelled)).toEqual([cancelled])
    expect(upsertCollabChoiceRequest([], expired)).toEqual([expired])
  })

  it('updates pending to answered with answers', () => {
    const pending = choice()
    const answered = choice({
      status: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })

    const result = upsertCollabChoiceRequest([pending], answered)
    expect(result).toEqual([answered])
  })

  it('does not regress terminal rows back to pending', () => {
    const answered = choice({
      status: 'answered',
      answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
    })

    const result = upsertCollabChoiceRequest([answered], choice({ status: 'pending' }))
    expect(result).toEqual([answered])
  })

  it('preserves the earliest timestamp on duplicate pending replay', () => {
    const existing = choice({ timestamp: '2026-04-10T12:05:00.000Z' })
    const replay = choice({ timestamp: '2026-04-10T12:00:00.000Z' })

    const result = upsertCollabChoiceRequest([existing], replay)
    expect(result).toEqual([choice({ timestamp: '2026-04-10T12:00:00.000Z' })])
  })

  it('preserves all pending rows while capping non-pending lifecycle rows', () => {
    const pendingRows = Array.from({ length: 5 }, (_, index) =>
      choice({ choiceId: `pending-${index}`, status: 'pending' }),
    )
    const nonPendingRows = Array.from({ length: COLLAB_NON_PENDING_CHOICE_CAP + 10 }, (_, index) =>
      choice({
        choiceId: `answered-${index}`,
        status: 'answered',
        timestamp: `2026-04-10T12:${String(index).padStart(2, '0')}:00.000Z`,
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      }),
    )

    const result = upsertCollabChoiceRequest(nonPendingRows, pendingRows[0]!, {
      maxNonPending: COLLAB_NON_PENDING_CHOICE_CAP,
    })

    expect(result.filter((row) => row.status === 'pending')).toHaveLength(1)
    expect(result.filter((row) => row.status !== 'pending')).toHaveLength(COLLAB_NON_PENDING_CHOICE_CAP)
  })
})
