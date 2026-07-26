import { describe, expect, it } from 'vitest'
import type { AgentDescriptor } from '@forge/protocol'
import { isSecureSessionRuntimeSupported } from './secure-session-runtime-eligibility'

function agent(provider: string, overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    agentId: 'worker-1',
    displayName: 'Worker 1',
    role: 'worker',
    managerId: 'manager-1',
    profileId: 'profile-1',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/forge-secure-eligibility',
    model: {
      provider,
      modelId: provider === 'claude-sdk' ? 'claude-future-unknown' : 'test-model',
      thinkingLevel: 'medium',
    },
    sessionFile: '/tmp/forge-secure-eligibility/session.jsonl',
    ...overrides,
  }
}

describe('isSecureSessionRuntimeSupported', () => {
  it('treats unknown legacy claude-sdk descriptors as Secure Sessions ineligible', () => {
    expect(isSecureSessionRuntimeSupported(agent('claude-sdk'))).toBe(false)
    expect(isSecureSessionRuntimeSupported(agent('Claude-SDK'))).toBe(false)
  })

  it('keeps native Anthropic eligible for Secure Sessions', () => {
    expect(isSecureSessionRuntimeSupported(agent('anthropic', {
      model: {
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        thinkingLevel: 'medium',
      },
    }))).toBe(true)
  })

  it('rejects cursor-sdk and external-thread agents', () => {
    expect(isSecureSessionRuntimeSupported(agent('cursor-sdk'))).toBe(false)
    expect(isSecureSessionRuntimeSupported(agent('anthropic', {
      externalThread: {
        type: 'codex_app_server',
        persisted: true,
        createdByMention: false,
        threadId: 'thread-1',
      },
    }))).toBe(false)
    expect(isSecureSessionRuntimeSupported(null)).toBe(false)
  })
})
