import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '@forge/protocol'
import { buildStoppableExternalThreadMessageIds } from './external-thread-stop-eligibility'

function codexCard(
  id: string,
  sidecarAgentId: string,
  status: 'sent' | 'running' | 'completed' | 'stopped' | 'error',
): ConversationEntry {
  return {
    type: 'conversation_message',
    agentId: 'manager-1',
    id,
    role: 'system',
    text: `Codex ${status}`,
    timestamp: `${id}-ts`,
    source: 'system',
    externalThreadContext: {
      type: 'codex_app_server',
      sidecarAgentId,
      requestId: `req-${id}`,
      turnCorrelationId: `turn-${id}`,
      status,
      excludeFromModelContext: true,
    },
  }
}

describe('buildStoppableExternalThreadMessageIds', () => {
  it('enables stop only on the latest unresolved in-progress card while sidecar is streaming', () => {
    const messages: ConversationEntry[] = [
      codexCard('msg-1', 'manager-1--codex', 'sent'),
      codexCard('msg-2', 'manager-1--codex', 'completed'),
      codexCard('msg-3', 'manager-1--codex', 'sent'),
      codexCard('msg-4', 'manager-1--codex', 'running'),
    ]

    const stoppable = buildStoppableExternalThreadMessageIds(messages, {
      'manager-1--codex': { status: 'streaming' },
    })

    expect(stoppable.has('msg-1')).toBe(false)
    expect(stoppable.has('msg-2')).toBe(false)
    expect(stoppable.has('msg-3')).toBe(false)
    expect(stoppable.has('msg-4')).toBe(true)
  })

  it('disables stop when sidecar is not streaming', () => {
    const messages: ConversationEntry[] = [
      codexCard('msg-1', 'manager-1--codex', 'sent'),
      codexCard('msg-2', 'manager-1--codex', 'completed'),
      codexCard('msg-3', 'manager-1--codex', 'running'),
    ]

    const stoppable = buildStoppableExternalThreadMessageIds(messages, {
      'manager-1--codex': { status: 'idle' },
    })

    expect(stoppable.size).toBe(0)
  })
})
