import { describe, expect, it } from 'vitest'
import {
  buildCreateManagerCommand,
  buildCreateRepositoryProjectCommand,
  buildProfileArchiveActionCommand,
  buildSessionActionCommand,
  buildUpdateProjectDelegationDefaultsCommand,
  buildUpdateSessionDelegationCommand,
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

describe('delegation settings command builders', () => {
  it('serializes project defaults without inventing untouched fields', () => {
    expect(buildUpdateProjectDelegationDefaultsCommand(
      ' project-a ',
      { managerPosture: 'adaptive' },
      'req-project-delegation',
    )).toEqual({
      type: 'update_project_delegation_defaults',
      profileId: 'project-a',
      managerPosture: 'adaptive',
      requestId: 'req-project-delegation',
    })
    expect(buildUpdateProjectDelegationDefaultsCommand(
      'project-a',
      { delegationRosterId: null },
      'req-clear-roster',
    )).toEqual({
      type: 'update_project_delegation_defaults',
      profileId: 'project-a',
      delegationRosterId: null,
      requestId: 'req-clear-roster',
    })
  })

  it('preserves future Work Mode IDs and request correlation exactly', () => {
    expect(buildUpdateProjectDelegationDefaultsCommand(
      'project-a',
      { managerPosture: 'review_led' },
      'req-future-project-mode',
    )).toEqual({
      type: 'update_project_delegation_defaults',
      profileId: 'project-a',
      managerPosture: 'review_led',
      requestId: 'req-future-project-mode',
    })
    expect(buildUpdateSessionDelegationCommand(
      'session-a',
      { managerPosture: { mode: 'override', value: 'review_led' } },
      'req-future-session-mode',
    )).toEqual({
      type: 'update_session_delegation',
      sessionAgentId: 'session-a',
      managerPosture: { mode: 'override', value: 'review_led' },
      requestId: 'req-future-session-mode',
    })
  })

  it('serializes session inheritance and trims explicit roster ids', () => {
    expect(buildUpdateSessionDelegationCommand(
      ' session-a ',
      {
        managerPosture: { mode: 'inherit' },
        delegationRoster: { mode: 'override', rosterId: ' diverse ' },
      },
      'req-session-delegation',
    )).toEqual({
      type: 'update_session_delegation',
      sessionAgentId: 'session-a',
      managerPosture: { mode: 'inherit' },
      delegationRoster: { mode: 'override', rosterId: 'diverse' },
      requestId: 'req-session-delegation',
    })
  })
})

it.each([true, false])('serializes the project Secure Sessions choice (%s) for local and cloned projects', (secureSessionsEnabled) => {
  const input = { name: 'Project', modelSelection: { provider: 'openai', modelId: 'gpt-5.5' }, secureSessionsEnabled }
  expect(buildCreateManagerCommand({ ...input, cwd: '/tmp' }, 'create')).toMatchObject({ secureSessionsEnabled })
  expect(buildCreateRepositoryProjectCommand({ ...input, repositoryUrl: 'https://example.test/repo.git', repositoryBasePath: '/tmp', repositoryFolder: 'repo' }, 'clone')).toMatchObject({ secureSessionsEnabled })
})
