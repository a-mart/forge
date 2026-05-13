import { describe, expect, it, vi } from 'vitest'
import { handleConversationCommand } from '../ws/commands/conversation-command-handler.js'
import { CollabCommandHandler } from '../ws/commands/collab-command-handler.js'

const pendingChoice = {
  agentId: 'manager',
  sessionAgentId: 'manager',
  questions: [
    {
      id: 'q1',
      question: 'Pick one',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    },
  ],
}

describe('choice answer ingress validation', () => {
  it('rejects invalid web choice responses without resolving the pending choice', async () => {
    const send = vi.fn()
    const swarmManager = {
      getPendingChoice: vi.fn(() => pendingChoice),
      resolveChoiceRequest: vi.fn(),
      cancelChoiceRequest: vi.fn(),
    }

    const handled = await handleConversationCommand({
      command: {
        type: 'choice_response',
        agentId: 'manager',
        choiceId: 'choice-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['yes', 'no'] }],
      } as never,
      socket: {} as never,
      subscribedAgentId: 'manager',
      swarmManager: swarmManager as never,
      allowNonManagerSubscriptions: true,
      send,
      logDebug: vi.fn(),
      resolveConfiguredManagerId: vi.fn(() => 'manager'),
    })

    expect(handled).toBe(true)
    expect(swarmManager.resolveChoiceRequest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'error',
      code: 'CHOICE_INVALID_RESPONSE',
    }))
    expect(swarmManager.getPendingChoice('choice-1')).toBeTruthy()
  })

  it('rejects invalid collaboration choice responses without resolving the pending choice', async () => {
    const send = vi.fn()
    const swarmManager = {
      getPendingChoice: vi.fn(() => pendingChoice),
      resolveChoiceRequest: vi.fn(),
    }
    const handler = new CollabCommandHandler(
      swarmManager as never,
      { registerSocket: vi.fn() } as never,
      send,
      vi.fn() as never,
    )
    ;(handler as unknown as { requireWritableChannel: () => Promise<{ sessionAgentId: string; archived: boolean }> }).requireWritableChannel =
      async () => ({ sessionAgentId: 'manager', archived: false })

    await handler.handleCommand(
      {} as never,
      { userId: 'user-1', email: 'user@example.com', name: 'User', role: 'admin', disabled: false } as never,
      {
        type: 'collab_choice_response',
        channelId: 'channel-1',
        choiceId: 'choice-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['yes', 'no'] }],
      } as never,
    )

    expect(swarmManager.resolveChoiceRequest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'error',
      code: 'CHOICE_INVALID_RESPONSE',
    }))
    expect(swarmManager.getPendingChoice('choice-1')).toBeTruthy()
  })
})
