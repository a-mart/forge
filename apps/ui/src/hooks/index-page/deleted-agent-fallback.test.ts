import { describe, expect, it } from 'vitest'
import { chooseMostRecentSessionFallbackForDeletedTarget } from './deleted-agent-fallback'
import type { AgentDescriptor } from '@forge/protocol'

function makeManager(
  agentId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

function makeWorker(
  agentId: string,
  managerId: string,
  overrides: Partial<AgentDescriptor> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId,
    displayName: agentId,
    role: 'worker',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
    ...overrides,
  }
}

function toMap(agents: AgentDescriptor[]): Map<string, AgentDescriptor> {
  return new Map(agents.map((a) => [a.agentId, a]))
}

describe('chooseMostRecentSessionFallbackForDeletedTarget', () => {
  describe('same-profile most-recent fallback', () => {
    it('picks the most recently updated session in the same profile', () => {
      const old = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const recent = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })
      const deleted = makeManager('alpha--s3', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:03:00.000Z',
      })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [old, recent], // remaining agents after deletion
        'alpha--s3',
        toMap([old, recent, deleted]),
      )

      expect(result).toBe('alpha--s2')
    })

    it('does not select sessions from other profiles', () => {
      const sameProfile = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const otherProfile = makeManager('beta', {
        profileId: 'beta',
        updatedAt: '2026-01-01T00:10:00.000Z',
      })
      const deleted = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:03:00.000Z',
      })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [sameProfile, otherProfile],
        'alpha--s2',
        toMap([sameProfile, otherProfile, deleted]),
      )

      expect(result).toBe('alpha')
    })

    it('returns null when no sessions remain in the profile', () => {
      const deleted = makeManager('alpha', { profileId: 'alpha' })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [],
        'alpha',
        toMap([deleted]),
      )

      expect(result).toBeNull()
    })
  })

  describe('root/session deletion inference', () => {
    it('infers profile from session-style agent id (profile--sN pattern)', () => {
      // Deleted agent is not in previousAgentsById, so must infer from ID pattern
      const remaining = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const another = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [remaining, another],
        'alpha--s99', // deleted session ID, not in previous map
        new Map(), // empty previous map
      )

      expect(result).toBe('alpha--s2')
    })

    it('infers profile from root agent id when profile matches', () => {
      // When the deleted agent ID matches a remaining agent's profileId, it's treated as root deletion
      const remaining = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [remaining],
        'alpha', // deleted root agent ID, not in previous map
        new Map(), // empty previous map
      )

      expect(result).toBe('alpha--s2')
    })

    it('returns null when inferred profile has no remaining sessions', () => {
      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [],
        'alpha--s5',
        new Map(),
      )

      expect(result).toBeNull()
    })

    it('returns null when agent id does not match session pattern and no profile match', () => {
      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [makeManager('beta', { profileId: 'beta' })],
        'unknown-agent',
        new Map(),
      )

      expect(result).toBeNull()
    })
  })

  describe('worker deletion manager-profile resolution', () => {
    it('resolves profile from the worker manager descriptor (current agents)', () => {
      const manager = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const session2 = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })
      const deletedWorker = makeWorker('worker-1', 'alpha', { profileId: 'alpha' })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [manager, session2],
        'worker-1',
        toMap([manager, session2, deletedWorker]),
      )

      expect(result).toBe('alpha--s2')
    })

    it('resolves profile from previous manager descriptor when current is absent', () => {
      const previousManager = makeManager('alpha', {
        profileId: 'alpha',
      })
      const remaining = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })
      const deletedWorker = makeWorker('worker-1', 'alpha')

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [remaining], // manager 'alpha' was also deleted
        'worker-1',
        toMap([previousManager, remaining, deletedWorker]),
      )

      expect(result).toBe('alpha--s2')
    })

    it('returns null when neither current nor previous manager exists', () => {
      const deletedWorker = makeWorker('worker-1', 'vanished-manager')

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [],
        'worker-1',
        toMap([deletedWorker]),
      )

      expect(result).toBeNull()
    })
  })

  describe('invalid timestamp tie-break by agentId', () => {
    it('breaks ties using reverse lexicographic agentId ordering', () => {
      const sessionA = makeManager('alpha--s1', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const sessionB = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z', // same timestamp
      })
      const deleted = makeManager('alpha--s3', { profileId: 'alpha' })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [sessionA, sessionB],
        'alpha--s3',
        toMap([sessionA, sessionB, deleted]),
      )

      // Reverse localeCompare: 'alpha--s2' > 'alpha--s1' so s2 comes first
      expect(result).toBe('alpha--s2')
    })

    it('handles invalid/missing timestamps by normalizing to 0', () => {
      const sessionWithBadTimestamp = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: 'not-a-date',
      })
      const sessionWithGoodTimestamp = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const deleted = makeManager('alpha--s3', { profileId: 'alpha' })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [sessionWithBadTimestamp, sessionWithGoodTimestamp],
        'alpha--s3',
        toMap([sessionWithBadTimestamp, sessionWithGoodTimestamp, deleted]),
      )

      // Good timestamp (nonzero) wins over bad (normalized to 0)
      expect(result).toBe('alpha--s2')
    })

    it('two invalid timestamps tie-break by agentId', () => {
      const sessionA = makeManager('alpha--a', {
        profileId: 'alpha',
        updatedAt: 'invalid',
      })
      const sessionB = makeManager('alpha--b', {
        profileId: 'alpha',
        updatedAt: 'also-invalid',
      })
      const deleted = makeManager('alpha--s3', { profileId: 'alpha' })

      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [sessionA, sessionB],
        'alpha--s3',
        toMap([sessionA, sessionB, deleted]),
      )

      // Both normalize to 0, so reverse localeCompare: 'alpha--b' > 'alpha--a'
      expect(result).toBe('alpha--b')
    })
  })

  describe('profileId resolution edge cases', () => {
    it('uses agentId when profileId is empty or whitespace-only', () => {
      // The helper trims profileId and falls back to agentId
      const managerWithEmptyProfile = makeManager('alpha', {
        profileId: '   ',
        updatedAt: '2026-01-01T00:05:00.000Z',
      })
      const session = makeManager('alpha--s2', {
        profileId: '   ',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const deleted = makeManager('alpha--s3', {
        profileId: 'alpha', // canonical profile
        updatedAt: '2026-01-01T00:03:00.000Z',
      })

      // The deleted agent's profileId is 'alpha', but remaining agents have empty profileId.
      // They'll fall back to agentId, so only 'alpha' (the managerWithEmptyProfile whose agentId == 'alpha') matches
      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [managerWithEmptyProfile, session],
        'alpha--s3',
        toMap([managerWithEmptyProfile, session, deleted]),
      )

      expect(result).toBe('alpha')
    })

    it('does not return the deleted agent itself as fallback', () => {
      const remaining = makeManager('alpha', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:01:00.000Z',
      })
      const deleted = makeManager('alpha--s2', {
        profileId: 'alpha',
        updatedAt: '2026-01-01T00:10:00.000Z',
      })

      // Even though deleted has the most recent timestamp, it's excluded since it's been deleted
      // (it won't be in the agents array)
      const result = chooseMostRecentSessionFallbackForDeletedTarget(
        [remaining],
        'alpha--s2',
        toMap([remaining, deleted]),
      )

      expect(result).toBe('alpha')
    })
  })
})
