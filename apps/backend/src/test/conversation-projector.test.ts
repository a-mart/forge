import { mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { ConversationProjector } from '../swarm/conversation-projector.js'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import { MAX_SESSION_FILE_BYTES_FOR_OPEN } from '../swarm/session-file-guard.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-contracts.js'
import type { AgentDescriptor, ConversationEntryEvent } from '../swarm/types.js'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'

type SessionEntryWithId = {
  id: string
  type: string
  parentId: string | null
  customType?: string
  data?: unknown
}

function makeDescriptor(sessionFile: string, cwd: string): AgentDescriptor {
  return {
    agentId: 'manager',
    displayName: 'Manager',
    role: 'manager',
    managerId: 'manager',
    status: 'idle',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    cwd,
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'medium',
    },
    sessionFile,
  }
}

function makeProjector(options: {
  descriptor: AgentDescriptor
  runtimes?: Map<string, SwarmAgentRuntime>
  conversationEntriesByAgentId?: Map<string, ConversationEntryEvent[]>
  getPinnedMessageIds?: (agentId: string) => ReadonlySet<string> | undefined
  logDebug?: (message: string, details?: unknown) => void
}): ConversationProjector {
  return new ConversationProjector({
    descriptors: new Map([[options.descriptor.agentId, options.descriptor]]),
    runtimes: options.runtimes ?? new Map(),
    conversationEntriesByAgentId: options.conversationEntriesByAgentId ?? new Map(),
    now: () => FIXED_NOW,
    emitServerEvent: () => {},
    logDebug: options.logDebug ?? (() => {}),
    getPinnedMessageIds: options.getPinnedMessageIds,
  })
}

function makeRuntimeForSession(descriptor: AgentDescriptor): SwarmAgentRuntime {
  const sessionManager = SessionManager.open(descriptor.sessionFile)

  return {
    descriptor,
    getStatus: () => descriptor.status,
    getPendingCount: () => 0,
    getContextUsage: () => undefined,
    sendMessage: async (_input, _requestedMode = 'auto') => ({
      targetAgentId: descriptor.agentId,
      deliveryId: 'runtime-delivery',
      acceptedMode: 'prompt',
    }),
    compact: async () => ({ status: 'ok' }),
    smartCompact: async () => ({ compacted: true }),
    stopInFlight: async () => {},
    terminate: async () => {},
    recycle: async () => {},
    getCustomEntries: (customType: string) => {
      const entries = sessionManager.getEntries()
      return entries
        .filter((entry) => entry.type === 'custom' && entry.customType === customType)
        .map((entry) => (entry.type === 'custom' ? entry.data : undefined))
        .filter((entry) => entry !== undefined)
    },
    appendCustomEntry: (customType: string, data?: unknown) => sessionManager.appendCustomEntry(customType, data),
  }
}

function findConversationCustomEntry(entries: SessionEntryWithId[], text: string): SessionEntryWithId | undefined {
  return entries.find(
    (entry) =>
      entry.type === 'custom' &&
      entry.customType === 'swarm_conversation_entry' &&
      typeof entry.data === 'object' &&
      entry.data !== null &&
      'type' in entry.data &&
      'text' in entry.data &&
      (entry.data as { type?: unknown }).type === 'conversation_message' &&
      (entry.data as { text?: unknown }).text === text,
  )
}

async function waitForFileText(
  path: string,
  options?: { timeoutMs?: number; matches?: (text: string) => boolean },
): Promise<string> {
  const timeoutMs = options?.timeoutMs ?? 500
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, 'utf8')
      if (!options?.matches || options.matches(text)) {
        return text
      }
    } catch {
      // Keep polling until the cache write lands.
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error(`Timed out waiting for file ${path}`)
}

async function writeCacheLines(path: string, lines: unknown[]): Promise<void> {
  const text = lines.map((line) => JSON.stringify(line)).join('\n')
  await writeFile(path, text.length > 0 ? `${text}\n` : '', 'utf8')
}

async function readCanonicalStat(sessionFile: string): Promise<{ size: number; mtimeMs: number }> {
  const fileStat = await stat(sessionFile)
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
  }
}

