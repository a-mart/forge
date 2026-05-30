import { describe, expect, it } from 'vitest'

import { isCodexExternalThread, shouldExcludeConversationMessageFromModelContext } from '../external-threads'

describe('external-threads UI helpers', () => {
  it('re-exports Codex external thread detection from protocol', () => {
    expect(
      isCodexExternalThread({
        externalThread: {
          type: 'codex_app_server',
          persisted: true,
          createdByMention: true,
        },
      }),
    ).toBe(true)
  })

  it('re-exports model-context exclusion helper from protocol', () => {
    expect(
      shouldExcludeConversationMessageFromModelContext({
        externalThreadContext: {
          type: 'codex_app_server',
          sidecarAgentId: 'session-1--codex',
          requestId: 'req-1',
          turnCorrelationId: 'turn-1',
          status: 'completed',
          excludeFromModelContext: true,
        },
      }),
    ).toBe(true)
  })
})
