import { describe, expect, it } from 'vitest'
import type { ModelCacheObservationEntry } from '@/lib/ws-state'
import { createInitialManagerWsState } from '@/lib/ws-state'
import type { ChoiceRequestEvent, ConversationMessageEvent, PlanSummaryEvent } from '@forge/protocol'
import { applyLoadedModelCacheVisualizationSetting } from '../model-cache-visualization-state'
import { handleConversationEvent } from './conversation-event-handlers'
import type { ManagerWsState } from '@/lib/ws-state'

function makeCacheObservation(id: string): ModelCacheObservationEntry {
  return {
    type: 'model_cache_observation',
    agentId: 'manager',
    id,
    timestamp: '2026-06-02T12:00:00.000Z',
    runtimeType: 'pi',
    provider: 'openai-codex',
    modelId: 'gpt-5.5',
    tokens: {
      promptInputTokens: 3000,
      cachedInputTokens: 2500,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 500,
      outputTokens: 120,
      totalTokens: 3120,
      normalization: 'raw_input_tokens_total',
    },
    classification: {
      version: 1,
      status: 'hit',
      cachedRatio: 0.8333333333333334,
      thresholdTokens: 1024,
      hitRatioThreshold: 0.8,
    },
  }
}

function makeChoice(overrides: Partial<ChoiceRequestEvent> = {}): ChoiceRequestEvent {
  return {
    type: 'choice_request',
    agentId: 'manager',
    choiceId: 'choice-1',
    questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    status: 'pending',
    timestamp: '2026-06-02T12:00:00.000Z',
    ...overrides,
  }
}

function makeMessage(id: string, text: string): ConversationMessageEvent {
  return {
    type: 'conversation_message',
    agentId: 'manager',
    id,
    role: 'assistant',
    text,
    timestamp: '2026-06-02T12:00:00.000Z',
    source: 'assistant_output',
  }
}

function makePlanSummary(id = 'summary-1'): PlanSummaryEvent {
  return {
    type: 'plan_summary',
    id,
    agentId: 'manager',
    timestamp: '2026-07-13T01:00:00.000Z',
    revision: 2,
    updatedAt: '2026-07-13T00:59:00.000Z',
    plan: [{ step: 'Finish the first plan', status: 'completed' }],
  }
}

function runHandler(
  state: ManagerWsState,
  event: Parameters<typeof handleConversationEvent>[0],
): ManagerWsState {
  let next = state
  handleConversationEvent(event, {
    state,
    updateState: (patch) => {
      next = { ...next, ...patch }
    },
  })
  return next
}

describe('handleConversationEvent conversation history merge', () => {
  it('merges bootstrap history by id without overwriting live entries', () => {
    const liveMessage = makeMessage('msg-1', 'live text')
    const state = {
      ...createInitialManagerWsState('manager'),
      messages: [liveMessage, makeMessage('msg-live-only', 'arrived during bootstrap')],
    }

    const next = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [
        makeMessage('msg-1', 'stale bootstrap text'),
        makeMessage('msg-bootstrap-only', 'from bootstrap'),
      ],
    })

    expect(next.messages.map((entry) => entry.type === 'conversation_message' ? [entry.id, entry.text] : null)).toEqual([
      ['msg-1', 'live text'],
      ['msg-bootstrap-only', 'from bootstrap'],
      ['msg-live-only', 'arrived during bootstrap'],
    ])
  })

  it('retains one durable plan summary across live and bootstrap delivery', () => {
    const liveSummary = makePlanSummary()
    const liveState = runHandler(createInitialManagerWsState('manager'), liveSummary)
    expect(liveState.messages).toEqual([liveSummary])

    const next = runHandler(liveState, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [liveSummary],
    })

    expect(next.messages.filter((entry) => entry.type === 'plan_summary')).toEqual([liveSummary])
  })
})

describe('handleConversationEvent plan snapshots', () => {
  it('does not let a delayed bootstrap snapshot replace a newer live revision', () => {
    const state = {
      ...createInitialManagerWsState('manager'),
      planSnapshots: {
        manager: {
          type: 'session_plan_snapshot' as const,
          sessionAgentId: 'manager',
          profileId: 'manager',
          revision: 3,
          updatedAt: '2026-07-12T12:00:03.000Z',
          plan: [{ step: 'Current live step', status: 'in_progress' as const }],
        },
      },
    }

    const next = runHandler(state, {
      type: 'session_plan_snapshot',
      sessionAgentId: 'manager',
      profileId: 'manager',
      revision: 2,
      updatedAt: '2026-07-12T12:00:02.000Z',
      plan: [{ step: 'Stale bootstrap step', status: 'in_progress' }],
    })

    expect(next.planSnapshots.manager.revision).toBe(3)
    expect(next.planSnapshots.manager.plan[0]?.step).toBe('Current live step')
  })
})

