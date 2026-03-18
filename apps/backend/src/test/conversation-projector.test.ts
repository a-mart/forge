import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@mariozechner/pi-coding-agent'
import { ConversationProjector } from '../swarm/conversation-projector.js'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-types.js'
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
}): ConversationProjector {
  return new ConversationProjector({
    descriptors: new Map([[options.descriptor.agentId, options.descriptor]]),
    runtimes: options.runtimes ?? new Map(),
    conversationEntriesByAgentId: options.conversationEntriesByAgentId ?? new Map(),
    now: () => FIXED_NOW,
    emitServerEvent: () => {},
    logDebug: () => {},
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
    smartCompact: async () => ({ compactionSucceeded: true }),
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
    const history = projector.getConversationHistory(descriptor.agentId)

    expect(
      history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.text === 'latest persisted message after cache went stale',
      ),
    ).toBe(true)
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
})
