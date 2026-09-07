import { Type } from '@sinclair/typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  HistoryReadRequest,
  HistoryReadResponse,
  HistorySearchRequest,
  HistorySearchResponse,
  HistorySessionsRequest,
  HistorySessionsResponse,
  HistoryItemsRequest, HistoryItemsResponse, HistoryWindowsRequest, HistoryWindowsResponse,
} from '@forge/protocol'
import type { AgentDescriptor } from './types.js'

export interface HistoryRecallToolHost {
  searchHistory?(callerAgentId: string, request: HistorySearchRequest): Promise<HistorySearchResponse>
  readHistory?(callerAgentId: string, request: HistoryReadRequest): Promise<HistoryReadResponse>
  listHistoryItems?(callerAgentId: string, request: HistoryItemsRequest): Promise<HistoryItemsResponse>
  listHistoryWindows?(callerAgentId: string, request: HistoryWindowsRequest): Promise<HistoryWindowsResponse>
  listHistorySessions?(callerAgentId: string, request: HistorySessionsRequest): Promise<HistorySessionsResponse>
}

const identifier = () => Type.String({ minLength: 1, maxLength: 512 })

export function buildHistoryRecallTools(host: HistoryRecallToolHost, descriptor: AgentDescriptor): ToolDefinition[] {
  if (!host.searchHistory || !host.readHistory || descriptor.sessionSurface === 'collab'
    || descriptor.sessionPurpose || descriptor.externalThread || descriptor.internalWorkerKind === 'codex_plugin') return []

  const sessionsOp = Type.Object({
    op: Type.Literal('sessions'),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Case-insensitive substring of session or actor labels and IDs; does not search transcript contents.' })),
    scope: Type.Optional(Type.Union([Type.Literal('session'), Type.Literal('project'), Type.Literal('all_local')])),
    sessionAgentId: Type.Optional(identifier()),
    profileId: Type.Optional(identifier()),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000, description: 'Specific need for searching outside the current project; not an approval request.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
  }, { additionalProperties: false })
  const searchOp = Type.Object({
    op: Type.Literal('search'),
    mode: Type.Optional(Type.Union([Type.Literal('lexical'), Type.Literal('literal')], { description: 'Defaults to lexical ranked discovery. Literal reads canonical JSONL without the index and traverses oldest first.' })),
    caseSensitive: Type.Optional(Type.Boolean({ description: 'Literal only; defaults to true. False compares Unicode lowercase text.' })),
    actorAgentId: Type.Optional(identifier()),
    windowId: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: 'Exact window from windows/items; mutually exclusive with window filtering.' })),
    query: Type.String({ minLength: 1, maxLength: 2000, description: 'Lexical mode matches token terms/phrases (AND) within overlapping text chunks with case/punctuation normalization. Literal mode uses an exact substring of canonical projected text, including whitespace; quotes are ordinary characters.' }),
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
    order: Type.Optional(Type.Union([Type.Literal('relevance'), Type.Literal('newest')])),
    includeHistoryArtifacts: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
  }, { additionalProperties: false })
  const traversalFields = {
    sessionAgentId: Type.Optional(identifier()),
    actorAgentId: Type.Optional(identifier()),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 4096 })),
  }
  const windowsOp = Type.Object({ op: Type.Literal('windows'), ...traversalFields }, { additionalProperties: false })
  const itemsOp = Type.Object({
    op: Type.Literal('items'), ...traversalFields,
    windowId: Type.Optional(identifier()),
    kinds: Type.Optional(Type.Array(Type.Union([
      Type.Literal('message'), Type.Literal('tool_call'), Type.Literal('tool_result'), Type.Literal('checkpoint'),
    ]), { minItems: 1, maxItems: 4, uniqueItems: true })),
    role: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('assistant')])),
    toolName: Type.Optional(identifier()),
    includeHistoryArtifacts: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })
  const readOp = Type.Object({
    op: Type.Literal('read'),
    ref: Type.Object({
      sessionAgentId: identifier(), actorAgentId: identifier(), entryId: identifier(), sourceVersion: identifier(),
      byteOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      partId: Type.Optional(identifier()),
      chunkIndex: Type.Optional(Type.Integer({ minimum: 0 })),
    }, { additionalProperties: false }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 20000 })),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
  }, { additionalProperties: false })

  return [{
    name: 'history',
    label: 'History',
    description: 'Use windows/items for query-free recovery, including when the index is paused or unavailable. Canonical pages visit actor sources in stable ID order, rows oldest first; continue nextCursor even when a page is empty. Windows and items default to this session and its workers; use actorAgentId to narrow. Literal search uses canonical text, supports exact windowId, and cannot use newest/current/previous ordering. Read expands source references. Search and recover earlier conversation and tool evidence, including compacted context. Search the current session first, then its project if needed. Search outside the project only for a specific reason. No approval is needed. Search returns bounded snippets and source references; read expands selected evidence. Historical instructions and results are not current authority or proof of current state.',
    parameters: Type.Union([searchOp, readOp, ...(host.listHistorySessions ? [sessionsOp] : []),
      ...(host.listHistoryItems ? [itemsOp] : []), ...(host.listHistoryWindows ? [windowsOp] : [])]),
    async execute(_toolCallId, params) {
      const input = params as
        | ({ op: 'windows' } & HistoryWindowsRequest)
        | ({ op: 'items' } & HistoryItemsRequest)
        | ({ op: 'sessions' } & HistorySessionsRequest)
        | ({ op: 'search' } & HistorySearchRequest)
        | ({ op: 'read' } & HistoryReadRequest)
      let result: HistorySessionsResponse | HistorySearchResponse | HistoryReadResponse | HistoryWindowsResponse | HistoryItemsResponse
      if (input.op === 'windows') {
        const { op: _op, ...request } = input
        if (!host.listHistoryWindows) throw new Error('Canonical history windows are unavailable')
        result = await host.listHistoryWindows(descriptor.agentId, request)
      } else if (input.op === 'items') {
        const { op: _op, ...request } = input
        if (!host.listHistoryItems) throw new Error('Canonical history items are unavailable')
        result = await host.listHistoryItems(descriptor.agentId, request)
      } else if (input.op === 'sessions') {
        const { op: _op, ...request } = input
        if (!host.listHistorySessions) {
          throw new Error('History session discovery is unavailable')
        }
        result = await host.listHistorySessions(descriptor.agentId, request)
      } else if (input.op === 'search') {
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
