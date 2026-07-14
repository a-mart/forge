import { describe, expect, it } from 'vitest'
import {
  buildCreateManagerCommand,
  buildHydrateArchiveLastUsedCommand,
  buildProfileArchiveActionCommand,
  buildSessionActionCommand,
  buildSessionGoalControlCommand,
} from './request-definitions'

describe('buildCreateManagerCommand', () => {
  it('serializes reasoningLevel with preset create_manager payloads', () => {
    expect(buildCreateManagerCommand({
      name: '  Preset Manager  ',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'low',
    }, 'req-1')).toEqual({
      type: 'create_manager',
      name: 'Preset Manager',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'low',
      requestId: 'req-1',
    })
  })

  it('serializes reasoningLevel with exact modelSelection create_manager payloads', () => {
    expect(buildCreateManagerCommand({
      name: 'Exact Manager',
      cwd: '/tmp/project',
      modelSelection: { provider: 'claude-sdk', modelId: 'claude-opus-4-7' },
      reasoningLevel: 'medium',
    }, 'req-2')).toEqual({
      type: 'create_manager',
      name: 'Exact Manager',
      cwd: '/tmp/project',
      modelSelection: { provider: 'claude-sdk', modelId: 'claude-opus-4-7' },
      reasoningLevel: 'medium',
      requestId: 'req-2',
    })
  })

  it('rejects invalid create_manager reasoningLevel during serialization', () => {
    expect(() => buildCreateManagerCommand({
      name: 'Bad Reasoning Manager',
      cwd: '/tmp/project',
      model: 'pi-codex',
      reasoningLevel: 'galaxy' as never,
    }, 'req-3')).toThrow('Invalid reasoning level.')
  })
})

describe('archive request command builders', () => {
  it('serializes session archive and restore requests', () => {
    expect(buildSessionActionCommand('archive_session', ' session-a ', 'req-archive')).toEqual({
      type: 'archive_session',
      agentId: 'session-a',
      requestId: 'req-archive',
    })
    expect(buildSessionActionCommand('restore_session', ' session-a ', 'req-restore')).toEqual({
      type: 'restore_session',
      agentId: 'session-a',
      requestId: 'req-restore',
    })
  })

  it('serializes archive last-used hydration requests', () => {
    expect(buildHydrateArchiveLastUsedCommand('req-hydrate')).toEqual({
      type: 'hydrate_archive_last_used',
      requestId: 'req-hydrate',
    })
  })

  it('serializes profile archive and restore requests', () => {
    expect(buildProfileArchiveActionCommand('archive_profile', ' profile-a ', 'req-archive-profile')).toEqual({
      type: 'archive_profile',
      profileId: 'profile-a',
      requestId: 'req-archive-profile',
    })
    expect(buildProfileArchiveActionCommand('restore_profile', ' profile-a ', 'req-restore-profile')).toEqual({
      type: 'restore_profile',
      profileId: 'profile-a',
      requestId: 'req-restore-profile',
    })
  })
})

describe('buildSessionGoalControlCommand', () => {
  it('preserves the narrow discriminated goal action', () => {
    expect(buildSessionGoalControlCommand('session-a', {
      action: 'edit',
      objective: 'Refined outcome',
      tokenBudget: null,
    })).toEqual({
      type: 'session_goal_control',
      agentId: 'session-a',
      action: 'edit',
      objective: 'Refined outcome',
      tokenBudget: null,
    })
  })
})
