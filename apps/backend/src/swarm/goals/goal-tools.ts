import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SessionGoalSnapshot } from '@forge/protocol'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'
import { MAX_GOAL_OBJECTIVE_LENGTH, MAX_GOAL_TOKEN_BUDGET } from './session-goal-state.js'

export const CREATE_GOAL_TOOL_NAME = 'create_goal'
export const GET_GOAL_TOOL_NAME = 'get_goal'
export const UPDATE_GOAL_TOOL_NAME = 'update_goal'

export interface CreateGoalInput {
  objective: string
  tokenBudget?: number
}

export interface UpdateGoalInput {
  status: 'complete' | 'blocked'
}

export function buildGoalTools(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  return [
    {
      name: CREATE_GOAL_TOOL_NAME,
      label: 'Create Goal',
      description:
        'Start one durable goal for this session only when the user explicitly asks for sustained goal pursuit. The goal can span turns and multiple working plans. Do not infer goals from ordinary tasks. Set tokenBudget only when the user explicitly requests a token limit.',
      parameters: Type.Object({
        objective: Type.String({
          minLength: 1,
          maxLength: MAX_GOAL_OBJECTIVE_LENGTH,
          description: 'The concrete outcome to keep pursuing.',
        }),
        tokenBudget: Type.Optional(Type.Integer({
          minimum: 1,
          maximum: MAX_GOAL_TOKEN_BUDGET,
          description: 'Optional token limit explicitly requested by the user.',
        })),
      }, { additionalProperties: false }),
      async execute(toolCallId, params) {
        const result = await host.createGoal(
          descriptor.agentId,
          toolCallId,
          params as CreateGoalInput,
        )
        return toolResult(result)
      },
    },
    {
      name: GET_GOAL_TOOL_NAME,
      label: 'Get Goal',
      description:
        'Read the current goal, including status, elapsed active time, token usage, remaining budget, and goal-turn count.',
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return toolResult(await host.getGoal(descriptor.agentId))
      },
    },
    {
      name: UPDATE_GOAL_TOOL_NAME,
      label: 'Update Goal',
      description:
        'Mark the current goal complete only when its outcome is genuinely achieved. Mark it blocked only after the same blocking condition has persisted for at least three goal turns and no meaningful safe progress remains. Resuming a blocked goal starts a fresh three-turn blocking audit. Difficulty, uncertainty, or an exhausted budget are not blockers.',
      parameters: Type.Object({
        status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]),
      }, { additionalProperties: false }),
      async execute(toolCallId, params) {
        const result = await host.updateGoal(
          descriptor.agentId,
          toolCallId,
          params as UpdateGoalInput,
        )
        return toolResult(result)
      },
    },
  ]
}

function toolResult(result: SessionGoalSnapshot) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    details: result,
  }
}
