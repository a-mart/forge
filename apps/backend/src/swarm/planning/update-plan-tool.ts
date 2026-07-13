import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { PlanStep, SessionPlanSnapshot } from '@forge/protocol'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'
import {
  MAX_PLAN_EXPLANATION_LENGTH,
  MAX_PLAN_STEP_LENGTH,
  MAX_PLAN_STEPS,
} from './session-plan-state.js'

export const UPDATE_PLAN_TOOL_NAME = 'update_plan'

export interface UpdatePlanInput {
  explanation?: string
  plan: PlanStep[]
}

export interface UpdatePlanResult extends SessionPlanSnapshot {
  sessionAgentId: string
}

export const updatePlanToolSchema = Type.Object({
  explanation: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_PLAN_EXPLANATION_LENGTH,
    description: 'Optional short explanation of why the plan changed.',
  })),
  plan: Type.Array(Type.Object({
    step: Type.String({
      minLength: 1,
      maxLength: MAX_PLAN_STEP_LENGTH,
      description: 'A concise, verifiable unit of work. Keep step text distinct within the plan so worker attribution is unambiguous.',
    }),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('in_progress'),
      Type.Literal('completed'),
    ]),
  }, { additionalProperties: false }), {
    maxItems: MAX_PLAN_STEPS,
    description: 'The complete current plan. Mark every step with work actively underway as in_progress.',
  }),
}, { additionalProperties: false })

export function buildUpdatePlanTool(host: SwarmToolHost, descriptor: AgentDescriptor): ToolDefinition {
  return {
    name: UPDATE_PLAN_TOOL_NAME,
    label: 'Update Plan',
    description:
      'Create or replace the current working plan for this session. Use it for substantial multi-step work, not simple requests. Keep steps concise and verifiable, mark every concurrently active step in_progress, and mark steps completed only after the work is actually done. The plan records coordination state; it does not perform the work.',
    parameters: updatePlanToolSchema,
    async execute(toolCallId, params) {
      const result = await host.updatePlan(descriptor.agentId, toolCallId, params as UpdatePlanInput)
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      }
    },
  }
}
