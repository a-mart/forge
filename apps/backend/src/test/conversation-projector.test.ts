import { mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { ServerEvent } from '@forge/protocol'
import { ConversationProjector } from '../swarm/conversation-projector.js'
import { getConversationHistoryCacheFilePath } from '../swarm/conversation-history-cache.js'
import { reconcileInterruptedToolCallsForBoot } from '../swarm/interrupted-tool-reconciliation.js'
import { getMessageRoutingReceiptsPath } from '../swarm/session/message-routing-receipts.js'
import { MAX_SESSION_FILE_BYTES_FOR_OPEN } from '../swarm/session-file-guard.js'
import type { SwarmAgentRuntime } from '../swarm/runtime-contracts.js'
import type { AgentDescriptor, ConversationEntryEvent } from '../swarm/types.js'

const FIXED_NOW = '2026-01-01T00:00:00.000Z'
const CURRENT_CONVERSATION_CACHE_VERSION = 4

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
      modelId: 'gpt-5.5',
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
    version: CURRENT_CONVERSATION_CACHE_VERSION,
    persistedEntryCount: overrides.persistedEntryCount ?? 0,
    cachedPersistedEntryCount: overrides.cachedPersistedEntryCount ?? 0,
    firstPersistedEntryKey: overrides.firstPersistedEntryKey ?? null,
    lastPersistedEntryKey: overrides.lastPersistedEntryKey ?? null,
    canonicalStat: overrides.canonicalStat ?? (await readCanonicalStat(sessionFile)),
  }
}

