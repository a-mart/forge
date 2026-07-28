import { describe, expect, it } from 'vitest'

import type { AgentDescriptor, ConversationMessageEvent } from '../index.js'
import {
  CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL,
  type HasExternalThread,
  isCodexAppServerExternalThreadDescriptor,
  isExternalThreadDescriptor,
  isForgeManagedRuntimeWorkerDescriptor,
  requiresForgeAgentRuntime,
  shouldExcludeConversationMessageFromModelContext,
  validateCodexExternalThreadModelInvariant,
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
      externalThread: undefined,
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

  it('excludes worker reports from model context by source', () => {
    const workerReport = {
      type: 'conversation_message',
      agentId: 'session-1',
      role: 'system',
      text: 'worker completed',
      timestamp: now,
      source: 'worker_report',
      terminal: true,
      sourceWorkerId: 'worker-1',
    } satisfies ConversationMessageEvent

    expect(shouldExcludeConversationMessageFromModelContext(workerReport)).toBe(true)
  })

  it('classifies Forge-managed runtime workers separately from external threads', () => {
    const codexSidecar = {
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
      },
    } satisfies AgentDescriptor

    const forgeWorker = {
      ...codexSidecar,
      agentId: 'worker-1',
      displayName: 'Worker',
      sessionFile: '/tmp/workers/worker-1.jsonl',
      externalThread: undefined,
      model: {
        provider: 'openai-codex',
        modelId: 'gpt-5.4',
        thinkingLevel: 'medium',
      },
    } satisfies AgentDescriptor

    expect(isForgeManagedRuntimeWorkerDescriptor(codexSidecar)).toBe(false)
    expect(isForgeManagedRuntimeWorkerDescriptor(forgeWorker)).toBe(true)
    expect(requiresForgeAgentRuntime(codexSidecar)).toBe(false)
    expect(requiresForgeAgentRuntime(forgeWorker)).toBe(true)
    expect(requiresForgeAgentRuntime({ role: 'manager', externalThread: undefined } as AgentDescriptor)).toBe(true)
  })

  it('validates the Codex external-thread model invariant', () => {
    expect(validateCodexExternalThreadModelInvariant(CODEX_APP_SERVER_EXTERNAL_THREAD_MODEL)).toBeUndefined()
    expect(
      validateCodexExternalThreadModelInvariant({
        provider: 'openai-codex',
        modelId: 'gpt-5.4',
        thinkingLevel: 'medium',
      }),
    ).toContain('codex-app-server')
  })
})
