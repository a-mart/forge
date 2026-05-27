import { describe, expect, it } from 'vitest'
import type { AgentDescriptor, ManagerProfile } from '@forge/protocol'
import { isUsableActiveTarget } from './archive-target-guards'

function manager(agentId: string, profileId: string, archivedAt?: string): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    sessionFile: `/tmp/${agentId}.jsonl`,
    profileId,
    archivedAt,
  }
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...manager(agentId, 'profile-a'),
    managerId,
    role: 'worker',
  }
}

function profile(profileId: string, archivedAt?: string): ManagerProfile {
  return {
    profileId,
    displayName: profileId,
    defaultSessionAgentId: profileId,
    defaultModel: { provider: 'openai-codex', modelId: 'gpt-5.5', thinkingLevel: 'medium' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt,
  }
}

describe('BuilderSurface archive target guards', () => {
  it('treats explicit archived manager and worker targets as unusable before resubscribe', () => {
    const agents = [
      manager('active-session', 'profile-a'),
      manager('archived-session', 'profile-a', '2026-05-20T00:00:00.000Z'),
      worker('archived-worker', 'archived-session'),
      manager('profile-archived-session', 'profile-archived'),
      worker('profile-archived-worker', 'profile-archived-session'),
    ]
    const profiles = [
      profile('profile-a'),
      profile('profile-archived', '2026-05-20T00:00:00.000Z'),
    ]

    expect(isUsableActiveTarget('active-session', agents, profiles)).toBe(true)
    expect(isUsableActiveTarget('archived-session', agents, profiles)).toBe(false)
    expect(isUsableActiveTarget('archived-worker', agents, profiles)).toBe(false)
    expect(isUsableActiveTarget('profile-archived-session', agents, profiles)).toBe(false)
    expect(isUsableActiveTarget('profile-archived-worker', agents, profiles)).toBe(false)
  })
})
