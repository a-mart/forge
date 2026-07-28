import { describe, expect, it } from 'vitest'
import {
  CLI_EXIT_CODES,
  CLI_PROTOCOL_VERSION,
  type CliCapabilities,
  type CliSessionCompactionResult,
  type CliSessionTranscriptResponse,
  type CliWsCommand,
} from '../cli.js'

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('CLI protocol DTOs', () => {
  it('includes the additive session transcript feature flag', () => {
    const capabilities: CliCapabilities = {
      protocolVersion: 1,
      minCliVersion: '0.1.0',
      available: true,
      runtimeTarget: 'builder',
      features: {
        bearerAuth: true,
        headlessWs: true,
        cliSourceContext: true,
        cliSessionMetadata: true,
        choiceOwnerLookup: true,
        activeToolSnapshot: true,
        projectAgentRunTarget: true,
        sessionTranscript: true,
        sessionCompaction: true,
        builderRuntimeOnly: true,
      },
    }

    const wireCapabilities = roundTrip(capabilities)
    expect(wireCapabilities).toEqual(capabilities)
    expect(wireCapabilities.protocolVersion).toBe(CLI_PROTOCOL_VERSION)
    expect(wireCapabilities.features.sessionTranscript).toBe(true)
    expect(wireCapabilities.features.sessionCompaction).toBe(true)
    expect(CLI_EXIT_CODES.success).toBe(0)
  })

  it('models first-class CLI compaction commands and normalized result DTOs', () => {
    const command: CliWsCommand = {
      type: 'smart_compact_session',
      requestId: 'compact-1',
      agentId: 'session-a',
      customInstructions: 'Preserve TODOs',
    }
    const result: CliSessionCompactionResult = {
      action: 'smart_compact',
      sessionAgentId: 'session-a',
      profileId: 'profile-a',
      outcome: 'skipped',
      compacted: false,
      reason: 'claude_runtime_below_compaction_threshold',
      customInstructionsProvided: true,
      completedAt: '2026-06-22T00:00:00.000Z',
    }
    const wireCommand = roundTrip(command)
    const wireResult = roundTrip(result)

    expect(wireCommand).toEqual(command)
    expect(wireResult).toEqual(result)
    expect(wireCommand.type).toBe('smart_compact_session')
    expect(wireResult.outcome).toBe('skipped')
  })

  it('models transcript responses without raw source context or attachment bodies', () => {
    const response: CliSessionTranscriptResponse = {
      session: { agentId: 'session-a', profileId: 'profile-a', displayName: 'Session A' },
      options: { includeWorkerUpdates: true, limit: 200, offset: 0 },
      page: { total: 2, returned: 2, offset: 0, limit: 200, hasMore: false },
      messages: [
        {
          ordinal: 0,
          id: 'message-1',
          timestamp: '2026-06-15T00:00:00.000Z',
          kind: 'user',
          role: 'user',
          source: 'user_input',
          text: 'hello',
          agentId: 'session-a',
          attachments: [
            {
              type: 'image',
              mimeType: 'image/png',
              fileName: 'image.png',
              fileRef: 'upload-ref',
              sizeBytes: 123,
            },
          ],
        },
        {
          ordinal: 1,
          timestamp: '2026-06-15T00:00:01.000Z',
          kind: 'worker_update',
          role: 'worker',
          source: 'worker_update',
          text: 'status: done',
          agentId: 'session-a',
          fromAgentId: 'worker-a',
          fromDisplayName: 'Backend Specialist',
          toAgentId: 'session-a',
        },
      ],
    }

    const wireResponse = roundTrip(response)
    const json = JSON.stringify(wireResponse)
    expect(wireResponse).toEqual(response)
    expect(json).not.toContain('sourceContext')
    expect(json).not.toContain('data')
    expect(json).not.toContain('filePath')
    expect(json).not.toContain('/tmp/')
  })
})
