import { describe, expect, it } from 'vitest'
import type { ChoiceRequestEvent, ConversationEntry } from '../conversation-events.js'
import {
  collectKnownWorkerIds,
  inferManagerAliasIds,
  isVisibleInManagerAllView,
} from '../manager-context-visibility.js'
import type { PendingChoicesSnapshotEvent } from '../transport-events.js'

const activeManagerId = 'manager-1'
const workerId = 'worker-1'

const agents = [
  { agentId: activeManagerId, role: 'manager' },
  { agentId: workerId, role: 'worker', managerId: activeManagerId },
] as const

const knownWorkerIds = collectKnownWorkerIds(agents, activeManagerId)
const managerAliasIds = inferManagerAliasIds([], activeManagerId, knownWorkerIds)

function visibilityOptions() {
  return { activeManagerId, managerAliasIds, knownWorkerIds }
}

function choiceRequest(overrides: Partial<ChoiceRequestEvent> = {}): ChoiceRequestEvent {
  return {
    type: 'choice_request',
    agentId: activeManagerId,
    choiceId: 'choice-1',
    questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    status: 'pending',
    timestamp: '2026-06-21T00:00:00.000Z',
    ...overrides,
  }
}

describe('manager All view choice_request visibility', () => {
  it('shows manager-originated choice requests when agentId is a manager alias', () => {
    const entry = choiceRequest({ agentId: activeManagerId })

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(true)
  })

  it('shows worker-originated choice requests when sessionAgentId matches the active manager alias', () => {
    const entry = choiceRequest({
      agentId: workerId,
      sessionAgentId: activeManagerId,
    })

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(true)
  })

  it('hides worker-originated choice requests for a different session alias', () => {
    const entry = choiceRequest({
      agentId: workerId,
      sessionAgentId: 'manager-2',
    })

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(false)
  })

  it('does not broaden worker tool-call visibility', () => {
    const entry: ConversationEntry = {
      type: 'agent_tool_call',
      agentId: workerId,
      actorAgentId: workerId,
      timestamp: '2026-06-21T00:00:00.000Z',
      kind: 'tool_execution_start',
      toolName: 'present_choices',
      toolCallId: 'tool-1',
      text: 'present choices',
    }

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(false)
  })
})

describe('manager All view plan_summary visibility', () => {
  it('shows summaries that belong to the active manager session', () => {
    const entry: ConversationEntry = {
      type: 'plan_summary',
      id: 'plan-summary-1',
      agentId: activeManagerId,
      timestamp: '2026-06-21T00:00:00.000Z',
      revision: 2,
      updatedAt: '2026-06-21T00:00:00.000Z',
      plan: [{ step: 'Finish the work', status: 'completed' }],
    }

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(true)
  })

  it('hides summaries from another manager session', () => {
    const entry: ConversationEntry = {
      type: 'plan_summary',
      id: 'plan-summary-2',
      agentId: 'manager-2',
      timestamp: '2026-06-21T00:00:00.000Z',
      revision: 2,
      updatedAt: '2026-06-21T00:00:00.000Z',
      plan: [{ step: 'Finish the work', status: 'completed' }],
    }

    expect(isVisibleInManagerAllView(entry, visibilityOptions())).toBe(false)
  })
})

describe('PendingChoicesSnapshotEvent protocol shape', () => {
  it('keeps choiceIds and accepts optional hydrated choice payloads', () => {
    const snapshot: PendingChoicesSnapshotEvent = {
      type: 'pending_choices_snapshot',
      agentId: activeManagerId,
      choiceIds: ['choice-1'],
      choices: [choiceRequest({ agentId: workerId, sessionAgentId: activeManagerId })],
    }

    expect(snapshot.choiceIds).toEqual(['choice-1'])
    expect(snapshot.choices?.[0]?.sessionAgentId).toBe(activeManagerId)
  })
})
