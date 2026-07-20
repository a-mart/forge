import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  WORK_GRAPH_EFFORTS,
  WORK_GRAPH_NODE_KINDS,
  WORK_GRAPH_NODE_STATUSES,
  type SessionPlanSnapshot,
} from '@forge/protocol'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'
import { MAX_PLAN_EXPLANATION_LENGTH } from './session-plan-state.js'
import {
  DEFAULT_WORK_GRAPH_CONCURRENCY,
  MAX_WORK_GRAPH_ACCEPTANCE_LENGTH,
  MAX_WORK_GRAPH_CONCURRENCY,
  MAX_WORK_GRAPH_ID_LENGTH,
  MAX_WORK_GRAPH_NODES,
  MAX_WORK_GRAPH_TASK_LENGTH,
  MAX_WORK_GRAPH_TITLE_LENGTH,
  type UpdateWorkGraphInput,
} from './work-graph-state.js'

export const UPDATE_WORK_GRAPH_TOOL_NAME = 'update_work_graph'

export interface UpdateWorkGraphResult extends SessionPlanSnapshot {
  sessionAgentId: string
  dispatched: Array<{
    nodeId: string
    workerId: string
    executionPolicy: 'support' | 'routine' | 'deep'
  }>
  dispatchFailures: Array<{ nodeId: string; message: string }>
  cancelledWorkerIds: string[]
}

const nodeStatusSchema = Type.Union(
  WORK_GRAPH_NODE_STATUSES.map((status) => Type.Literal(status)),
  {
    description: 'Desired lifecycle state. New executable work is pending; the runtime owns running, awaiting_review, and blocked transitions; real user gates use waiting; only the manager marks accepted evidence completed.',
  },
)
const nodeKindSchema = Type.Union(
  WORK_GRAPH_NODE_KINDS.map((kind) => Type.Literal(kind)),
  {
    description: 'Semantic outcome kind used for economical routing. Use decision only for a real user gate.',
  },
)
const effortSchema = Type.Union(
  WORK_GRAPH_EFFORTS.map((effort) => Type.Literal(effort)),
  {
    description: 'Risk override for this outcome. Prefer auto; graph size and fan-in do not justify deep.',
  },
)

export const updateWorkGraphToolSchema = Type.Object({
  explanation: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_PLAN_EXPLANATION_LENGTH,
    description: 'Short explanation of why the graph exists or changed.',
  })),
  maxConcurrency: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_WORK_GRAPH_CONCURRENCY,
    default: DEFAULT_WORK_GRAPH_CONCURRENCY,
    description: 'Maximum simultaneously running graph workers. Defaults to 4.',
  })),
  nodes: Type.Array(Type.Object({
    id: Type.String({
      minLength: 1,
      maxLength: MAX_WORK_GRAPH_ID_LENGTH,
      pattern: '^[a-z0-9][a-z0-9_-]*$',
      description: 'Stable lowercase node id. Preserve it across graph revisions and retries.',
    }),
    title: Type.String({
      minLength: 1,
      maxLength: MAX_WORK_GRAPH_TITLE_LENGTH,
      description: 'Concise unique user-visible outcome label.',
    }),
    task: Type.String({
      minLength: 1,
      maxLength: MAX_WORK_GRAPH_TASK_LENGTH,
      description: 'Independently executable worker instruction with bounded context and a concrete deliverable. Do not encode manager narration or trivial actions.',
    }),
    kind: Type.Optional(nodeKindSchema),
    status: nodeStatusSchema,
    dependsOn: Type.Optional(Type.Array(Type.String({
      minLength: 1,
      maxLength: MAX_WORK_GRAPH_ID_LENGTH,
    }), {
      uniqueItems: true,
      description: 'Node ids whose manager-accepted results are true readiness prerequisites. Related work does not automatically require an edge.',
    })),
    acceptanceCriteria: Type.Optional(Type.String({
      minLength: 1,
      maxLength: MAX_WORK_GRAPH_ACCEPTANCE_LENGTH,
      description: 'Smallest manager-verifiable check that proves this independently acceptable outcome before marking it completed.',
    })),
    effort: Type.Optional(effortSchema),
  }, { additionalProperties: false }), {
    minItems: 1,
    maxItems: MAX_WORK_GRAPH_NODES,
    description: 'Complete desired graph. Use the smallest DAG that preserves real parallel readiness and dependencies; avoid ceremonial nodes and overlapping ownership.',
  }),
}, { additionalProperties: false })

export function buildUpdateWorkGraphTool(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
): ToolDefinition {
  return {
    name: UPDATE_WORK_GRAPH_TOOL_NAME,
    label: 'Update Work Graph',
    description: [
      'Create or revise executable coordination only when all three eligibility conditions hold: at least two independently dispatchable and verifiable outcomes, a real scheduling relationship, and expected benefit beyond coordination cost.',
      'A good graph is the smallest dependency graph that preserves meaningful parallelism, accepted-result dependencies, fan-in, retry, or a real user gate.',
      'Task size, step count, planning, review, thoroughness, or worker count alone is not a reason to call this tool.',
      'When risk warrants a distinct implement-then-independent-review handoff, encode that dependency here instead of combining update_plan with manual spawn_agent calls.',
      'For simple requests use no coordination tool; for a short visible checklist use update_plan.',
      'If one bounded planning investigation must happen before the graph is knowable, run and accept that delegation first; do not create speculative downstream nodes.',
      'Forge automatically dispatches ready non-decision nodes and chooses economical models from node kind, explicit risk overrides, and blocked-attempt history.',
      'Use effort=auto unless a concrete risk requires an override.',
      'Worker success moves a node to awaiting_review; personally accept its result, then submit the complete graph with that node completed to release dependents.',
      'Use waiting decision nodes for user gates. Re-submit a blocked node as pending to retry it; a blocked retry auto-escalates.',
    ].join(' '),
    parameters: updateWorkGraphToolSchema,
    async execute(toolCallId, params) {
      const result = await host.updateWorkGraph(
        descriptor.agentId,
        toolCallId,
        params as UpdateWorkGraphInput,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      }
    },
  }
}
