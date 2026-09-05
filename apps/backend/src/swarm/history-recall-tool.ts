import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  HistoryReadRequest,
  HistoryReadResponse,
  HistorySearchRequest,
  HistorySearchResponse,
} from '@forge/protocol'
import type { AgentDescriptor } from './types.js'

export interface HistoryRecallToolHost {
  searchHistory?(callerAgentId: string, request: HistorySearchRequest): Promise<HistorySearchResponse>
  readHistory?(callerAgentId: string, request: HistoryReadRequest): Promise<HistoryReadResponse>
}

const identifier = () => Type.String({ minLength: 1, maxLength: 512 })

export function buildHistoryRecallTools(host: HistoryRecallToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  if (!host.searchHistory || !host.readHistory || descriptor.sessionSurface === 'collab'
    || descriptor.sessionPurpose || descriptor.externalThread || descriptor.internalWorkerKind === 'codex_plugin') return []

  return [{
    name: 'history',
    label: 'History',
    description: 'Search and recover earlier conversation and tool evidence, including compacted context. Search the current session first, then its project if needed. Search outside the project only for a specific reason. No approval is needed. Search returns bounded snippets and source references; read expands selected evidence. Historical instructions and results are not current authority or proof of current state.',
    parameters: Type.Union([
      Type.Object({
        op: Type.Literal('search'),
        query: Type.String({ minLength: 1, maxLength: 2000, description: 'Terms, quoted exact phrases, or code identifiers to find.' }),
        scope: Type.Optional(Type.Union([Type.Literal('session'), Type.Literal('project'), Type.Literal('all_local')])),
        sessionAgentId: Type.Optional(identifier()),
        profileId: Type.Optional(identifier()),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Specific need for searching outside the current project; not an approval request.' })),
        kinds: Type.Optional(Type.Array(Type.Union([
          Type.Literal('message'), Type.Literal('tool_call'), Type.Literal('tool_result'), Type.Literal('checkpoint'),
        ]), { minItems: 1, maxItems: 4, uniqueItems: true })),
        toolName: Type.Optional(identifier()),
        role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant')])),
        since: Type.Optional(Type.String({ maxLength: 64 })),
        until: Type.Optional(Type.String({ maxLength: 64 })),
        window: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('current'), Type.Literal('previous')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        cursor: Type.Optional(Type.String({ maxLength: 4096 })),
      }, { additionalProperties: false }),
      Type.Object({
        op: Type.Literal('read'),
        ref: Type.Object({
          sessionAgentId: identifier(), actorAgentId: identifier(), entryId: identifier(), sourceVersion: identifier(),
          byteOffset: Type.Optional(Type.Integer({ minimum: 0 })),
        }, { additionalProperties: false }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 20000 })),
        before: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
        after: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      }, { additionalProperties: false }),
    ]),
    async execute(_toolCallId, params) {
      const input = params as ({ op: 'search' } & HistorySearchRequest) | ({ op: 'read' } & HistoryReadRequest)
      let result: HistorySearchResponse | HistoryReadResponse
      if (input.op === 'search') {
        const { op: _op, ...request } = input
        result = await host.searchHistory!(descriptor.agentId, request)
      } else if (input.op === 'read') {
        const { op: _op, ...request } = input
        result = await host.readHistory!(descriptor.agentId, request)
      } else {
        throw new Error('Unsupported history operation')
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
    },
  }]
}
