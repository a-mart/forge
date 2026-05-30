import { describe, expect, it } from 'vitest'

import type { AgentDescriptor, ConversationMessageEvent } from '../index.js'
import {
  type HasExternalThread,
  isCodexAppServerExternalThreadDescriptor,
  isExternalThreadDescriptor,
  shouldExcludeConversationMessageFromModelContext,
} from '../external-threads.js'

const now = '2026-05-30T00:00:00.000Z'

const model = {
  provider: 'codex-app-server',
  modelId: 'app-server',
  thinkingLevel: 'none',
} as const

describe('external thread helpers', () => {
  it('detects Codex app-server external thread descriptors', () => {
    const descriptor = {
      agentId: 'session-1--codex',
      managerId: 'session-1',
      displayName: 'Codex',
      role: 'worker',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      cwd: '/tmp',
      model,
      sessionFile: '/tmp/workers/session-1--codex.jsonl',
      externalThread: {
        type: 'codex_app_server',
        persisted: true,
        createdByMention: true,
        threadId: 'thread-1',
      },
    } satisfies AgentDescriptor

    expect(isExternalThreadDescriptor(descriptor)).toBe(true)
    expect(isCodexAppServerExternalThreadDescriptor(descriptor)).toBe(true)

    const externalOnly: Pick<AgentDescriptor, 'externalThread'> = {
      externalThread: descriptor.externalThread,
    }
    if (isExternalThreadDescriptor(externalOnly)) {
      const narrowed: HasExternalThread = externalOnly
      expect(narrowed.externalThread.threadId).toBe('thread-1')
    } else {
      throw new Error('expected external thread descriptor')
    }
  })

  it('does not treat normal workers as external threads', () => {
    const descriptor = {
      agentId: 'worker-1',
      managerId: 'session-1',
      displayName: 'Worker',
      role: 'worker',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      cwd: '/tmp',
      model,
      sessionFile: '/tmp/workers/worker-1.jsonl',
    } satisfies AgentDescriptor

    expect(isExternalThreadDescriptor(descriptor)).toBe(false)
    expect(isCodexAppServerExternalThreadDescriptor(descriptor)).toBe(false)
  })

  it('excludes parent Codex display/control cards from model context', () => {
    const requestCard = {
      type: 'conversation_message',
      agentId: 'session-1',
      role: 'system',
      text: 'Sent to Codex',
      timestamp: now,
      source: 'system',
      externalThreadContext: {
        type: 'codex_app_server',
        sidecarAgentId: 'session-1--codex',
        requestId: 'req-1',
        turnCorrelationId: 'turn-1',
        status: 'sent',
        promptPreview: 'hello',
        excludeFromModelContext: true,
      },
    } satisfies ConversationMessageEvent

    const normalMessage = {
      type: 'conversation_message',
      agentId: 'session-1',
      role: 'user',
      text: 'hello',
      timestamp: now,
      source: 'user_input',
    } satisfies ConversationMessageEvent

    expect(shouldExcludeConversationMessageFromModelContext(requestCard)).toBe(true)
    expect(shouldExcludeConversationMessageFromModelContext(normalMessage)).toBe(false)
  })
})
