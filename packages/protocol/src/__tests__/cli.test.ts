import { describe, expect, it } from 'vitest'
import type { CliCapabilities, CliSessionCompactionResult, CliSessionTranscriptResponse, CliWsCommand } from '../cli.js'

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

    expect(capabilities.features.sessionTranscript).toBe(true)
    expect(capabilities.features.sessionCompaction).toBe(true)
  })

  it('models first-class CLI compaction commands and normalized result DTOs', () => {
    const command = {
      type: 'smart_compact_session',
      requestId: 'compact-1',
      agentId: 'session-a',
      customInstructions: 'Preserve TODOs',
    } satisfies CliWsCommand
    const result = {
      action: 'smart_compact',
      sessionAgentId: 'session-a',
      profileId: 'profile-a',
      outcome: 'skipped',
      compacted: false,
      reason: 'claude_runtime_below_compaction_threshold',
      customInstructionsProvided: true,
      completedAt: '2026-06-22T00:00:00.000Z',
    } satisfies CliSessionCompactionResult

    expect(command.type).toBe('smart_compact_session')
    expect(result.outcome).toBe('skipped')
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

    const json = JSON.stringify(response)
    expect(json).not.toContain('sourceContext')
    expect(json).not.toContain('data')
    expect(json).not.toContain('filePath')
    expect(json).not.toContain('/tmp/')
  })
})
