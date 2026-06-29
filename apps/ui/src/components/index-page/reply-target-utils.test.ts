import { describe, expect, it } from 'vitest'
import type { ConversationEntry, ConversationReplyTargetInput } from '@forge/protocol'
import { isReplyTargetLoadedInMessages } from './reply-target-utils'

const replyTarget: ConversationReplyTargetInput = {
  messageId: 'original-1',
  role: 'assistant',
  timestamp: '2026-06-29T10:00:00.000Z',
  text: 'Original assistant answer',
}

const originalMessage: ConversationEntry = {
  type: 'conversation_message',
  agentId: 'session-1',
  id: 'original-1',
  role: 'assistant',
  text: 'Original assistant answer',
  timestamp: '2026-06-29T10:00:00.000Z',
  source: 'speak_to_user',
}

describe('reply target utilities', () => {
  it('keeps a reply target only while the original message remains loaded', () => {
    expect(isReplyTargetLoadedInMessages(replyTarget, [originalMessage])).toBe(true)
  })

  it('clears stale reply targets after the current session conversation is cleared in place', () => {
    expect(isReplyTargetLoadedInMessages(replyTarget, [])).toBe(false)
  })
})
