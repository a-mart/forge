import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
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
    requestedRoute: string
    resolvedRouteId?: string
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
    route: Type.Optional(Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^(auto|[a-z0-9][a-z0-9-]{0,63})$',
      description: 'Named specialist from the active roster. Omit for the node kind default; name one only when its guidance clearly fits.',
    })),
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
      'Submit the smallest dependency graph that preserves useful readiness; task size, thoroughness, or worker count alone is not a reason to use it.',
      'If one bounded planning investigation is needed before the graph is knowable, accept that result first and do not create speculative downstream nodes.',
      'Forge automatically dispatches ready non-decision nodes. Do not combine graph-owned work with update_plan or manual spawn_agent calls.',
      'Worker success moves a node to awaiting_review; personally verify its result, then use accept_work_graph_node to complete only that node and release dependents.',
      'Use waiting decision nodes for user gates. Re-submit a blocked node as pending to retry it; Forge uses the prior route capability-escalation target when one was configured.',
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