async function buildCacheMetadata(
  sessionFile: string,
  overrides: Partial<{
    persistedEntryCount: number
    cachedPersistedEntryCount: number
    firstPersistedEntryKey: string | null
    lastPersistedEntryKey: string | null
    canonicalStat: { size: number; mtimeMs: number }
  }> = {},
): Promise<Record<string, unknown>> {
  return {
    type: 'swarm_conversation_cache_meta',
    version: 2,
    persistedEntryCount: overrides.persistedEntryCount ?? 0,
    cachedPersistedEntryCount: overrides.cachedPersistedEntryCount ?? 0,
    firstPersistedEntryKey: overrides.firstPersistedEntryKey ?? null,
    lastPersistedEntryKey: overrides.lastPersistedEntryKey ?? null,
    canonicalStat: overrides.canonicalStat ?? (await readCanonicalStat(sessionFile)),
  }
}

describe('ConversationProjector session tree continuity', () => {
  it('chains direct-append conversation entries to the previous persisted entry after history preload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    const lastPreRestartEntryId = seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'persisted before restart' }],
    } as any)

    const projector = makeProjector({ descriptor })
    projector.loadConversationHistoriesFromStore()

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'system',
      text: 'appended before runtime restore',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const reopened = SessionManager.open(sessionFile)
    const entries = reopened.getEntries() as SessionEntryWithId[]
    const fallbackEntry = findConversationCustomEntry(entries, 'appended before runtime restore')

    expect(fallbackEntry).toBeDefined()
    expect(fallbackEntry?.parentId).toBe(lastPreRestartEntryId)

    reopened.appendModelChange('openai-codex', 'gpt-5.3-codex')
    const branchIds = reopened.getBranch().map((entry) => entry.id)

    expect(branchIds).toContain(lastPreRestartEntryId)
  })

  it('updates the cached leaf when runtime appendCustomEntry is used so fallback appends stay connected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-runtime-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    const firstEntryId = seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry' }],
    } as any)

    const runtime = makeRuntimeForSession(descriptor)
    const runtimes = new Map<string, SwarmAgentRuntime>([[descriptor.agentId, runtime]])
    const projector = makeProjector({ descriptor, runtimes })

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'runtime persisted entry',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const afterRuntimeAppend = SessionManager.open(sessionFile)
    const afterRuntimeEntries = afterRuntimeAppend.getEntries() as SessionEntryWithId[]
    const runtimeEntry = findConversationCustomEntry(afterRuntimeEntries, 'runtime persisted entry')

    expect(runtimeEntry).toBeDefined()
    expect(runtimeEntry?.parentId).toBe(firstEntryId)

    runtimes.delete(descriptor.agentId)

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'system',
      text: 'fallback persisted entry',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const afterFallbackAppend = SessionManager.open(sessionFile)
    const afterFallbackEntries = afterFallbackAppend.getEntries() as SessionEntryWithId[]
    const fallbackEntry = findConversationCustomEntry(afterFallbackEntries, 'fallback persisted entry')

    expect(fallbackEntry).toBeDefined()
    expect(fallbackEntry?.parentId).toBe(runtimeEntry?.id)
  })

  it('keeps runtime logs in cache history while only persisting durable entries to session JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-persistence-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const projector = makeProjector({ descriptor })

    projector.emitConversationLog({
      type: 'conversation_log',
      agentId: descriptor.agentId,
      timestamp: FIXED_NOW,
      source: 'runtime_log',
      kind: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tool-1',
      text: '{"path":"README.md"}',
    })
    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'durable transcript entry',
      timestamp: FIXED_NOW,
      source: 'system',
    })
    projector.emitAgentMessage({
      type: 'agent_message',
      agentId: descriptor.agentId,
      timestamp: FIXED_NOW,
      source: 'agent_to_agent',
      fromAgentId: 'worker',
      toAgentId: descriptor.agentId,
      text: 'durable routing entry',
    })
    projector.emitAgentToolCall({
      type: 'agent_tool_call',
      agentId: descriptor.agentId,
      actorAgentId: 'worker',
      timestamp: FIXED_NOW,
      kind: 'tool_execution_end',
      toolName: 'read',
      toolCallId: 'tool-1',
      text: '{"ok":true}',
      isError: false,
    })

    const history = projector.getConversationHistory(descriptor.agentId)
    expect(history.some((entry) => entry.type === 'conversation_log' && entry.kind === 'tool_execution_start')).toBe(
      true,
    )

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const cacheText = await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes('"type":"conversation_log"') &&
        text.includes('durable transcript entry') &&
        text.includes('durable routing entry') &&
        text.includes('"kind":"tool_execution_end"'),
    })
    expect(cacheText).toContain('"type":"conversation_log"')
    expect(cacheText).toContain('durable transcript entry')
    expect(cacheText).toContain('durable routing entry')
    expect(cacheText).toContain('"kind":"tool_execution_end"')

    const persistedConversationEntries = SessionManager.open(sessionFile)
      .getEntries()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'swarm_conversation_entry')
      .map((entry: any) => entry.data)

    expect(persistedConversationEntries.some((entry: any) => entry?.type === 'conversation_log')).toBe(false)
    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'conversation_message' && entry.text === 'durable transcript entry',
      ),
    ).toBe(true)
    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_message' && entry.text === 'durable routing entry',
      ),
    ).toBe(true)
    expect(
      persistedConversationEntries.some(
        (entry: any) => entry?.type === 'agent_tool_call' && entry.kind === 'tool_execution_end',
      ),
    ).toBe(true)

    const reloadedProjector = makeProjector({ descriptor })
    const reloadedHistory = reloadedProjector.getConversationHistory(descriptor.agentId)

    expect(
      reloadedHistory.some((entry) => entry.type === 'conversation_log' && entry.kind === 'tool_execution_start'),
    ).toBe(true)
    expect(
      reloadedHistory.some(
        (entry) => entry.type === 'conversation_message' && entry.text === 'durable transcript entry',
      ),
    ).toBe(true)
  })

  it('loads the full persisted history before appending a cold post-boot conversation entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cold-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create header' }],
    } as any)

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history before restart',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history tail before restart',
      timestamp: '2025-12-31T23:59:00.000Z',
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes('persisted history before restart') && text.includes('persisted history tail before restart'),
    })

    const coldProjector = makeProjector({ descriptor })
    coldProjector.loadConversationHistoriesFromStore()

    coldProjector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted after cold boot before lazy load',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    await waitForFileText(cacheFile, {
      matches: (text) =>
        text.includes('persisted history before restart') && text.includes('persisted after cold boot before lazy load'),
    })

    const reloadedProjector = makeProjector({ descriptor })
    const history = reloadedProjector.getConversationHistory(descriptor.agentId)

    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted history before restart',
      ),
    ).toHaveLength(1)
    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted history tail before restart',
      ),
    ).toHaveLength(1)
    expect(
      history.filter(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted after cold boot before lazy load',
      ),
    ).toHaveLength(1)
  })

  it('merges runtime-captured in-memory entries with lazy disk history on first access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-lazy-merge-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create header' }],
    } as any)

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history before restart',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })

    const projector = makeProjector({ descriptor })
    projector.loadConversationHistoriesFromStore()

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'runtime persisted after boot',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    projector.emitConversationLog({
      type: 'conversation_log',
      agentId: descriptor.agentId,
      timestamp: FIXED_NOW,
      source: 'runtime_log',
      kind: 'tool_execution_update',
      toolName: 'read',
      toolCallId: 'tool-1',
      text: '{"progress":0.5}',
    })

    const history = projector.getConversationHistory(descriptor.agentId)

    const persistedBeforeRestart = history.filter(
      (entry) => entry.type === 'conversation_message' && entry.text === 'persisted history before restart',
    )
    const persistedAfterBoot = history.filter(
      (entry) => entry.type === 'conversation_message' && entry.text === 'runtime persisted after boot',
    )
    const inMemoryOnlyUpdate = history.filter(
      (entry) => entry.type === 'conversation_log' && entry.kind === 'tool_execution_update',
    )

    expect(persistedBeforeRestart).toHaveLength(1)
    expect(persistedAfterBoot).toHaveLength(1)
    expect(inMemoryOnlyUpdate).toHaveLength(1)
  })

  it('backfills missing message ids from wrapper entry ids when loading persisted history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-backfill-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)

    const legacyTimestamp = '2025-12-31T23:59:59.000Z'
    const wrappedEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'legacy message without explicit id',
      timestamp: legacyTimestamp,
      source: 'system',
    })

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_log',
      agentId: descriptor.agentId,
      timestamp: FIXED_NOW,
      source: 'runtime_log',
      kind: 'message_end',
      role: 'assistant',
      text: 'runtime event',
    })

    const projector = makeProjector({ descriptor })
    const loaded = projector.getConversationHistory(descriptor.agentId)

    const legacyMessage = loaded.find(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.timestamp === legacyTimestamp &&
        entry.text === 'legacy message without explicit id',
    )

    expect(legacyMessage).toBeDefined()
    expect(legacyMessage?.type).toBe('conversation_message')
    if (legacyMessage?.type === 'conversation_message') {
      expect(legacyMessage.id).toBe(wrappedEntryId)
      expect(legacyMessage.timestamp).toBe(legacyTimestamp)
    }
  })

  it('rejects and rewrites a tail-only cache snapshot even when the cached tail matches canonical history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-tail-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)

    const firstEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted prefix message',
      timestamp: '2025-12-31T23:57:00.000Z',
      source: 'system',
    })
    const middleEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted middle message',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    const lastEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted tail message',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 3,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: `conversation_message:${middleEntryId}`,
        lastPersistedEntryKey: `conversation_message:${lastEntryId}`,
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted middle message',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        id: middleEntryId,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted tail message',
        timestamp: FIXED_NOW,
        source: 'system',
        id: lastEntryId,
      },
    ])

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)
    const history = result.history

    expect(
      history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted prefix message'),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_missing_persisted_prefix',
      historySource: 'cache_rebuild',
      coldLoad: true,
    })

    const rewrittenCacheText = await waitForFileText(cacheFile, {
      matches: (text) => text.includes('persisted prefix message'),
    })
    expect(rewrittenCacheText).toContain('"persistedEntryCount":3')
    expect(rewrittenCacheText).toContain('"cachedPersistedEntryCount":3')
    expect(rewrittenCacheText).toContain(`"firstPersistedEntryKey":"conversation_message:${firstEntryId}"`)
    expect(rewrittenCacheText).toContain(`"lastPersistedEntryKey":"conversation_message:${lastEntryId}"`)
  })

  it('fast-paths a clean cache hit without rescanning the canonical session file or rewriting the sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-fast-hit-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"canonicalStat"') && text.includes('persisted history'),
    })
    const cacheStatBeforeHit = await stat(cacheFile)

    const coldProjector = makeProjector({ descriptor })
    const result = coldProjector.getConversationHistoryWithDiagnostics(descriptor.agentId)
    const cacheStatAfterHit = await stat(cacheFile)

    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted history')).toBe(
      true,
    )
    expect(result.diagnostics).toMatchObject({
      cacheState: 'hit',
      historySource: 'cache_hit',
      coldLoad: true,
      fastPathUsed: true,
    })
    expect(result.diagnostics.sessionSummaryBytesScanned).toBeUndefined()
    expect(result.diagnostics.sessionSummaryReadMs).toBeUndefined()
    expect(cacheStatAfterHit.mtimeMs).toBe(cacheStatBeforeHit.mtimeMs)
  })

  it('falls back to a canonical summary scan when the session stat fingerprint changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-fast-miss-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted before cache write',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"canonicalStat"') && text.includes('persisted before cache write'),
    })

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted after stat change',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const coldProjector = makeProjector({ descriptor })
    const result = coldProjector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(
      result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted after stat change'),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_missing_persisted_prefix',
      historySource: 'cache_rebuild',
      coldLoad: true,
      fastPathUsed: false,
    })
    expect(result.diagnostics.sessionSummaryBytesScanned).toBeGreaterThan(0)
  })

  it('rebuilds a legacy sidecar without a fingerprint and rewrites it in the v2 format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-legacy-sidecar-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    const persistedEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      {
        type: 'swarm_conversation_cache_meta',
        version: 1,
        persistedEntryCount: 1,
        cachedPersistedEntryCount: 1,
        firstPersistedEntryKey: `conversation_message:${persistedEntryId}`,
        lastPersistedEntryKey: `conversation_message:${persistedEntryId}`,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted history',
        timestamp: FIXED_NOW,
        source: 'system',
        id: persistedEntryId,
      },
    ])

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted history')).toBe(
      true,
    )
    expect(result.diagnostics).toMatchObject({
      cacheState: 'legacy_rebuild',
      historySource: 'cache_rebuild',
      coldLoad: true,
      fastPathUsed: false,
    })

    const rewrittenCacheText = await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"version":2') && text.includes('"canonicalStat"'),
    })
    expect(rewrittenCacheText).toContain('"version":2')
    expect(rewrittenCacheText).toContain('"canonicalStat"')
  })

  it('falls back when the canonical stat changes between the fast-path checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-toctou-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted before validation',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"canonicalStat"') && text.includes('persisted before validation'),
    })

    const projector = makeProjector({ descriptor }) as ConversationProjector & {
      readSessionFileCanonicalStat: (sessionPath: string) => { size: number; mtimeMs: number } | null
    }
    const originalReadSessionFileCanonicalStat = projector.readSessionFileCanonicalStat.bind(projector)
    let statReadCount = 0
    projector.readSessionFileCanonicalStat = (sessionPath) => {
      statReadCount += 1
      if (statReadCount === 2) {
        SessionManager.open(sessionPath).appendCustomEntry('swarm_conversation_entry', {
          type: 'conversation_message',
          agentId: descriptor.agentId,
          role: 'assistant',
          text: 'persisted during validation',
          timestamp: FIXED_NOW,
          source: 'system',
        })
      }
      return originalReadSessionFileCanonicalStat(sessionPath)
    }

    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(
      result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted during validation'),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_missing_persisted_prefix',
      historySource: 'cache_rebuild',
      coldLoad: true,
      fastPathUsed: false,
    })
    expect(result.diagnostics.sessionSummaryBytesScanned).toBeGreaterThan(0)
  })

  it('falls back when the canonical stat changes after the summary validation path runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-summary-toctou-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted before summary validation',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })

    const warmProjector = makeProjector({ descriptor })
    warmProjector.getConversationHistory(descriptor.agentId)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const cacheText = await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"canonicalStat"') && text.includes('persisted before summary validation'),
    })
    const [metadataLine, ...entryLines] = cacheText.trim().split('\n')
    const parsedMetadata = JSON.parse(metadataLine) as Record<string, unknown>
    parsedMetadata.canonicalStat = { size: 0, mtimeMs: 0 }
    await writeFile(cacheFile, `${[JSON.stringify(parsedMetadata), ...entryLines].join('\n')}\n`, 'utf8')

    const projector = makeProjector({ descriptor }) as ConversationProjector & {
      readPersistedConversationEntrySummary: (sessionPath: string) => unknown
    }
    const originalReadPersistedConversationEntrySummary = projector.readPersistedConversationEntrySummary.bind(projector)
    let summaryReadCount = 0
    projector.readPersistedConversationEntrySummary = (sessionPath) => {
      const result = originalReadPersistedConversationEntrySummary(sessionPath)
      summaryReadCount += 1
      if (summaryReadCount === 1) {
        SessionManager.open(sessionPath).appendCustomEntry('swarm_conversation_entry', {
          type: 'conversation_message',
          agentId: descriptor.agentId,
          role: 'assistant',
          text: 'persisted during summary validation',
          timestamp: FIXED_NOW,
          source: 'system',
        })
      }
      return result
    }

    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(summaryReadCount).toBeGreaterThanOrEqual(2)
    expect(
      result.history.some(
        (entry) => entry.type === 'conversation_message' && entry.text === 'persisted during summary validation',
      ),
    ).toBe(true)
    expect(result.diagnostics.cacheState).not.toBe('hit')
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_missing_persisted_prefix',
      historySource: 'cache_rebuild',
      coldLoad: true,
      fastPathUsed: false,
    })
    expect(result.diagnostics.sessionSummaryBytesScanned).toBeGreaterThan(0)
  })

  it('reports absent/full_parse on the first cold read and memory/memory on a warm reread', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-diagnostics-memory-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const projector = makeProjector({ descriptor })
    const cold = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)
    const warm = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(cold.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted history')).toBe(
      true,
    )
    expect(cold.diagnostics).toMatchObject({
      cacheState: 'absent',
      historySource: 'full_parse',
      coldLoad: true,
    })
    expect(warm.diagnostics).toMatchObject({
      cacheState: 'memory',
      historySource: 'memory',
      coldLoad: false,
      fsReadOps: 0,
      fsReadBytes: 0,
    })
  })

  it('rebuilds from JSONL when the cache payload is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cache-read-error-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeFile(cacheFile, 'this is not valid cache json\n', 'utf8')

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted history')).toBe(
      true,
    )
    expect(result.diagnostics).toMatchObject({
      cacheState: 'cache_read_error',
      historySource: 'cache_rebuild',
      coldLoad: true,
      detail: 'invalid_cache_payload',
    })
  })

  it('rejects caches whose metadata does not match the cached entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-metadata-mismatch-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    const entryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted history',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 1,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: `conversation_message:${entryId}`,
        lastPersistedEntryKey: `conversation_message:${entryId}`,
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted history',
        timestamp: FIXED_NOW,
        source: 'system',
        id: entryId,
      },
    ])

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.diagnostics).toMatchObject({
      cacheState: 'metadata_entries_mismatch',
      historySource: 'cache_rebuild',
      coldLoad: true,
    })
  })

  it('rejects caches when the persisted entry count no longer matches the session JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-persisted-count-mismatch-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    const firstEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted first message',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    const lastEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted latest message',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 1,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: `conversation_message:${firstEntryId}`,
        lastPersistedEntryKey: `conversation_message:${lastEntryId}`,
        canonicalStat: { size: 0, mtimeMs: 0 },
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted first message',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        id: firstEntryId,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted latest message',
        timestamp: FIXED_NOW,
        source: 'system',
        id: lastEntryId,
      },
    ])

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.diagnostics).toMatchObject({
      cacheState: 'persisted_entry_count_mismatch',
      historySource: 'cache_rebuild',
      coldLoad: true,
    })
    expect(result.diagnostics.detail).toContain('expected=1,actual=2')
  })

  it('rejects caches when the cached tail entry no longer matches the session JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-last-entry-mismatch-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    const firstEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted first message',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted actual latest message',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const staleTailEntryId = 'stale-tail-id'
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 2,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: `conversation_message:${firstEntryId}`,
        lastPersistedEntryKey: `conversation_message:${staleTailEntryId}`,
        canonicalStat: { size: 0, mtimeMs: 0 },
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted first message',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        id: firstEntryId,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'stale cached latest message',
        timestamp: FIXED_NOW,
        source: 'system',
        id: staleTailEntryId,
      },
    ])

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted actual latest message')).toBe(true)
    expect(result.history.some((entry) => entry.type === 'conversation_message' && entry.text === 'stale cached latest message')).toBe(false)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'last_persisted_entry_mismatch',
      historySource: 'cache_rebuild',
      coldLoad: true,
    })
  })

  it('reports size_guard_skip when the session JSONL exceeds the size guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-size-guard-skip-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const fileHandle = await open(sessionFile, 'w')
    try {
      await fileHandle.truncate(MAX_SESSION_FILE_BYTES_FOR_OPEN + 1)
    } finally {
      await fileHandle.close()
    }

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(result.history).toEqual([])
    expect(result.diagnostics).toMatchObject({
      cacheState: 'size_guard_skip',
      historySource: 'size_guard_skip',
      coldLoad: true,
    })
    expect(result.diagnostics.detail).toContain('session_size_guard_skip')
  })

  it('accepts a complete trimmed cache window for long persisted transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-long-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)

    for (let index = 0; index < 2005; index += 1) {
      seededSession.appendCustomEntry('swarm_conversation_entry', {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: `persisted-${index}`,
        timestamp: FIXED_NOW,
        source: 'system',
      })
    }

    const warmProjector = makeProjector({ descriptor })
    const warmHistory = warmProjector.getConversationHistory(descriptor.agentId)

    expect(warmHistory).toHaveLength(2000)
    expect(warmHistory.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted-0')).toBe(
      false,
    )
    expect(warmHistory.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted-2004')).toBe(
      true,
    )

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"persistedEntryCount":2005') && text.includes('"cachedPersistedEntryCount":2000'),
    })

    const debugMessages: string[] = []
    const reloadedProjector = makeProjector({
      descriptor,
      logDebug: (message) => {
        debugMessages.push(message)
      },
    })
    const reloaded = reloadedProjector.getConversationHistoryWithDiagnostics(descriptor.agentId)
    const reloadedHistory = reloaded.history

    expect(reloadedHistory).toHaveLength(2000)
    expect(
      reloadedHistory.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted-4'),
    ).toBe(false)
    expect(
      reloadedHistory.some((entry) => entry.type === 'conversation_message' && entry.text === 'persisted-5'),
    ).toBe(true)
    expect(debugMessages).toContain('history:load:cache')
    expect(debugMessages).not.toContain('history:load:ready')
    expect(reloaded.diagnostics).toMatchObject({
      cacheState: 'hit',
      historySource: 'cache_hit',
      coldLoad: true,
      fastPathUsed: true,
    })
    expect(reloaded.diagnostics.sessionSummaryBytesScanned).toBeUndefined()
  })

  it('falls back to JSONL replay when the cache is missing the latest persisted message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-stale-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)

    const staleCacheEntryId = seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'persisted before cache write stalled',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'assistant',
      text: 'latest persisted message after cache went stale',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeFile(
      cacheFile,
      `${JSON.stringify({
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'persisted before cache write stalled',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        id: staleCacheEntryId,
      })}\n`,
      'utf8',
    )

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(
      result.history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.text === 'latest persisted message after cache went stale',
      ),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'legacy_rebuild',
      historySource: 'cache_rebuild',
      coldLoad: true,
    })
  })

  it('ignores stale cache entries after the session JSONL has been cleared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cleared-session-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)

    await writeFile(sessionFile, '', 'utf8')
    await writeFile(
      cacheFile,
      `${JSON.stringify({
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'stale cache after reset',
        timestamp: FIXED_NOW,
        source: 'system',
        id: 'stale-cache-id',
      })}\n`,
      'utf8',
    )

    const projector = makeProjector({ descriptor })

    expect(projector.getConversationHistory(descriptor.agentId)).toEqual([])
  })

  it('merges pinned state onto loaded conversation messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-pins-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'pinned-msg',
      role: 'assistant',
      text: 'Keep me around',
      timestamp: FIXED_NOW,
      source: 'system',
    })
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'regular-msg',
      role: 'assistant',
      text: 'Not pinned',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const projector = makeProjector({
      descriptor,
      getPinnedMessageIds: () => new Set(['pinned-msg']),
    })

    const history = projector.getConversationHistory(descriptor.agentId)
    const pinnedEntry = history.find((entry) => entry.type === 'conversation_message' && entry.id === 'pinned-msg')
    const regularEntry = history.find((entry) => entry.type === 'conversation_message' && entry.id === 'regular-msg')

    expect(pinnedEntry).toMatchObject({ type: 'conversation_message', id: 'pinned-msg', pinned: true })
    expect(regularEntry).toMatchObject({ type: 'conversation_message', id: 'regular-msg' })
    expect(regularEntry && 'pinned' in regularEntry ? regularEntry.pinned : undefined).toBeUndefined()
  })

  it('loads persisted project-agent transcript entries during JSONL replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-project-agent-replay-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'user',
      text: 'Draft release notes for v1.2.3.',
      timestamp: FIXED_NOW,
      source: 'project_agent_input',
      projectAgentContext: {
        fromAgentId: 'release-notes--s2',
        fromDisplayName: 'Release Notes',
      },
    })

    const projector = makeProjector({ descriptor })
    const history = projector.getConversationHistory(descriptor.agentId)
    const replayedEntry = history.find(
      (entry) =>
        entry.type === 'conversation_message' &&
        entry.source === 'project_agent_input' &&
        entry.text === 'Draft release notes for v1.2.3.',
    )

    expect(replayedEntry).toBeDefined()
    expect(replayedEntry?.type).toBe('conversation_message')
    if (replayedEntry?.type === 'conversation_message') {
      expect(replayedEntry.projectAgentContext).toEqual({
        fromAgentId: 'release-notes--s2',
        fromDisplayName: 'Release Notes',
      })
    }
  })

  it('preserves project-agent transcript entries during history trimming even without sourceContext', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-project-agent-trim-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const projector = makeProjector({ descriptor })

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      role: 'user',
      text: 'Coordinate the release handoff.',
      timestamp: FIXED_NOW,
      source: 'project_agent_input',
      projectAgentContext: {
        fromAgentId: 'release-notes--s2',
        fromDisplayName: 'Release Notes',
      },
    })

    for (let index = 0; index < 2000; index += 1) {
      projector.emitConversationMessage({
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'system',
        text: `system-${index}`,
        timestamp: FIXED_NOW,
        source: 'system',
      })
    }

    const history = projector.getConversationHistory(descriptor.agentId)

    expect(history).toHaveLength(2000)
    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' &&
          entry.source === 'project_agent_input' &&
          entry.text === 'Coordinate the release handoff.',
      ),
    ).toBe(true)
    expect(
      history.some(
        (entry) => entry.type === 'conversation_message' && entry.source === 'system' && entry.text === 'system-0',
      ),
    ).toBe(false)
  })
})
