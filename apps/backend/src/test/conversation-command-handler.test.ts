import { describe, expect, it, vi } from 'vitest'
import { handleConversationCommand } from '../ws/commands/conversation-command-handler.js'

const workerOwnedPendingChoice = {
  agentId: 'worker-1',
  sessionAgentId: 'manager-1',
  questions: [
    {
      id: 'q1',
      question: 'Pick one',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
    },
  ],
}

const managerOwnedPendingChoice = {
  agentId: 'manager-1',
  sessionAgentId: 'manager-1',
  questions: workerOwnedPendingChoice.questions,
}

function createContext(overrides: {
  command: Parameters<typeof handleConversationCommand>[0]['command']
  subscribedAgentId: string
  pendingChoice?: typeof workerOwnedPendingChoice | null
}) {
  const send = vi.fn()
  const logDebug = vi.fn()
  const resolveChoiceRequest = vi.fn()
  const cancelChoiceRequest = vi.fn()
  const getPendingChoice = vi.fn(() =>
    overrides.pendingChoice === null ? undefined : (overrides.pendingChoice ?? workerOwnedPendingChoice),
  )

  return {
    send,
    logDebug,
    resolveChoiceRequest,
    cancelChoiceRequest,
    getPendingChoice,
    context: {
      command: overrides.command,
      socket: {} as never,
      subscribedAgentId: overrides.subscribedAgentId,
      swarmManager: {
        getPendingChoice,
        resolveChoiceRequest,
        cancelChoiceRequest,
      } as never,
      allowNonManagerSubscriptions: true,
      send,
      logDebug,
      resolveConfiguredManagerId: vi.fn(() => 'manager-1'),
    },
  }
}

describe('handleConversationCommand choice owner/session semantics', () => {
  it('resolves a worker-owned pending choice when manager session responds with agentId=manager', async () => {
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'] }]
    const { context, resolveChoiceRequest, send } = createContext({
      subscribedAgentId: 'manager-1',
      command: {
        type: 'choice_response',
        agentId: 'manager-1',
        choiceId: 'choice-worker-1',
        answers,
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(resolveChoiceRequest).toHaveBeenCalledWith('choice-worker-1', answers)
    expect(send).not.toHaveBeenCalled()
  })

  it('cancels a worker-owned pending choice when manager session cancels with agentId=manager', async () => {
    const { context, cancelChoiceRequest, send } = createContext({
      subscribedAgentId: 'manager-1',
      command: {
        type: 'choice_cancel',
        agentId: 'manager-1',
        choiceId: 'choice-worker-1',
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(cancelChoiceRequest).toHaveBeenCalledWith('choice-worker-1', 'cancelled')
    expect(send).not.toHaveBeenCalled()
  })

  it('still accepts the legacy direct worker owner path', async () => {
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'] }]
    const { context, resolveChoiceRequest, send } = createContext({
      subscribedAgentId: 'worker-1',
      command: {
        type: 'choice_response',
        agentId: 'worker-1',
        choiceId: 'choice-worker-1',
        answers,
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(resolveChoiceRequest).toHaveBeenCalledWith('choice-worker-1', answers)
    expect(send).not.toHaveBeenCalled()
  })

  it('still accepts manager-owned pending choices on the manager session target', async () => {
    const answers = [{ questionId: 'q1', selectedOptionIds: ['a'] }]
    const { context, resolveChoiceRequest, send } = createContext({
      subscribedAgentId: 'manager-1',
      pendingChoice: managerOwnedPendingChoice,
      command: {
        type: 'choice_response',
        agentId: 'manager-1',
        choiceId: 'choice-manager-1',
        answers,
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(resolveChoiceRequest).toHaveBeenCalledWith('choice-manager-1', answers)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects unrelated manager/session targets even when choiceId is valid', async () => {
    const { context, resolveChoiceRequest, send } = createContext({
      subscribedAgentId: 'manager-2',
      command: {
        type: 'choice_response',
        agentId: 'manager-2',
        choiceId: 'choice-worker-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(resolveChoiceRequest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'error',
      code: 'CHOICE_OWNER_MISMATCH',
    }))
  })

  it('rejects when subscribedAgentId does not match command.agentId', async () => {
    const { context, resolveChoiceRequest, getPendingChoice, send } = createContext({
      subscribedAgentId: 'manager-1',
      command: {
        type: 'choice_response',
        agentId: 'worker-1',
        choiceId: 'choice-worker-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['a'] }],
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(getPendingChoice).not.toHaveBeenCalled()
    expect(resolveChoiceRequest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'error',
      code: 'CHOICE_SUBSCRIPTION_MISMATCH',
    }))
  })

  it('does not resolve invalid answers and leaves the pending choice intact', async () => {
    const { context, resolveChoiceRequest, getPendingChoice, send } = createContext({
      subscribedAgentId: 'manager-1',
      command: {
        type: 'choice_response',
        agentId: 'manager-1',
        choiceId: 'choice-worker-1',
        answers: [{ questionId: 'q1', selectedOptionIds: ['a', 'b'] }],
      } as never,
    })

    await expect(handleConversationCommand(context)).resolves.toBe(true)
    expect(resolveChoiceRequest).not.toHaveBeenCalled()
    expect(getPendingChoice('choice-worker-1')).toEqual(workerOwnedPendingChoice)
    expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'error',
      code: 'CHOICE_INVALID_RESPONSE',
    }))
  })
})
