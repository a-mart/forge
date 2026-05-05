import { WS_REQUEST_CONTRACTS } from '@forge/protocol'
import { describe, expect, it } from 'vitest'
import { extractRequestId, parseClientCommand } from '../ws/ws-command-parser.js'

function parseJsonCommand(payload: unknown) {
  return parseClientCommand(Buffer.from(JSON.stringify(payload), 'utf8'))
}

describe('ws command parser session commands', () => {
  it('parses create_session and normalizes optional label + name', () => {
    const parsed = parseJsonCommand({
      type: 'create_session',
      profileId: ' manager ',
      label: '  Focus work  ',
      name: '  My Cool Session  ',
      sessionPurpose: 'agent_creator',
      requestId: 'req-1',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'create_session',
        profileId: 'manager',
        label: 'Focus work',
        name: 'My Cool Session',
        sessionPurpose: 'agent_creator',
        requestId: 'req-1',
      },
    })
  })

  it('parses request contracts while preserving optional wire requestId', () => {
    const payloadByType = {
      list_directories: { type: 'list_directories', path: '/tmp/project' },
      validate_directory: { type: 'validate_directory', path: '/tmp/project' },
      pick_directory: { type: 'pick_directory', defaultPath: '/tmp/project' },
      get_session_workers: { type: 'get_session_workers', sessionAgentId: 'session-a' },
      rename_profile: { type: 'rename_profile', profileId: 'profile-a', displayName: 'Profile A' },
      rename_session: { type: 'rename_session', agentId: 'session-a', label: 'Session A' },
      pin_session: { type: 'pin_session', agentId: 'session-a', pinned: false },
      update_session_model: { type: 'update_session_model', sessionAgentId: 'session-a', mode: 'inherit' },
      fork_session: { type: 'fork_session', sourceAgentId: 'session-a', label: 'Forked', fromMessageId: 'message-1' },
      update_manager_model: { type: 'update_manager_model', managerId: 'manager-a', model: 'pi-5.4', reasoningLevel: undefined },
      update_manager_cwd: { type: 'update_manager_cwd', managerId: 'manager-a', cwd: '/tmp/project' },
      create_session: { type: 'create_session', profileId: 'manager-a', label: 'Session A', name: 'Session A', sessionPurpose: 'agent_creator' },
      stop_session: { type: 'stop_session', agentId: 'session-a' },
      resume_session: { type: 'resume_session', agentId: 'session-a' },
      delete_session: { type: 'delete_session', agentId: 'session-a' },
      clear_session: { type: 'clear_session', agentId: 'session-a' },
    } as const

    for (const contract of WS_REQUEST_CONTRACTS) {
      const basePayload = payloadByType[contract.commandType]
      expect(parseJsonCommand({ ...basePayload, requestId: 'request-1' })).toEqual({
        ok: true,
        command: { ...basePayload, requestId: 'request-1' },
      })
      expect(parseJsonCommand(basePayload)).toEqual({
        ok: true,
        command: { ...basePayload, requestId: undefined },
      })
    }
  })

  it('rejects invalid requestId values for request contracts without making requestId mandatory', () => {
    expect(parseJsonCommand({ type: 'get_session_workers', sessionAgentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'get_session_workers', sessionAgentId: 'session-a', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'get_session_workers', sessionAgentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'get_session_workers.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'rename_profile', profileId: 'profile-a', displayName: 'Renamed' })).toEqual({
      ok: true,
      command: { type: 'rename_profile', profileId: 'profile-a', displayName: 'Renamed', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'rename_profile', profileId: 'profile-a', displayName: 'Renamed', requestId: 123 })).toEqual({
      ok: false,
      error: 'rename_profile.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'pin_session', agentId: 'session-a', pinned: false })).toEqual({
      ok: true,
      command: { type: 'pin_session', agentId: 'session-a', pinned: false, requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'pin_session', agentId: 'session-a', pinned: false, requestId: 123 })).toEqual({
      ok: false,
      error: 'pin_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'update_session_model', sessionAgentId: 'session-a', mode: 'inherit' })).toEqual({
      ok: true,
      command: { type: 'update_session_model', sessionAgentId: 'session-a', mode: 'inherit', model: undefined, reasoningLevel: undefined, modelSelection: undefined, requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'update_session_model', sessionAgentId: 'session-a', mode: 'inherit', requestId: 123 })).toEqual({
      ok: false,
      error: 'update_session_model.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'fork_session', sourceAgentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'fork_session', sourceAgentId: 'session-a', label: undefined, fromMessageId: undefined, requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'fork_session', sourceAgentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'fork_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'update_manager_model', managerId: 'manager-a', model: 'pi-5.4' })).toEqual({
      ok: true,
      command: { type: 'update_manager_model', managerId: 'manager-a', model: 'pi-5.4', reasoningLevel: undefined, requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'update_manager_model', managerId: 'manager-a', model: 'pi-5.4', requestId: 123 })).toEqual({
      ok: false,
      error: 'update_manager_model.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'update_manager_cwd', managerId: 'manager-a', cwd: '/tmp/project' })).toEqual({
      ok: true,
      command: { type: 'update_manager_cwd', managerId: 'manager-a', cwd: '/tmp/project', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'update_manager_cwd', managerId: 'manager-a', cwd: '/tmp/project', requestId: 123 })).toEqual({
      ok: false,
      error: 'update_manager_cwd.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'create_session', profileId: 'manager-a' })).toEqual({
      ok: true,
      command: { type: 'create_session', profileId: 'manager-a', label: undefined, name: undefined, sessionPurpose: undefined, requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'create_session', profileId: 'manager-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'create_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'clear_session', agentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'clear_session', agentId: 'session-a', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'clear_session', agentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'clear_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'stop_session', agentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'stop_session', agentId: 'session-a', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'stop_session', agentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'stop_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'resume_session', agentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'resume_session', agentId: 'session-a', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'resume_session', agentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'resume_session.requestId must be a string when provided',
    })
    expect(parseJsonCommand({ type: 'delete_session', agentId: 'session-a' })).toEqual({
      ok: true,
      command: { type: 'delete_session', agentId: 'session-a', requestId: undefined },
    })
    expect(parseJsonCommand({ type: 'delete_session', agentId: 'session-a', requestId: 123 })).toEqual({
      ok: false,
      error: 'delete_session.requestId must be a string when provided',
    })
  })

  it('parses subscribe messageCount', () => {
    const parsed = parseJsonCommand({
      type: 'subscribe',
      agentId: 'manager',
      messageCount: 75,
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'subscribe',
        agentId: 'manager',
        messageCount: 75,
      },
    })
  })

  it('rejects manager model commands that send both legacy and exact selections', () => {
    expect(parseJsonCommand({
      type: 'create_manager',
      name: 'Dual Mode Manager',
      cwd: '/tmp/project',
      model: 'pi-opus',
      modelSelection: { provider: 'anthropic', modelId: 'claude-opus-4-7' },
    })).toEqual({
      ok: false,
      error: 'create_manager.model and create_manager.modelSelection are mutually exclusive',
    })

    expect(parseJsonCommand({
      type: 'update_profile_default_model',
      profileId: 'manager',
      model: 'pi-opus',
      modelSelection: { provider: 'anthropic', modelId: 'claude-opus-4-7' },
    })).toEqual({
      ok: false,
      error: 'update_profile_default_model.model and update_profile_default_model.modelSelection are mutually exclusive',
    })

    expect(parseJsonCommand({
      type: 'update_session_model',
      sessionAgentId: 'manager--s2',
      mode: 'override',
      model: 'pi-opus',
      modelSelection: { provider: 'anthropic', modelId: 'claude-opus-4-7' },
    })).toEqual({
      ok: false,
      error: 'update_session_model.model and update_session_model.modelSelection are mutually exclusive',
    })
  })

  it('parses all session lifecycle commands', () => {
    const commands = [
      { type: 'stop_session', agentId: 'session-a', requestId: 'req-stop' },
      { type: 'resume_session', agentId: 'session-a', requestId: 'req-resume' },
      { type: 'delete_session', agentId: 'session-a', requestId: 'req-delete' },
      { type: 'clear_session', agentId: 'session-a', requestId: 'req-clear' },
      { type: 'rename_session', agentId: 'session-a', label: 'Renamed', requestId: 'req-rename' },
      { type: 'pin_session', agentId: 'session-a', pinned: true, requestId: 'req-pin' },
      {
        type: 'set_session_project_agent',
        agentId: 'session-a',
        projectAgent: { whenToUse: 'Coordinate release work' },
        requestId: 'req-project-agent',
      },
      {
        type: 'request_project_agent_recommendations',
        agentId: 'session-a',
        requestId: 'req-project-agent-recs',
      },
      { type: 'fork_session', sourceAgentId: 'session-a', label: 'Forked', requestId: 'req-fork' },
      { type: 'merge_session_memory', agentId: 'session-a', requestId: 'req-merge' },
      { type: 'get_session_workers', sessionAgentId: 'session-a', requestId: 'req-workers' },
    ] as const

    for (const command of commands) {
      const parsed = parseJsonCommand(command)
      expect(parsed).toEqual({ ok: true, command })
    }
  })

  it('parses set_session_project_agent with an optional systemPrompt override', () => {
    const parsed = parseJsonCommand({
      type: 'set_session_project_agent',
      agentId: ' session-a ',
      projectAgent: {
        whenToUse: 'Coordinate release work',
        systemPrompt: 'You are the release coordination project agent.',
      },
      requestId: 'req-project-agent',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'set_session_project_agent',
        agentId: 'session-a',
        projectAgent: {
          whenToUse: 'Coordinate release work',
          systemPrompt: 'You are the release coordination project agent.',
        },
        requestId: 'req-project-agent',
      },
    })
  })

  it('parses set_session_project_agent without a systemPrompt override', () => {
    const parsed = parseJsonCommand({
      type: 'set_session_project_agent',
      agentId: 'session-a',
      projectAgent: {
        whenToUse: 'Coordinate release work',
      },
      requestId: 'req-project-agent',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'set_session_project_agent',
        agentId: 'session-a',
        projectAgent: {
          whenToUse: 'Coordinate release work',
        },
        requestId: 'req-project-agent',
      },
    })
  })

  it('parses set_session_project_agent with an explicit normalized handle', () => {
    const parsed = parseJsonCommand({
      type: 'set_session_project_agent',
      agentId: 'session-a',
      projectAgent: {
        handle: 'release-notes',
        whenToUse: 'Coordinate release work',
      },
      requestId: 'req-project-agent',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'set_session_project_agent',
        agentId: 'session-a',
        projectAgent: {
          handle: 'release-notes',
          whenToUse: 'Coordinate release work',
        },
        requestId: 'req-project-agent',
      },
    })
  })

  it('parses set_session_project_agent capabilities', () => {
    const parsed = parseJsonCommand({
      type: 'set_session_project_agent',
      agentId: 'session-a',
      projectAgent: {
        whenToUse: 'Coordinate release work',
        capabilities: ['create_session'],
      },
      requestId: 'req-project-agent',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'set_session_project_agent',
        agentId: 'session-a',
        projectAgent: {
          whenToUse: 'Coordinate release work',
          capabilities: ['create_session'],
        },
        requestId: 'req-project-agent',
      },
    })
  })

  it('parses api_proxy commands', () => {
    const parsed = parseJsonCommand({
      type: 'api_proxy',
      requestId: 'proxy-1',
      method: 'POST',
      path: '/api/mobile/push/test',
      body: JSON.stringify({ token: 'ExpoPushToken[abc]' }),
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'api_proxy',
        requestId: 'proxy-1',
        method: 'POST',
        path: '/api/mobile/push/test',
        body: JSON.stringify({ token: 'ExpoPushToken[abc]' }),
      },
    })
  })

  it('parses update_manager_cwd commands', () => {
    const parsed = parseJsonCommand({
      type: 'update_manager_cwd',
      managerId: ' project-alpha ',
      cwd: ' ./apps/backend ',
      requestId: 'req-cwd',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'update_manager_cwd',
        managerId: 'project-alpha',
        cwd: './apps/backend',
        requestId: 'req-cwd',
      },
    })
  })

  it('rejects invalid update_manager_cwd payloads', () => {
    const invalidPayloads: Array<{ payload: unknown; message: string }> = [
      {
        payload: { type: 'update_manager_cwd', managerId: '', cwd: '/tmp/project' },
        message: 'update_manager_cwd.managerId must be a non-empty string',
      },
      {
        payload: { type: 'update_manager_cwd', managerId: 'project-alpha', cwd: '   ' },
        message: 'update_manager_cwd.cwd must be a non-empty string',
      },
      {
        payload: { type: 'update_manager_cwd', managerId: 'project-alpha', cwd: '/tmp/project', requestId: 42 },
        message: 'update_manager_cwd.requestId must be a string when provided',
      },
    ]

    for (const testCase of invalidPayloads) {
      const parsed = parseJsonCommand(testCase.payload)
      expect(parsed).toEqual({ ok: false, error: testCase.message })
    }
  })

  it('parses mark_unread commands', () => {
    expect(parseJsonCommand({
      type: 'mark_unread',
      agentId: 'manager--s2',
      requestId: 'req-unread',
    })).toEqual({
      ok: true,
      command: {
        type: 'mark_unread',
        agentId: 'manager--s2',
        requestId: 'req-unread',
      },
    })

    expect(parseJsonCommand({
      type: 'mark_unread',
      agentId: '  manager--s3  ',
    })).toEqual({
      ok: true,
      command: {
        type: 'mark_unread',
        agentId: 'manager--s3',
        requestId: undefined,
      },
    })
  })

  it('parses pin_message commands', () => {
    expect(parseJsonCommand({
      type: 'pin_message',
      agentId: '  manager--s2  ',
      messageId: '  msg-1  ',
      pinned: true,
    })).toEqual({
      ok: true,
      command: {
        type: 'pin_message',
        agentId: 'manager--s2',
        messageId: 'msg-1',
        pinned: true,
      },
    })
  })

  it('parses clear_all_pins commands', () => {
    expect(parseJsonCommand({
      type: 'clear_all_pins',
      agentId: '  manager--s2  ',
    })).toEqual({
      ok: true,
      command: {
        type: 'clear_all_pins',
        agentId: 'manager--s2',
      },
    })
  })

  it('parses choice_response and choice_cancel commands', () => {
    expect(parseJsonCommand({
      type: 'choice_response',
      agentId: 'manager',
      choiceId: 'choice-1',
      answers: [{ questionId: 'q1', selectedOptionIds: ['opt-a'], text: 'notes' }],
    })).toEqual({
      ok: true,
      command: {
        type: 'choice_response',
        agentId: 'manager',
        choiceId: 'choice-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['opt-a'], text: 'notes' }],
      },
    })

    expect(parseJsonCommand({
      type: 'choice_cancel',
      agentId: 'manager',
      choiceId: 'choice-1',
    })).toEqual({
      ok: true,
      command: {
        type: 'choice_cancel',
        agentId: 'manager',
        choiceId: 'choice-1',
      },
    })
  })

  it('parses collaboration websocket commands', () => {
    expect(parseJsonCommand({ type: 'collab_bootstrap' })).toEqual({
      ok: true,
      command: { type: 'collab_bootstrap' },
    })

    expect(parseJsonCommand({
      type: 'collab_subscribe_channel',
      channelId: '  channel-1  ',
    })).toEqual({
      ok: true,
      command: {
        type: 'collab_subscribe_channel',
        channelId: 'channel-1',
      },
    })

    expect(parseJsonCommand({
      type: 'collab_user_message',
      channelId: 'channel-1',
      content: '  hello  ',
    })).toEqual({
      ok: true,
      command: {
        type: 'collab_user_message',
        channelId: 'channel-1',
        content: 'hello',
        attachments: undefined,
      },
    })

    expect(parseJsonCommand({
      type: 'collab_mark_channel_read',
      channelId: 'channel-1',
    })).toEqual({
      ok: true,
      command: {
        type: 'collab_mark_channel_read',
        channelId: 'channel-1',
      },
    })
  })

  it('rejects invalid session command payloads', () => {
    const invalidPayloads: Array<{ payload: unknown; message: string }> = [
      {
        payload: { type: 'create_session', profileId: '' },
        message: 'create_session.profileId must be a non-empty string',
      },
      {
        payload: { type: 'create_session', profileId: 'manager', name: 42 },
        message: 'create_session.name must be a string when provided',
      },
      {
        payload: { type: 'create_session', profileId: 'manager', sessionPurpose: 'bad-purpose' },
        message: 'create_session.sessionPurpose must be "cortex_review" or "agent_creator" when provided',
      },
      {
        payload: { type: 'stop_session', agentId: 42 },
        message: 'stop_session.agentId must be a non-empty string',
      },
      {
        payload: { type: 'resume_session', agentId: '' },
        message: 'resume_session.agentId must be a non-empty string',
      },
      {
        payload: { type: 'delete_session', agentId: null },
        message: 'delete_session.agentId must be a non-empty string',
      },
      {
        payload: { type: 'rename_session', agentId: 'session-a', label: '  ' },
        message: 'rename_session.label must be a non-empty string',
      },
      {
        payload: { type: 'pin_session', agentId: 'session-a', pinned: 'yes' },
        message: 'pin_session.pinned must be a boolean',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: '', projectAgent: null },
        message: 'set_session_project_agent.agentId must be a non-empty string',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: 'session-a', projectAgent: 'bad' },
        message: 'set_session_project_agent.projectAgent must be an object or null',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: 'session-a', projectAgent: {} },
        message: 'set_session_project_agent.projectAgent.whenToUse must be a string',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: 'session-a', projectAgent: { whenToUse: 'x', handle: 42 } },
        message: 'set_session_project_agent.projectAgent.handle must be a string when provided',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: 'session-a', projectAgent: { whenToUse: 'x', handle: 'Release Notes' } },
        message: 'set_session_project_agent.projectAgent.handle must be a normalized non-empty string containing only lowercase letters, numbers, and dashes',
      },
      {
        payload: { type: 'set_session_project_agent', agentId: 'session-a', projectAgent: null, requestId: 42 },
        message: 'set_session_project_agent.requestId must be a string when provided',
      },
      {
        payload: { type: 'request_project_agent_recommendations', agentId: '' },
        message: 'request_project_agent_recommendations.agentId must be a non-empty string',
      },
      {
        payload: { type: 'request_project_agent_recommendations', agentId: 'session-a', requestId: 42 },
        message: 'request_project_agent_recommendations.requestId must be a string when provided',
      },
      {
        payload: { type: 'fork_session', sourceAgentId: '' },
        message: 'fork_session.sourceAgentId must be a non-empty string',
      },
      {
        payload: { type: 'merge_session_memory', agentId: '' },
        message: 'merge_session_memory.agentId must be a non-empty string',
      },
      {
        payload: { type: 'get_session_workers', sessionAgentId: '' },
        message: 'get_session_workers.sessionAgentId must be a non-empty string',
      },
      {
        payload: { type: 'api_proxy', requestId: 'proxy-1', method: 'TRACE', path: '/api/mobile/push/test' },
        message: 'api_proxy.method must be one of GET|POST|PUT|PATCH|DELETE',
      },
      {
        payload: { type: 'api_proxy', requestId: '', method: 'GET', path: '/api/slash-commands' },
        message: 'api_proxy.requestId must be a non-empty string',
      },
      {
        payload: { type: 'api_proxy', requestId: 'proxy-1', method: 'GET', path: 'api/slash-commands' },
        message: 'api_proxy.path must be a non-empty string starting with /',
      },
      {
        payload: { type: 'clear_all_pins', agentId: '  ' },
        message: 'clear_all_pins.agentId must be a non-empty string',
      },
      {
        payload: { type: 'mark_unread', requestId: 'req-unread' },
        message: 'mark_unread.agentId must be a non-empty string',
      },
      {
        payload: { type: 'mark_unread', agentId: '  ' },
        message: 'mark_unread.agentId must be a non-empty string',
      },
      {
        payload: { type: 'mark_unread', agentId: 'manager--s2', requestId: 123 },
        message: 'mark_unread.requestId must be a string when provided',
      },
      {
        payload: { type: 'subscribe', messageCount: 0 },
        message: 'subscribe.messageCount must be a positive finite integer',
      },
      {
        payload: { type: 'subscribe', messageCount: 7.2 },
        message: 'subscribe.messageCount must be a positive finite integer',
      },
      {
        payload: { type: 'subscribe', messageCount: Infinity },
        message: 'subscribe.messageCount must be a positive finite integer',
      },
      {
        payload: { type: 'choice_response', agentId: '', choiceId: 'choice-1', answers: [] },
        message: 'choice_response.agentId must be a non-empty string',
      },
      {
        payload: { type: 'choice_response', agentId: 'manager', choiceId: '', answers: [] },
        message: 'choice_response.choiceId must be a non-empty string',
      },
      {
        payload: { type: 'choice_response', agentId: 'manager', choiceId: 'choice-1', answers: 'bad' },
        message: 'choice_response.answers must be an array of valid ChoiceAnswer objects',
      },
      {
        payload: { type: 'choice_response', agentId: 'manager', choiceId: 'choice-1', answers: [{}] },
        message: 'choice_response.answers must be an array of valid ChoiceAnswer objects',
      },
      {
        payload: { type: 'choice_response', agentId: 'manager', choiceId: 'choice-1', answers: [{ questionId: 'q1', selectedOptionIds: [''] }] },
        message: 'choice_response.answers must be an array of valid ChoiceAnswer objects',
      },
      {
        payload: { type: 'choice_response', agentId: 'manager', choiceId: 'choice-1', answers: [{ questionId: 'q1', selectedOptionIds: [], text: 42 }] },
        message: 'choice_response.answers must be an array of valid ChoiceAnswer objects',
      },
      {
        payload: { type: 'choice_cancel', agentId: '', choiceId: 'choice-1' },
        message: 'choice_cancel.agentId must be a non-empty string',
      },
      {
        payload: { type: 'choice_cancel', agentId: 'manager', choiceId: '' },
        message: 'choice_cancel.choiceId must be a non-empty string',
      },
    ]

    for (const testCase of invalidPayloads) {
      const parsed = parseJsonCommand(testCase.payload)
      expect(parsed).toEqual({ ok: false, error: testCase.message })
    }
  })

  it('parses reorder_profiles with valid payload', () => {
    const parsed = parseJsonCommand({
      type: 'reorder_profiles',
      profileIds: ['profile-b', 'profile-a', 'profile-c'],
      requestId: 'req-reorder',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'reorder_profiles',
        profileIds: ['profile-b', 'profile-a', 'profile-c'],
        requestId: 'req-reorder',
      },
    })
  })

  it('parses reorder_profiles without requestId', () => {
    const parsed = parseJsonCommand({
      type: 'reorder_profiles',
      profileIds: ['profile-a'],
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'reorder_profiles',
        profileIds: ['profile-a'],
        requestId: undefined,
      },
    })
  })

  it('parses reorder_profiles and trims profile ids', () => {
    const parsed = parseJsonCommand({
      type: 'reorder_profiles',
      profileIds: ['  profile-a  ', ' profile-b '],
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'reorder_profiles',
        profileIds: ['profile-a', 'profile-b'],
        requestId: undefined,
      },
    })
  })

  it('rejects reorder_profiles with invalid payloads', () => {
    const invalidPayloads: Array<{ payload: unknown; message: string }> = [
      {
        payload: { type: 'reorder_profiles', profileIds: [] },
        message: 'reorder_profiles.profileIds must be a non-empty array',
      },
      {
        payload: { type: 'reorder_profiles' },
        message: 'reorder_profiles.profileIds must be a non-empty array',
      },
      {
        payload: { type: 'reorder_profiles', profileIds: 'not-array' },
        message: 'reorder_profiles.profileIds must be a non-empty array',
      },
      {
        payload: { type: 'reorder_profiles', profileIds: ['valid', ''] },
        message: 'reorder_profiles.profileIds[1] must be a non-empty string',
      },
      {
        payload: { type: 'reorder_profiles', profileIds: ['valid', 42] },
        message: 'reorder_profiles.profileIds[1] must be a non-empty string',
      },
      {
        payload: { type: 'reorder_profiles', profileIds: ['valid', '  '] },
        message: 'reorder_profiles.profileIds[1] must be a non-empty string',
      },
      {
        payload: { type: 'reorder_profiles', profileIds: ['a', 'b'], requestId: 123 },
        message: 'reorder_profiles.requestId must be a string when provided',
      },
    ]

    for (const testCase of invalidPayloads) {
      const parsed = parseJsonCommand(testCase.payload)
      expect(parsed).toEqual({ ok: false, error: testCase.message })
    }
  })

  it('parses collaboration choice and pin commands', () => {
    expect(parseJsonCommand({
      type: 'collab_choice_response',
      channelId: ' channel-1 ',
      choiceId: ' choice-1 ',
      answers: [
        {
          questionId: 'question-1',
          selectedOptionIds: ['option-1'],
        },
      ],
    })).toEqual({
      ok: true,
      command: {
        type: 'collab_choice_response',
        channelId: 'channel-1',
        choiceId: 'choice-1',
        answers: [
          {
            questionId: 'question-1',
            selectedOptionIds: ['option-1'],
          },
        ],
      },
    })

    expect(parseJsonCommand({
      type: 'collab_pin_message',
      channelId: ' channel-1 ',
      messageId: ' message-1 ',
      pinned: true,
    })).toEqual({
      ok: true,
      command: {
        type: 'collab_pin_message',
        channelId: 'channel-1',
        messageId: 'message-1',
        pinned: true,
      },
    })
  })

  it('rejects malformed collaboration choice and pin commands', () => {
    expect(parseJsonCommand({
      type: 'collab_choice_response',
      channelId: 'channel-1',
      choiceId: 'choice-1',
      answers: 'nope',
    })).toEqual({
      ok: false,
      error: 'collab_choice_response.answers must be an array of valid ChoiceAnswer objects',
    })

    expect(parseJsonCommand({
      type: 'collab_pin_message',
      channelId: 'channel-1',
      messageId: 'message-1',
      pinned: 'yes',
    })).toEqual({
      ok: false,
      error: 'collab_pin_message.pinned must be a boolean',
    })
  })

  it('extracts request ids for new session commands', () => {
    const commands = [
      { type: 'api_proxy', requestId: 'req-proxy', method: 'GET', path: '/api/slash-commands' },
      { type: 'create_session', profileId: 'manager', requestId: 'req-create' },
      { type: 'stop_session', agentId: 'manager--s2', requestId: 'req-stop' },
      { type: 'resume_session', agentId: 'manager--s2', requestId: 'req-resume' },
      { type: 'delete_session', agentId: 'manager--s2', requestId: 'req-delete' },
      { type: 'clear_session', agentId: 'manager--s2', requestId: 'req-clear' },
      { type: 'rename_session', agentId: 'manager--s2', label: 'Renamed', requestId: 'req-rename' },
      { type: 'pin_session', agentId: 'manager--s2', pinned: true, requestId: 'req-pin' },
      { type: 'update_session_model', sessionAgentId: 'manager--s2', mode: 'inherit', requestId: 'req-session-model' },
      {
        type: 'set_session_project_agent',
        agentId: 'manager--s2',
        projectAgent: { whenToUse: 'Coordinate release work' },
        requestId: 'req-project-agent',
      },
      {
        type: 'request_project_agent_recommendations',
        agentId: 'manager--s2',
        requestId: 'req-project-agent-recs',
      },
      { type: 'fork_session', sourceAgentId: 'manager--s2', requestId: 'req-fork' },
      { type: 'merge_session_memory', agentId: 'manager--s2', requestId: 'req-merge' },
      { type: 'get_session_workers', sessionAgentId: 'manager--s2', requestId: 'req-workers' },
      { type: 'mark_unread', agentId: 'manager--s2', requestId: 'req-mark-unread' },
      { type: 'update_manager_model', managerId: 'manager', model: 'pi-5.4', requestId: 'req-update-model' },
      { type: 'update_manager_cwd', managerId: 'manager', cwd: '/tmp/project', requestId: 'req-update-cwd' },
    ] as const

    for (const command of commands) {
      expect(extractRequestId(command)).toBe(command.requestId)
    }

    // reorder_profiles tested separately (readonly array incompatibility with `as const`)
    expect(extractRequestId({
      type: 'reorder_profiles',
      profileIds: ['a', 'b'],
      requestId: 'req-reorder',
    })).toBe('req-reorder')

    expect(extractRequestId({
      type: 'clear_all_pins',
      agentId: 'manager--s2',
    })).toBeUndefined()

    expect(extractRequestId({
      type: 'choice_response',
      agentId: 'manager',
      choiceId: 'choice-1',
      answers: [],
    })).toBeUndefined()

    expect(extractRequestId({
      type: 'choice_cancel',
      agentId: 'manager',
      choiceId: 'choice-1',
    })).toBeUndefined()
  })
})
