import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  HISTORY_CATALOG_HYDRATION,
  HISTORY_COVERAGE_STATES,
  HISTORY_ENTRY_KINDS,
  HISTORY_SEARCH_ORDERS,
  HISTORY_SEARCH_SCOPES,
  HISTORY_SNAPSHOT_ERROR_CODES,
  type HistoryCatalogSnapshot,
  type HistoryCoverage,
  type HistoryEntryReference,
  type HistoryReadRequest,
  type HistorySearchRequest,
  type HistorySearchResponse,
  type HistorySessionsRequest,
  type HistoryItemsRequest, type HistoryWindowsRequest, type HistoryWindowsResponse,
} from '../index.js'

describe('history recall shared contracts', () => {
  it('keeps legacy locators assignable and treats part/chunk identity as additive', () => {
    const legacy = {
      sessionAgentId: 'session-a',
      actorAgentId: 'session-a',
      entryId: 'checkpoint-1',
      sourceVersion: 'generation',
      byteOffset: 42,
    } satisfies HistoryEntryReference
    const qualified = {
      ...legacy,
      partId: 'toolCall:call-1',
      chunkIndex: 1,
    } satisfies HistoryEntryReference
    expectTypeOf(legacy).toMatchTypeOf<HistoryEntryReference>()
    expectTypeOf(qualified).toMatchTypeOf<HistoryEntryReference>()
    expect(HISTORY_ENTRY_KINDS).toEqual(['message', 'tool_call', 'tool_result', 'checkpoint'])
    expect(HISTORY_SEARCH_SCOPES).toEqual(['session', 'project', 'all_local'])
  })

  it('adds canonical traversal and literal search without changing lexical defaults', () => {
    const items = { actorAgentId: 'worker', windowId: 'window:initial', role: 'user', limit: 1 } satisfies HistoryItemsRequest
    const windows = { sessionAgentId: 'session', cursor: 'opaque' } satisfies HistoryWindowsRequest
    const response = { results: [], nextCursor: 'next', complete: false, warnings: [] } satisfies HistoryWindowsResponse
    const literal = { query: 'foo-bar', mode: 'literal', caseSensitive: true, actorAgentId: 'worker', windowId: 'window:initial' } satisfies HistorySearchRequest
    expectTypeOf(items).toMatchTypeOf<HistoryItemsRequest>()
    expectTypeOf(windows).toMatchTypeOf<HistoryWindowsRequest>()
    expect(response.complete).toBe(false)
    expect(literal.caseSensitive).toBe(true)
  })

  it('preserves search defaults while adding newest, artifacts, coverage, and sessions', () => {
    const compatible: HistorySearchRequest = { query: 'mobile' }
    const newest: HistorySearchRequest = {
      query: 'mobile',
      scope: 'project',
      order: 'newest',
      includeHistoryArtifacts: false,
    }
    const response: HistorySearchResponse = {
      scope: 'session',
      results: [],
      complete: true,
      warnings: [],
    }
    const covered: HistorySearchResponse = {
      ...response,
      coverage: {
        catalogHydration: 'partial',
        state: 'building',
        catalogRevision: 0,
        pendingSourceCount: 1,
        unreadableSourceCount: 0,
        omittedEligibleText: false,
      } satisfies HistoryCoverage,
    }
    const sessions: HistorySessionsRequest = { query: 'mobile', scope: 'project' }
    const snapshot: HistoryCatalogSnapshot = {
      revision: 3,
      hydration: 'complete',
      sources: [],
    }
    const read: HistoryReadRequest = {
      ref: {
        sessionAgentId: 'session-a',
        actorAgentId: 'worker-a',
        entryId: 'entry-1',
        sourceVersion: 'generation',
      },
    }
    expect(compatible.order).toBeUndefined()
    expect(newest.order).toBe('newest')
    expect(response.coverage).toBeUndefined()
    expect(covered.coverage?.catalogHydration).toBe('partial')
    expect(sessions.scope).toBe('project')
    expect(snapshot.hydration).toBe('complete')
    expect(read.ref.partId).toBeUndefined()
    expect(HISTORY_SEARCH_ORDERS).toEqual(['relevance', 'newest'])
    expect(HISTORY_COVERAGE_STATES).toEqual(['building', 'ready', 'degraded', 'unavailable'])
    expect(HISTORY_CATALOG_HYDRATION).toEqual(['partial', 'complete'])
    expect(HISTORY_SNAPSHOT_ERROR_CODES).toEqual([
      'snapshot_expired',
      'snapshot_mismatch',
      'snapshot_cap_exceeded',
    ])
  })
})