describe('ConversationProjector session tree continuity', () => {
  it('writes routing receipts to the session sidecar at the conversation entry choke point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const projector = makeProjector({ descriptor })

    projector.emitConversationMessage(
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        turnId: 'manager:1',
        role: 'assistant',
        text: 'visible',
        timestamp: FIXED_NOW,
        source: 'assistant_output',
      },
      {
        routingReceipt: {
          type: 'message_routing',
          agentId: descriptor.agentId,
          turnId: 'manager:1',
          timestamp: FIXED_NOW,
          decision: 'render',
          reasonCode: 'render:user_web',
          channel: 'web',
          targetKind: 'explicit_tool_required',
        },
      },
    )

    const receiptsText = await readFile(getMessageRoutingReceiptsPath(sessionFile), 'utf8')
    expect(receiptsText.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      {
        type: 'message_routing',
        agentId: descriptor.agentId,
        turnId: 'manager:1',
        timestamp: FIXED_NOW,
        decision: 'render',
        reasonCode: 'render:user_web',
        channel: 'web',
        targetKind: 'explicit_tool_required',
      },
    ])
  })

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

    reopened.appendModelChange('openai-codex', 'gpt-5.5')
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

  it('keeps Codex stream detail agent_tool_call rows live/cache-only so boot reconcile leaves no persisted open tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-codex-persistence-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const codexSidecar: AgentDescriptor = {
      ...makeDescriptor(join(root, 'codex.jsonl'), root),
      agentId: 'manager--codex',
      role: 'worker',
      managerId: 'manager',
      status: 'streaming',
      externalThread: {
        type: 'codex_app_server',
        persisted: true,
        createdByMention: true,
      },
    }
    const projector = makeProjector({ descriptor })

    projector.emitAgentToolCall({
      type: 'agent_tool_call',
      agentId: descriptor.agentId,
      actorAgentId: codexSidecar.agentId,
      timestamp: FIXED_NOW,
      kind: 'tool_execution_start',
      toolName: 'codex_command',
      toolCallId: 'cmd-1',
      text: '{"command":"echo hi"}',
    })

    const history = projector.getConversationHistory(descriptor.agentId)
    expect(
      history.some(
        (entry) =>
          entry.type === 'agent_tool_call' &&
          entry.toolName === 'codex_command' &&
          entry.kind === 'tool_execution_start',
      ),
    ).toBe(true)

    const readPersistedToolCalls = () =>
      SessionManager.open(sessionFile)
        .getEntries()
        .filter((entry: any) => entry.type === 'custom' && entry.customType === 'swarm_conversation_entry')
        .map((entry: any) => entry.data)
        .filter((entry: any) => entry?.type === 'agent_tool_call')

    expect(readPersistedToolCalls()).toEqual([])

    const reconcileResult = reconcileInterruptedToolCallsForBoot({
      descriptors: new Map([
        [descriptor.agentId, descriptor],
        [codexSidecar.agentId, codexSidecar],
      ]),
      interruptedActorAgentIds: new Set([descriptor.agentId]),
      now: () => FIXED_NOW,
    })

    expect(reconcileResult).toEqual({ reconciledToolCalls: 0, deliveryWarnings: 0 })
    expect(readPersistedToolCalls()).toEqual([])
  })

  it('does not resurrect Codex stream detail agent_tool_call rows from disk cache on cold load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-codex-cache-cold-load-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)
    const codexSidecar: AgentDescriptor = {
      ...makeDescriptor(join(root, 'codex.jsonl'), root),
      agentId: 'manager--codex',
      role: 'worker',
      managerId: 'manager',
      status: 'streaming',
      externalThread: {
        type: 'codex_app_server',
        persisted: true,
        createdByMention: true,
      },
    }
    const projector = makeProjector({ descriptor })

    projector.emitConversationMessage({
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'seed-message',
      role: 'assistant',
      text: 'durable seed message',
      timestamp: FIXED_NOW,
      source: 'system',
    })
    projector.emitAgentToolCall({
      type: 'agent_tool_call',
      agentId: descriptor.agentId,
      actorAgentId: codexSidecar.agentId,
      timestamp: FIXED_NOW,
      kind: 'tool_execution_start',
      toolName: 'codex_command',
      toolCallId: 'cmd-1',
      text: '{"command":"echo hi"}',
    })

    const liveHistory = projector.getConversationHistory(descriptor.agentId)
    expect(
      liveHistory.some(
        (entry) =>
          entry.type === 'agent_tool_call' &&
          entry.toolName === 'codex_command' &&
          entry.kind === 'tool_execution_start',
      ),
    ).toBe(true)

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const cacheText = await waitForFileText(cacheFile, {
      matches: (text) => text.includes('durable seed message'),
    })
    expect(cacheText).not.toContain('"toolName":"codex_command"')

    const reloadedProjector = makeProjector({ descriptor })
    const reloadedHistory = reloadedProjector.getConversationHistory(descriptor.agentId)

    expect(
      reloadedHistory.some(
        (entry) => entry.type === 'agent_tool_call' && entry.toolName === 'codex_command',
      ),
    ).toBe(false)
    expect(
      reloadedHistory.some(
        (entry) => entry.type === 'conversation_message' && entry.text === 'durable seed message',
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

  it('keeps stable-id dedupe scoped by entry type when merging disk and in-memory history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-type-dedupe-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create header' }],
    } as any)

    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'model_cache_observation',
      agentId: descriptor.agentId,
      id: 'shared-stable-id',
      timestamp: FIXED_NOW,
      runtimeType: 'pi',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      tokens: {
        promptInputTokens: 2_000,
        cachedInputTokens: 1_600,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 400,
        outputTokens: 100,
        totalTokens: 2_100,
        normalization: 'raw_input_tokens_total',
      },
      classification: {
        version: 1,
        status: 'hit',
        cachedRatio: 0.8,
        thresholdTokens: 1_024,
        hitRatioThreshold: 0.8,
      },
    })

    const inMemoryMessage: ConversationEntryEvent = {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'shared-stable-id',
      role: 'assistant',
      text: 'runtime message with a colliding stable id',
      timestamp: FIXED_NOW,
      source: 'system',
    }
    const conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>([
      [descriptor.agentId, [inMemoryMessage]],
    ])
    const projector = makeProjector({ descriptor, conversationEntriesByAgentId })

    const history = projector.getConversationHistory(descriptor.agentId)

    expect(history.filter((entry) => entry.type === 'model_cache_observation' && entry.id === 'shared-stable-id')).toHaveLength(1)
    expect(history.filter((entry) => entry.type === 'conversation_message' && entry.id === 'shared-stable-id')).toHaveLength(1)
  })

  it('persists model_cache_observation entries as swarm_conversation_entry custom rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-model-cache-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    const seededSession = SessionManager.open(sessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create session header' }],
    } as any)

    const runtime = makeRuntimeForSession(descriptor)
    const emitted: ServerEvent[] = []
    const projector = new ConversationProjector({
      descriptors: new Map([[descriptor.agentId, descriptor]]),
      runtimes: new Map([[descriptor.agentId, runtime]]),
      conversationEntriesByAgentId: new Map(),
      now: () => FIXED_NOW,
      emitServerEvent: (_eventName, payload) => {
        emitted.push(payload)
      },
      logDebug: () => {},
    })

    projector.emitModelCacheObservation({
      type: 'model_cache_observation',
      agentId: descriptor.agentId,
      id: 'cache-obs-1',
      timestamp: FIXED_NOW,
      runtimeType: 'pi',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      tokens: {
        promptInputTokens: 2000,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 2000,
        outputTokens: 50,
        totalTokens: 2050,
        normalization: 'raw_input_tokens_total',
      },
      classification: {
        version: 1,
        status: 'miss',
        cachedRatio: 0,
        thresholdTokens: 1024,
        hitRatioThreshold: 0.8,
      },
    })

    const history = projector.getConversationHistory(descriptor.agentId)
    expect(history.filter((entry) => entry.type === 'model_cache_observation')).toHaveLength(1)
    expect(emitted.some((event) => event.type === 'model_cache_observation')).toBe(true)

    const raw = await readFile(sessionFile, 'utf8')
    expect(raw).toContain('model_cache_observation')
    expect(raw).toContain('swarm_conversation_entry')
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

  it('keeps id-less persisted messages when no wrapper id exists, but rejects malformed blank ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-id-fallbacks-'))
    const sessionFile = join(root, 'manager.jsonl')
    const descriptor = makeDescriptor(sessionFile, root)

    await writeFile(
      sessionFile,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'session-header',
          timestamp: FIXED_NOW,
          cwd: root,
        }),
        JSON.stringify({
          type: 'custom',
          customType: 'swarm_conversation_entry',
          parentId: 'session-header',
          timestamp: FIXED_NOW,
          data: {
            type: 'conversation_message',
            agentId: descriptor.agentId,
            role: 'assistant',
            text: 'legacy message with no wrapper id',
            timestamp: '2025-12-31T23:58:00.000Z',
            source: 'system',
          },
        }),
        JSON.stringify({
          type: 'custom',
          customType: 'swarm_conversation_entry',
          id: 'blank-id-wrapper',
          parentId: 'session-header',
          timestamp: FIXED_NOW,
          data: {
            type: 'conversation_message',
            agentId: descriptor.agentId,
            id: '   ',
            role: 'assistant',
            text: 'message with malformed blank id',
            timestamp: '2025-12-31T23:59:00.000Z',
            source: 'system',
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const projector = makeProjector({ descriptor })
    const history = projector.getConversationHistory(descriptor.agentId)

    const noWrapperIdEntry = history.find(
      (entry) => entry.type === 'conversation_message' && entry.text === 'legacy message with no wrapper id',
    )
    const malformedIdEntry = history.find(
      (entry) => entry.type === 'conversation_message' && entry.text === 'message with malformed blank id',
    )

    expect(noWrapperIdEntry).toBeDefined()
    expect(noWrapperIdEntry?.type).toBe('conversation_message')
    if (noWrapperIdEntry?.type === 'conversation_message') {
      expect(noWrapperIdEntry.id).toBeUndefined()
    }
    expect(malformedIdEntry).toBeUndefined()
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

  it('rebuilds a legacy sidecar without a fingerprint and rewrites it in the v4 format', async () => {
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
      matches: (text) => text.includes('"version":4') && text.includes('"canonicalStat"'),
    })
    expect(rewrittenCacheText).toContain('"version":4')
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

  it('rejects cache headers with invalid metadata version or shape before rebuilding from JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-invalid-cache-metadata-'))
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
      text: 'persisted history survives invalid cache metadata',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      {
        type: 'swarm_conversation_cache_meta',
        version: 999,
        persistedEntryCount: 1,
        cachedPersistedEntryCount: 1,
        firstPersistedEntryKey: null,
        lastPersistedEntryKey: null,
        canonicalStat: await readCanonicalStat(sessionFile),
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        role: 'assistant',
        text: 'stale cache payload with invalid version',
        timestamp: FIXED_NOW,
        source: 'system',
      },
    ])

    const invalidVersionProjector = makeProjector({ descriptor })
    const invalidVersionResult = invalidVersionProjector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(
      invalidVersionResult.history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.text === 'persisted history survives invalid cache metadata',
      ),
    ).toBe(true)
    expect(invalidVersionResult.diagnostics).toMatchObject({
      cacheState: 'legacy_rebuild',
      historySource: 'cache_rebuild',
      detail: 'missing_cache_metadata',
    })

    const shapeRoot = await mkdtemp(join(tmpdir(), 'conversation-projector-invalid-cache-shape-'))
    const shapeSessionFile = join(shapeRoot, 'manager.jsonl')
    const shapeDescriptor = makeDescriptor(shapeSessionFile, shapeRoot)
    const shapeSeededSession = SessionManager.open(shapeSessionFile)
    shapeSeededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed message' }],
    } as any)
    shapeSeededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: shapeDescriptor.agentId,
      role: 'assistant',
      text: 'persisted history survives invalid cache shape',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const shapeCacheFile = getConversationHistoryCacheFilePath(shapeSessionFile)
    await writeCacheLines(shapeCacheFile, [
      {
        type: 'swarm_conversation_cache_meta',
        version: CURRENT_CONVERSATION_CACHE_VERSION,
        persistedEntryCount: '1',
        cachedPersistedEntryCount: 1,
        firstPersistedEntryKey: null,
        lastPersistedEntryKey: null,
        canonicalStat: await readCanonicalStat(shapeSessionFile),
      },
    ])

    const invalidShapeProjector = makeProjector({ descriptor: shapeDescriptor })
    const invalidShapeResult = invalidShapeProjector.getConversationHistoryWithDiagnostics(shapeDescriptor.agentId)

    expect(
      invalidShapeResult.history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.text === 'persisted history survives invalid cache shape',
      ),
    ).toBe(true)
    expect(invalidShapeResult.diagnostics).toMatchObject({
      cacheState: 'legacy_rebuild',
      historySource: 'cache_rebuild',
      detail: 'missing_cache_metadata',
    })
  })

  it('rejects truncated cache payloads even when the metadata header is otherwise valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-truncated-cache-'))
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
      text: 'persisted history survives truncated cache payload',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    const metadata = await buildCacheMetadata(sessionFile, {
      persistedEntryCount: 1,
      cachedPersistedEntryCount: 1,
      firstPersistedEntryKey: `conversation_message:${entryId}`,
      lastPersistedEntryKey: `conversation_message:${entryId}`,
    })
    await writeFile(cacheFile, `${JSON.stringify(metadata)}\n{"type":"conversation_message","agentId"`, 'utf8')

    const projector = makeProjector({ descriptor })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    expect(
      result.history.some(
        (entry) =>
          entry.type === 'conversation_message' && entry.text === 'persisted history survives truncated cache payload',
      ),
    ).toBe(true)
    expect(result.diagnostics).toMatchObject({
      cacheState: 'metadata_entries_mismatch',
      historySource: 'cache_rebuild',
      coldLoad: true,
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

  it('toggles in-memory pinned state through the facade without touching other messages', () => {
    const descriptor = makeDescriptor(join(tmpdir(), 'conversation-projector-pin-facade.jsonl'), tmpdir())
    const entries: ConversationEntryEvent[] = [
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'target-msg',
        role: 'assistant',
        text: 'Target message',
        timestamp: FIXED_NOW,
        source: 'system',
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'other-msg',
        role: 'assistant',
        text: 'Other message',
        timestamp: FIXED_NOW,
        source: 'system',
        pinned: true,
      },
      {
        type: 'conversation_log',
        agentId: descriptor.agentId,
        timestamp: FIXED_NOW,
        source: 'runtime_log',
        kind: 'message_start',
        text: 'Non-message entry',
        pinned: true,
      } as ConversationEntryEvent,
    ]
    const projector = makeProjector({
      descriptor,
      conversationEntriesByAgentId: new Map([[descriptor.agentId, entries]]),
    })

    projector.setConversationMessagePinned(descriptor.agentId, 'target-msg', true)

    expect(entries[0]).toMatchObject({ type: 'conversation_message', id: 'target-msg', pinned: true })
    expect(entries[1]).toMatchObject({ type: 'conversation_message', id: 'other-msg', pinned: true })
    expect(entries[2]).toHaveProperty('pinned', true)

    projector.setConversationMessagePinned(descriptor.agentId, 'target-msg', false)

    expect(entries[0]).toMatchObject({ type: 'conversation_message', id: 'target-msg' })
    expect(entries[0] && 'pinned' in entries[0] ? entries[0].pinned : undefined).toBeUndefined()
    expect(entries[1]).toMatchObject({ type: 'conversation_message', id: 'other-msg', pinned: true })
    expect(entries[2]).toHaveProperty('pinned', true)
  })

  it('treats pinned-message sidecar state as authoritative over cached pinned flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-cache-pins-'))
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
      id: 'stale-cache-pinned',
      role: 'assistant',
      text: 'Cache says pinned, sidecar does not',
      timestamp: '2025-12-31T23:58:00.000Z',
      source: 'system',
    })
    seededSession.appendCustomEntry('swarm_conversation_entry', {
      type: 'conversation_message',
      agentId: descriptor.agentId,
      id: 'sidecar-pinned',
      role: 'assistant',
      text: 'Sidecar says pinned, cache does not',
      timestamp: FIXED_NOW,
      source: 'system',
    })

    const cacheFile = getConversationHistoryCacheFilePath(sessionFile)
    await writeCacheLines(cacheFile, [
      await buildCacheMetadata(sessionFile, {
        persistedEntryCount: 2,
        cachedPersistedEntryCount: 2,
        firstPersistedEntryKey: 'conversation_message:stale-cache-pinned',
        lastPersistedEntryKey: 'conversation_message:sidecar-pinned',
      }),
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'stale-cache-pinned',
        role: 'assistant',
        text: 'Cache says pinned, sidecar does not',
        timestamp: '2025-12-31T23:58:00.000Z',
        source: 'system',
        pinned: true,
      },
      {
        type: 'conversation_message',
        agentId: descriptor.agentId,
        id: 'sidecar-pinned',
        role: 'assistant',
        text: 'Sidecar says pinned, cache does not',
        timestamp: FIXED_NOW,
        source: 'system',
        pinned: false,
      },
    ])

    const projector = makeProjector({
      descriptor,
      getPinnedMessageIds: () => new Set(['sidecar-pinned']),
    })
    const result = projector.getConversationHistoryWithDiagnostics(descriptor.agentId)

    const stalePinnedEntry = result.history.find(
      (entry) => entry.type === 'conversation_message' && entry.id === 'stale-cache-pinned',
    )
    const authoritativePinnedEntry = result.history.find(
      (entry) => entry.type === 'conversation_message' && entry.id === 'sidecar-pinned',
    )

    expect(result.diagnostics).toMatchObject({ cacheState: 'hit', historySource: 'cache_hit' })
    expect(stalePinnedEntry).toMatchObject({ type: 'conversation_message', id: 'stale-cache-pinned' })
    expect(stalePinnedEntry && 'pinned' in stalePinnedEntry ? stalePinnedEntry.pinned : undefined).toBeUndefined()
    expect(authoritativePinnedEntry).toMatchObject({
      type: 'conversation_message',
      id: 'sidecar-pinned',
      pinned: true,
    })
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

  it('persists worker-origin choice_request entries to the manager session history while preserving requester agentId', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-worker-choice-'))
    const managerSessionFile = join(root, 'manager.jsonl')
    const workerSessionFile = join(root, 'worker.jsonl')
    const managerDescriptor = makeDescriptor(managerSessionFile, root)
    const workerDescriptor: AgentDescriptor = {
      ...makeDescriptor(workerSessionFile, root),
      agentId: 'worker',
      displayName: 'Worker',
      role: 'worker',
      managerId: managerDescriptor.agentId,
      sessionFile: workerSessionFile,
    }
    const seededSession = SessionManager.open(managerSessionFile)
    seededSession.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'seed entry to create session header' }],
    } as any)
    const runtime = makeRuntimeForSession(managerDescriptor)

    const projector = new ConversationProjector({
      descriptors: new Map([
        [managerDescriptor.agentId, managerDescriptor],
        [workerDescriptor.agentId, workerDescriptor],
      ]),
      runtimes: new Map([[managerDescriptor.agentId, runtime]]),
      conversationEntriesByAgentId: new Map(),
      now: () => FIXED_NOW,
      emitServerEvent: () => {},
      logDebug: () => {},
    })

    projector.emitChoiceRequest(
      {
        type: 'choice_request',
        agentId: workerDescriptor.agentId,
        sessionAgentId: managerDescriptor.agentId,
        choiceId: 'choice-worker-1',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'pending',
        timestamp: FIXED_NOW,
      },
      { historyAgentId: managerDescriptor.agentId },
    )

    const managerHistory = projector.getConversationHistory(managerDescriptor.agentId)
    expect(managerHistory).toEqual([
      {
        type: 'choice_request',
        agentId: workerDescriptor.agentId,
        sessionAgentId: managerDescriptor.agentId,
        choiceId: 'choice-worker-1',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'pending',
        timestamp: FIXED_NOW,
      },
    ])
    expect(projector.getConversationHistory(workerDescriptor.agentId)).toEqual([])

    const persistedConversationEntries = SessionManager.open(managerSessionFile)
      .getEntries()
      .filter((entry: any) => entry.type === 'custom' && entry.customType === 'swarm_conversation_entry')
      .map((entry: any) => entry.data)

    expect(persistedConversationEntries).toEqual([
      {
        type: 'choice_request',
        agentId: workerDescriptor.agentId,
        sessionAgentId: managerDescriptor.agentId,
        choiceId: 'choice-worker-1',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'pending',
        timestamp: FIXED_NOW,
      },
    ])

    const cacheFile = getConversationHistoryCacheFilePath(managerSessionFile)
    const cacheText = await waitForFileText(cacheFile, {
      matches: (text) => text.includes('"choiceId":"choice-worker-1"') && text.includes('"agentId":"worker"'),
    })
    expect(cacheText).toContain('"sessionAgentId":"manager"')

    const reloadedProjector = new ConversationProjector({
      descriptors: new Map([
        [managerDescriptor.agentId, managerDescriptor],
        [workerDescriptor.agentId, workerDescriptor],
      ]),
      runtimes: new Map(),
      conversationEntriesByAgentId: new Map(),
      now: () => FIXED_NOW,
      emitServerEvent: () => {},
      logDebug: () => {},
    })
    const reloadedHistory = reloadedProjector.getConversationHistory(managerDescriptor.agentId)

    expect(reloadedHistory).toEqual([
      {
        type: 'choice_request',
        agentId: workerDescriptor.agentId,
        sessionAgentId: managerDescriptor.agentId,
        choiceId: 'choice-worker-1',
        questions: [{ id: 'q1', question: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
        status: 'pending',
        timestamp: FIXED_NOW,
      },
    ])
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

describe('ConversationProjector runtime event mapper facade', () => {
  it('emits worker tool activity before the worker-local runtime log and stores matching history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'conversation-projector-runtime-mapper-'))
    const managerSessionFile = join(root, 'manager.jsonl')
    const workerSessionFile = join(root, 'worker.jsonl')
    const managerDescriptor = makeDescriptor(managerSessionFile, root)
    const workerDescriptor: AgentDescriptor = {
      ...makeDescriptor(workerSessionFile, root),
      agentId: 'worker',
      displayName: 'Worker',
      role: 'worker',
      managerId: managerDescriptor.agentId,
      sessionFile: workerSessionFile,
    }
    const emitted: Array<{ eventName: string; payload: ConversationEntryEvent }> = []
    const conversationEntriesByAgentId = new Map<string, ConversationEntryEvent[]>()

    const projector = new ConversationProjector({
      descriptors: new Map([
        [managerDescriptor.agentId, managerDescriptor],
        [workerDescriptor.agentId, workerDescriptor],
      ]),
      runtimes: new Map(),
      conversationEntriesByAgentId,
      now: () => FIXED_NOW,
      emitServerEvent: (eventName, payload) => {
        emitted.push({ eventName, payload: payload as ConversationEntryEvent })
      },
      logDebug: () => {},
    })

    projector.captureConversationEventFromRuntime(workerDescriptor.agentId, {
      type: 'tool_execution_start',
      toolName: 'read',
      toolCallId: 'tool-1',
      args: { path: 'README.md' },
    })

    expect(emitted).toEqual([
      {
        eventName: 'agent_tool_call',
        payload: {
          type: 'agent_tool_call',
          agentId: managerDescriptor.agentId,
          actorAgentId: workerDescriptor.agentId,
          timestamp: FIXED_NOW,
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'tool-1',
          text: '{"path":"README.md"}',
        },
      },
      {
        eventName: 'conversation_log',
        payload: {
          type: 'conversation_log',
          agentId: workerDescriptor.agentId,
          timestamp: FIXED_NOW,
          source: 'runtime_log',
          kind: 'tool_execution_start',
          toolName: 'read',
          toolCallId: 'tool-1',
          text: '{"path":"README.md"}',
        },
      },
    ])
    expect(projector.getConversationHistory(managerDescriptor.agentId)).toEqual([emitted[0]?.payload])
    expect(projector.getConversationHistory(workerDescriptor.agentId)).toEqual([emitted[1]?.payload])
  })
})
