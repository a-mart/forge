import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { SwarmToolHost } from '../swarm-tool-host.js'
import type { AgentDescriptor } from '../types.js'
import type { UpdateWorkGraphResult } from './update-work-graph-tool.js'
import {
  MAX_WORK_GRAPH_ACCEPTANCE_LENGTH,
  MAX_WORK_GRAPH_ID_LENGTH,
} from './work-graph-state.js'

export const ACCEPT_WORK_GRAPH_NODE_TOOL_NAME = 'accept_work_graph_node'

export interface AcceptWorkGraphNodeInput {
  nodeId: string
  evidence: string
}

export interface AcceptWorkGraphNodeResult extends UpdateWorkGraphResult {
  acceptedNodeId: string
  alreadyAccepted: boolean
}

export const acceptWorkGraphNodeToolSchema = Type.Object({
  nodeId: Type.String({
    minLength: 1,
    maxLength: MAX_WORK_GRAPH_ID_LENGTH,
    pattern: '^[a-z0-9][a-z0-9_-]*$',
    description: 'Stable id of the awaiting_review node whose result the manager verified.',
  }),
  evidence: Type.String({
    minLength: 1,
    maxLength: MAX_WORK_GRAPH_ACCEPTANCE_LENGTH,
    description: 'Concise evidence from the manager acceptance check. A worker completion claim alone is not sufficient.',
  }),
}, { additionalProperties: false })

export function normalizeAcceptWorkGraphNodeInput(
  input: AcceptWorkGraphNodeInput,
): AcceptWorkGraphNodeInput {
  const nodeId = input.nodeId.trim()
  if (
    nodeId.length === 0
    || nodeId.length > MAX_WORK_GRAPH_ID_LENGTH
    || !/^[a-z0-9][a-z0-9_-]*$/.test(nodeId)
  ) {
    throw new Error('nodeId must be a valid stable work-graph node id.')
  }
  const evidence = input.evidence.trim()
  if (evidence.length === 0 || evidence.length > MAX_WORK_GRAPH_ACCEPTANCE_LENGTH) {
    throw new Error(
      `evidence must contain between 1 and ${MAX_WORK_GRAPH_ACCEPTANCE_LENGTH} characters.`,
    )
  }
  return { nodeId, evidence }
}

export function buildAcceptWorkGraphNodeTool(
  host: SwarmToolHost,
  descriptor: AgentDescriptor,
): ToolDefinition {
  return {
    name: ACCEPT_WORK_GRAPH_NODE_TOOL_NAME,
    label: 'Accept Work Graph Node',
    description: [
      'Accept one successful work-graph result after personally performing the smallest check required by its acceptance criteria.',
      'The node must be awaiting_review. Forge changes only that node to completed and automatically releases newly ready dependents.',
      'Do not use this tool to revise graph topology, retry blocked work, resolve a user gate, or accept a worker claim without verification.',
    ].join(' '),
    parameters: acceptWorkGraphNodeToolSchema,
    async execute(toolCallId, params) {
      const result = await host.acceptWorkGraphNode(
        descriptor.agentId,
        toolCallId,
        params as AcceptWorkGraphNodeInput,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        details: result,
      }
    },
  }
}
