import { describe, expect, it } from 'vitest'
import { extractRequestId, parseClientCommand } from '../ws/ws-command-parser.js'

function parseJsonCommand(payload: unknown) {
  return parseClientCommand(Buffer.from(JSON.stringify(payload), 'utf8'))
}

describe('ws command parser session commands', () => {
  it('parses create_session and normalizes optional label', () => {
    const parsed = parseJsonCommand({
      type: 'create_session',
      profileId: ' manager ',
      label: '  Focus work  ',
      requestId: 'req-1',
    })

    expect(parsed).toEqual({
      ok: true,
      command: {
        type: 'create_session',
        profileId: 'manager',
        label: 'Focus work',
        requestId: 'req-1',
      },
    })
  })

  it('parses all session lifecycle commands', () => {
    const commands = [
      { type: 'stop_session', agentId: 'session-a', requestId: 'req-stop' },
      { type: 'resume_session', agentId: 'session-a', requestId: 'req-resume' },
      { type: 'delete_session', agentId: 'session-a', requestId: 'req-delete' },
      { type: 'rename_session', agentId: 'session-a', label: 'Renamed', requestId: 'req-rename' },
      { type: 'fork_session', sourceAgentId: 'session-a', label: 'Forked', requestId: 'req-fork' },
      { type: 'merge_session_memory', agentId: 'session-a', requestId: 'req-merge' },
    ] as const

    for (const command of commands) {
      const parsed = parseJsonCommand(command)
      expect(parsed).toEqual({ ok: true, command })
    }
  })

  it('rejects invalid session command payloads', () => {
    const invalidPayloads: Array<{ payload: unknown; message: string }> = [
      {
        payload: { type: 'create_session', profileId: '' },
        message: 'create_session.profileId must be a non-empty string',
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
        payload: { type: 'fork_session', sourceAgentId: '' },
        message: 'fork_session.sourceAgentId must be a non-empty string',
      },
      {
        payload: { type: 'merge_session_memory', agentId: '' },
        message: 'merge_session_memory.agentId must be a non-empty string',
      },
    ]

    for (const testCase of invalidPayloads) {
      const parsed = parseJsonCommand(testCase.payload)
      expect(parsed).toEqual({ ok: false, error: testCase.message })
    }
  })

  it('extracts request ids for new session commands', () => {
    const commands = [
      { type: 'create_session', profileId: 'manager', requestId: 'req-create' },
      { type: 'stop_session', agentId: 'manager--s2', requestId: 'req-stop' },
      { type: 'resume_session', agentId: 'manager--s2', requestId: 'req-resume' },
      { type: 'delete_session', agentId: 'manager--s2', requestId: 'req-delete' },
      { type: 'rename_session', agentId: 'manager--s2', label: 'Renamed', requestId: 'req-rename' },
      { type: 'fork_session', sourceAgentId: 'manager--s2', requestId: 'req-fork' },
      { type: 'merge_session_memory', agentId: 'manager--s2', requestId: 'req-merge' },
    ] as const

    for (const command of commands) {
      expect(extractRequestId(command)).toBe(command.requestId)
    }
  })
})