describe('handleConversationEvent choice requests', () => {
  it('accepts live worker-origin choices targeted at the active session', () => {
    const state = createInitialManagerWsState('manager')

    const next = runHandler(state, makeChoice({
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-worker',
    }))

    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'manager',
      choiceId: 'choice-worker',
    })
    expect(next.pendingChoiceIds.has('choice-worker')).toBe(true)
  })

  it('upserts enriched pending snapshot choices over stale history rows', () => {
    const stale = makeChoice({ choiceId: 'choice-1', questions: [{ id: 'old', question: 'Old?' }], timestamp: '2026-06-02T11:00:00.000Z' })
    const state = {
      ...createInitialManagerWsState('manager'),
      messages: [stale],
    }

    const next = runHandler(state, {
      type: 'pending_choices_snapshot',
      agentId: 'manager',
      choiceIds: ['choice-1'],
      choices: [makeChoice({
        choiceId: 'choice-1',
        questions: [{ id: 'new', question: 'New?', options: [{ id: 'b', label: 'B' }] }],
        timestamp: '2026-06-02T12:30:00.000Z',
      })],
    })

    expect(next.pendingChoiceIds.has('choice-1')).toBe(true)
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]).toMatchObject({
      type: 'choice_request',
      choiceId: 'choice-1',
      timestamp: '2026-06-02T12:30:00.000Z',
      questions: [{ id: 'new', question: 'New?', options: [{ id: 'b', label: 'B' }] }],
    })
  })

  it('keeps legacy ids-only pending snapshots without inventing choice rows', () => {
    const state = createInitialManagerWsState('manager')

    const next = runHandler(state, {
      type: 'pending_choices_snapshot',
      agentId: 'manager',
      choiceIds: ['missing-choice'],
    })

    expect(next.pendingChoiceIds.has('missing-choice')).toBe(true)
    expect(next.messages).toEqual([])
  })
})

describe('handleConversationEvent model cache observations', () => {
  it('buffers bootstrap observations until setting loads, then promotes them when enabled', () => {
    let state = createInitialManagerWsState('manager')

    state = runHandler(state, {
      type: 'conversation_history',
      agentId: 'manager',
      messages: [makeCacheObservation('cache-bootstrap')],
    })

    expect(state.modelCacheVisualizationSettingLoaded).toBe(false)
    expect(state.modelCacheObservations).toEqual([])
    expect(state.pendingModelCacheObservations.map((entry) => entry.id)).toEqual(['cache-bootstrap'])

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: true,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations.map((entry) => entry.id)).toEqual(['cache-bootstrap'])
    expect(state.pendingModelCacheObservations).toEqual([])
  })

  it('ignores live observations while visualization is disabled after setting loads', () => {
    const state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
    }

    const next = runHandler(state, makeCacheObservation('cache-live'))

    expect(next.modelCacheObservations).toEqual([])
    expect(next.pendingModelCacheObservations).toEqual([])
  })

  it('does not reveal observations that arrived while disabled after re-enable', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: false,
      modelCacheVisualizationSettingLoaded: true,
    }

    state = runHandler(state, makeCacheObservation('stale-while-disabled'))
    expect(state.modelCacheObservations).toEqual([])

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: true,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations).toEqual([])

    state = runHandler(state, makeCacheObservation('fresh-after-enable'))
    expect(state.modelCacheObservations.map((entry) => entry.id)).toEqual(['fresh-after-enable'])
  })

  it('clears stale observations when fetched setting resolves to false', () => {
    let state = {
      ...createInitialManagerWsState('manager'),
      modelCacheVisualizationEnabled: true,
      modelCacheVisualizationSettingLoaded: true,
      modelCacheObservations: [makeCacheObservation('stale-active')],
      pendingModelCacheObservations: [makeCacheObservation('stale-pending')],
    }

    state = {
      ...state,
      ...applyLoadedModelCacheVisualizationSetting({
        enabled: false,
        currentObservations: state.modelCacheObservations,
        pendingObservations: state.pendingModelCacheObservations,
      }),
    }

    expect(state.modelCacheObservations).toEqual([])
    expect(state.pendingModelCacheObservations).toEqual([])
  })
})
