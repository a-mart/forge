import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootstrapBuffer, BOOTSTRAP_FLUSH_TIMEOUT_MS } from './bootstrap-buffer'
import { handleConversationEvent } from './event-handlers/conversation-event-handlers'
import type { ManagerWsState } from '../ws-state'
import { createInitialManagerWsState } from '../ws-state'
import type { ServerEvent } from '@forge/protocol'

function makeState(overrides: Partial<ManagerWsState> = {}): ManagerWsState {
  return { ...createInitialManagerWsState('session-a'), ...overrides }
}

describe('BootstrapBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(stateOverrides: Partial<ManagerWsState> = {}) {
    let state = makeState(stateOverrides)
    const patches: Partial<ManagerWsState>[] = []
    const getState = () => state
    const updateState = (patch: Partial<ManagerWsState>) => {
      state = { ...state, ...patch }
      patches.push(patch)
    }

    const buffer = new BootstrapBuffer({
      getState,
      updateState,
      applyConversationEvent: handleConversationEvent,
    })

    return { buffer, getState, updateState, patches, setState: (s: ManagerWsState) => { state = s } }
  }

  // ---------------------------------------------------------------------------
  // Basic lifecycle
  // ---------------------------------------------------------------------------

  it('starts inactive', () => {
    const { buffer } = setup()
    expect(buffer.active).toBe(false)
  })

  it('becomes active after begin()', () => {
    const { buffer } = setup()
    buffer.begin('session-b')
    expect(buffer.active).toBe(true)
  })

  it('becomes inactive after flush()', () => {
    const { buffer } = setup()
    buffer.begin('session-b')
    buffer.flush()
    expect(buffer.active).toBe(false)
  })

  it('becomes inactive after clear()', () => {
    const { buffer } = setup()
    buffer.begin('session-b')
    buffer.clear()
    expect(buffer.active).toBe(false)
  })

  it('flush() is a no-op when inactive', () => {
    const { buffer, patches } = setup()
    buffer.flush()
    expect(patches).toHaveLength(0)
  })

  it('clear() is a no-op when inactive', () => {
    const { buffer, patches } = setup()
    buffer.clear()
    expect(patches).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // Coalescing / effective state
  // ---------------------------------------------------------------------------

  it('coalesces bootstrap events including the current plan snapshot', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    const events: ServerEvent[] = [
      { type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' },
      {
        type: 'conversation_history',
        agentId: 'session-b',
        messages: [
          { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'hi', timestamp: new Date().toISOString(), source: 'user_input' },
        ],
      },
      { type: 'pending_choices_snapshot', agentId: 'session-b', choiceIds: ['choice-1'] },
      {
        type: 'session_plan_snapshot',
        sessionAgentId: 'session-b',
        profileId: 'profile-1',
        revision: 3,
        updatedAt: new Date().toISOString(),
        plan: [{ step: 'Implement feature', status: 'in_progress' }],
      },
      {
        type: 'session_goal_snapshot',
        sessionAgentId: 'session-b',
        profileId: 'profile-1',
        revision: 2,
        measuredAt: new Date().toISOString(),
        goal: {
          id: 'goal-1',
          objective: 'Finish the feature',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          activeElapsedMs: 1_000,
          turnCount: 2,
          usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
          usageCoverage: 'complete',
        },
      },
      {
        type: 'secure_session_snapshot',
        sessionAgentId: 'session-b',
        profileId: 'profile-1',
        principalKind: 'manager',
        ownerManagerAgentId: null,
        workerAssignmentId: null,
        revision: 4,
        executionMode: 'secure',
        environmentStatus: 'ready',
        leases: [],
        pendingRequests: [],
        updatedAt: new Date().toISOString(),
      },
      { type: 'unread_counts_snapshot', counts: { 'session-c': 3 } },
    ]

    for (const event of events) {
      buffer.handleEvent(event)
    }

    // Single state update on terminal signal flush
    expect(patches).toHaveLength(1)
    expect(patches[0].subscribedAgentId).toBe('session-b')
    expect(patches[0].messages).toHaveLength(1)
    expect(patches[0].pendingChoiceIds?.has('choice-1')).toBe(true)
    expect(patches[0].planSnapshots?.['session-b']?.plan).toHaveLength(1)
    expect(patches[0].goalSnapshots?.['session-b']?.goal?.objective).toBe('Finish the feature')
    expect(patches[0].secureSessionSnapshots?.['session-b']?.revision).toBe(4)
    expect(Object.keys(patches[0].secureSessionSnapshots ?? {})).toEqual(['session-b'])
    expect(patches[0].unreadCounts).toEqual({ 'session-c': 3 })
  })

  it('applies a newer attention update after its authoritative snapshot even when the update arrives first', () => {
    const { buffer, patches, getState } = setup({
      sessionAttentionRevision: -1,
      sessionAttentions: {},
    })
    buffer.begin('session-b')

    buffer.handleEvent({
      type: 'session_attention_update',
      revision: 5,
      changes: [{
        sessionAgentId: 'session-c',
        attention: {
          attentionId: 'attention-c',
          sessionAgentId: 'session-c',
          profileId: 'profile-1',
          reason: 'awaiting_review',
          raisedAt: '2026-08-03T12:05:00.000Z',
        },
      }],
    })
    buffer.handleEvent({
      type: 'session_attention_snapshot',
      revision: 4,
      attentions: [{
        attentionId: 'attention-b',
        sessionAgentId: 'session-b',
        profileId: 'profile-1',
        reason: 'work_settled',
        raisedAt: '2026-08-03T12:00:00.000Z',
      }],
    })
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} })

    expect(patches).toHaveLength(1)
    expect(getState().sessionAttentionRevision).toBe(5)
    expect(Object.keys(getState().sessionAttentions).sort()).toEqual(['session-b', 'session-c'])
  })

  it('keeps only the newest actionable secure requests during bootstrap replay', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')
    const request = {
      requestId: 'request-1',
      secretId: 'secret-1',
      displayAlias: 'deployment',
      requestedLeaseKind: 'task' as const,
      requestedExposures: [{
        deliveryKind: 'environment' as const,
        targetName: 'DEPLOYMENT_PASSWORD',
      }],
      purposeSummary: 'Deploy the application',
      requestedByAgentId: 'worker-1',
      requestedByDisplayName: 'Deployment worker',
      workerAssignmentId: null,
      createdAt: '2026-07-23T12:00:04.000Z',
      expiresAt: null,
    }

    buffer.handleEvent({
      type: 'ready',
      serverTime: '2026-07-23T12:00:03.000Z',
      subscribedAgentId: 'session-b',
    })
    buffer.handleEvent({
      type: 'secure_session_snapshot',
      sessionAgentId: 'session-b',
      profileId: 'profile-1',
      principalKind: 'manager',
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      revision: 4,
      executionMode: 'secure',
      environmentStatus: 'ready',
      leases: [],
      pendingRequests: [request],
      updatedAt: '2026-07-23T12:00:04.000Z',
    })
    buffer.handleEvent({
      type: 'secure_session_snapshot',
      sessionAgentId: 'session-b',
      profileId: 'profile-1',
      principalKind: 'manager',
      ownerManagerAgentId: null,
      workerAssignmentId: null,
      revision: 5,
      executionMode: 'secure',
      environmentStatus: 'ready',
      leases: [],
      pendingRequests: [],
      updatedAt: '2026-07-23T12:00:05.000Z',
    })
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} })

    expect(patches).toHaveLength(1)
    expect(patches[0].secureSessionSnapshots?.['session-b']).toMatchObject({
      revision: 5,
      pendingRequests: [],
    })
  })

  it('effective state accumulates across multiple coalescible events', () => {
    const { buffer, patches, getState } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    buffer.handleEvent({
      type: 'conversation_history',
      agentId: 'session-b',
      messages: [
        { type: 'conversation_message', agentId: 'session-b', role: 'user', text: 'msg1', timestamp: new Date().toISOString(), source: 'user_input' },
      ],
    } as ServerEvent)

    // No updates yet
    expect(patches).toHaveLength(0)

    // Flush via terminal signal
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    // state reflects history
    expect(getState().messages).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Wrong-target ignores
  // ---------------------------------------------------------------------------

  it('ignores ready event targeting wrong agent', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    // Flush happened, but ready for wrong target was dropped
    expect(patches).toHaveLength(1)
    expect(patches[0].subscribedAgentId).toBeUndefined()
  })

  it('ignores conversation_history for wrong agent', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({
      type: 'conversation_history',
      agentId: 'wrong-session',
      messages: [
        { type: 'conversation_message', agentId: 'wrong-session', role: 'user', text: 'nope', timestamp: new Date().toISOString(), source: 'user_input' },
      ],
    } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    // messages should not include wrong-target history
    expect(patches[0].messages).toBeUndefined()
  })

  it('ignores pending_choices_snapshot for wrong agent', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'pending_choices_snapshot', agentId: 'wrong-session', choiceIds: ['stale'] } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    expect(patches[0].pendingChoiceIds).toBeUndefined()
  })

  it('ignores plan snapshots for wrong session during bootstrap', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({
      type: 'session_plan_snapshot',
      sessionAgentId: 'wrong-session',
      profileId: 'profile-1',
      revision: 1,
      updatedAt: new Date().toISOString(),
      plan: [],
    } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    expect(patches[0].planSnapshots).toBeUndefined()
  })

  it('ignores goal snapshots for the wrong session during bootstrap', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({
      type: 'session_goal_snapshot',
      sessionAgentId: 'wrong-session',
      profileId: 'profile-1',
      revision: 1,
      measuredAt: new Date().toISOString(),
      goal: null,
    } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    expect(patches[0].goalSnapshots).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // Unread terminal flush
  // ---------------------------------------------------------------------------

  it('flushes immediately on unread_counts_snapshot (terminal signal)', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    expect(patches).toHaveLength(0)

    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: { x: 1 } } as ServerEvent)
    expect(patches).toHaveLength(1)
    expect(buffer.active).toBe(false)
  })

  it('flushes when unread_counts_snapshot arrives without other events', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: { 'session-c': 5 } } as ServerEvent)

    expect(patches).toHaveLength(1)
    expect(patches[0].unreadCounts).toEqual({ 'session-c': 5 })
    expect(buffer.active).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Timeout behavior
  // ---------------------------------------------------------------------------

  it('flushes via inactivity timeout when terminal signal is missing', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    buffer.handleEvent({
      type: 'conversation_history',
      agentId: 'session-b',
      messages: [],
    } as ServerEvent)

    expect(patches).toHaveLength(0)

    vi.advanceTimersByTime(BOOTSTRAP_FLUSH_TIMEOUT_MS + 50)

    expect(patches).toHaveLength(1)
    expect(buffer.active).toBe(false)
  })

  it('resets inactivity timeout on each accepted buffered event', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    // Advance 80ms (close to 100ms timeout)
    vi.advanceTimersByTime(80)
    expect(patches).toHaveLength(0)

    // Another event resets the timer
    buffer.handleEvent({
      type: 'conversation_history',
      agentId: 'session-b',
      messages: [],
    } as ServerEvent)

    // Advance another 80ms — would have been 160ms total but timer reset
    vi.advanceTimersByTime(80)
    expect(patches).toHaveLength(0) // still active

    // Pass the final 100ms from last event
    vi.advanceTimersByTime(30)
    expect(patches).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // Clear
  // ---------------------------------------------------------------------------

  it('clear() cancels pending timer', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    buffer.clear()

    vi.advanceTimersByTime(BOOTSTRAP_FLUSH_TIMEOUT_MS + 50)

    // No flush because buffer was cleared
    expect(patches).toHaveLength(0)
  })

  it('clear() does not emit state update', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    buffer.clear()

    expect(patches).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // begin() while active
  // ---------------------------------------------------------------------------

  it('begin() while active clears previous buffer without flushing', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-a')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-a' } as ServerEvent)

    // Re-begin for different target — old buffer discarded
    buffer.begin('session-b')
    expect(buffer.active).toBe(true)
    expect(patches).toHaveLength(0) // no flush from previous

    // Events for new target should work
    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    buffer.handleEvent({ type: 'unread_counts_snapshot', counts: {} } as ServerEvent)

    expect(patches).toHaveLength(1)
    expect(patches[0].subscribedAgentId).toBe('session-b')
  })

  // ---------------------------------------------------------------------------
  // Force-flush pass-through for target conversation events
  // ---------------------------------------------------------------------------

  it('force-flushes on conversation_message for target, returns false for pass-through', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)
    expect(patches).toHaveLength(0)

    const liveEvent: ServerEvent = {
      type: 'conversation_message',
      agentId: 'session-b',
      role: 'assistant',
      text: 'live',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    } as ServerEvent

    const consumed = buffer.handleEvent(liveEvent)

    // Force-flush happened
    expect(patches).toHaveLength(1)
    expect(patches[0].subscribedAgentId).toBe('session-b')
    // Event was NOT consumed — caller should process it
    expect(consumed).toBe(false)
    expect(buffer.active).toBe(false)
  })

  it('force-flushes on agent_tool_call for target', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'agent_tool_call',
      agentId: 'session-b',
      actorAgentId: 'session-b',
      kind: 'tool_execution_start',
      text: 'running some_tool',
      toolName: 'some_tool',
      status: 'running',
      timestamp: new Date().toISOString(),
    } as unknown as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(1)
    expect(buffer.active).toBe(false)
  })

  it('force-flushes on agent_status for target session', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'agent_status',
      agentId: 'session-b',
      status: 'streaming',
      pendingCount: 1,
    } as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(1)
    expect(buffer.active).toBe(false)
  })

  it('force-flushes on agent_status for worker of target (managerId match)', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'agent_status',
      agentId: 'worker-1',
      managerId: 'session-b',
      status: 'streaming',
      pendingCount: 1,
    } as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(1)
    expect(buffer.active).toBe(false)
  })

  it('force-flushes on choice_request for target', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'choice_request',
      agentId: 'session-b',
      choiceId: 'c-1',
      title: 'Pick',
      questions: [],
      choices: [],
      status: 'pending',
      timestamp: new Date().toISOString(),
    } as unknown as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(1)
  })

  it('force-flushes on worker-origin choice_request targeted at the session', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'choice_request',
      agentId: 'worker-1',
      sessionAgentId: 'session-b',
      choiceId: 'c-1',
      questions: [],
      status: 'pending',
      timestamp: new Date().toISOString(),
    } as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------
  // No flush for unrelated events
  // ---------------------------------------------------------------------------

  it('does not force-flush on conversation_message for different agent', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'conversation_message',
      agentId: 'other-session',
      role: 'assistant',
      text: 'unrelated',
      timestamp: new Date().toISOString(),
      source: 'speak_to_user',
    } as ServerEvent)

    // Not consumed, not force-flushed
    expect(consumed).toBe(false)
    expect(patches).toHaveLength(0)
    expect(buffer.active).toBe(true)
  })

  it('does not force-flush on agent_status for unrelated agent', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    buffer.handleEvent({ type: 'ready', serverTime: new Date().toISOString(), subscribedAgentId: 'session-b' } as ServerEvent)

    const consumed = buffer.handleEvent({
      type: 'agent_status',
      agentId: 'unrelated-worker',
      managerId: 'other-manager',
      status: 'streaming',
      pendingCount: 1,
    } as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(0)
    expect(buffer.active).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Non-coalescible pass-through
  // ---------------------------------------------------------------------------

  it('returns false for non-coalescible, non-flush-triggering events', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    const consumed = buffer.handleEvent({
      type: 'agents_snapshot',
      agents: [],
    } as unknown as ServerEvent)

    expect(consumed).toBe(false)
    expect(patches).toHaveLength(0)
    expect(buffer.active).toBe(true)
  })

  it('returns false when buffer is inactive', () => {
    const { buffer } = setup()

    const consumed = buffer.handleEvent({
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'x',
    } as ServerEvent)

    expect(consumed).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // handleEvent returns true for consumed coalescible events
  // ---------------------------------------------------------------------------

  it('returns true for coalescible events that are consumed', () => {
    const { buffer } = setup()
    buffer.begin('session-b')

    const consumed = buffer.handleEvent({
      type: 'ready',
      serverTime: new Date().toISOString(),
      subscribedAgentId: 'session-b',
    } as ServerEvent)

    expect(consumed).toBe(true)
  })

  it('returns true for coalescible event even when target does not match (still consumed)', () => {
    const { buffer } = setup()
    buffer.begin('session-b')

    // A coalescible event for wrong target is still consumed (dropped silently)
    const consumed = buffer.handleEvent({
      type: 'conversation_history',
      agentId: 'wrong-session',
      messages: [],
    } as ServerEvent)

    expect(consumed).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Flush with empty patch
  // ---------------------------------------------------------------------------

  it('flush() does not emit state update when patch is empty', () => {
    const { buffer, patches } = setup()
    buffer.begin('session-b')

    // No events received — flush should not emit
    buffer.flush()
    expect(patches).toHaveLength(0)
  })

  // ---------------------------------------------------------------------------
  // unread_counts_snapshot filters target
  // ---------------------------------------------------------------------------

  it('unread_counts_snapshot filters current target from counts', () => {
    const { buffer, patches } = setup({ targetAgentId: 'session-b' })
    buffer.begin('session-b')

    buffer.handleEvent({
      type: 'unread_counts_snapshot',
      counts: { 'session-b': 5, 'session-c': 2 },
    } as ServerEvent)

    expect(patches).toHaveLength(1)
    // The conversation event handler filters target from unread counts
    expect(patches[0].unreadCounts).toEqual({ 'session-c': 2 })
  })
})
