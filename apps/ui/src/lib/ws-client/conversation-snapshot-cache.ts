import type { BuilderTimelineChannelView } from '@forge/protocol'
import type {
  AgentActivityEntry,
  ConversationHistoryEntry,
} from '../ws-state'
import type { ConversationHistoryPageMetadata } from '@forge/protocol'

export const MAX_SNAPSHOTS_APPLICATION = 24
export const MAX_ESTIMATED_BYTES_APPLICATION = 16 * 1024 * 1024
export const MAX_ESTIMATED_BYTES_PER_ENTRY = 2 * 1024 * 1024
export const MAX_SNAPSHOT_AGE_MS = 15 * 60 * 1000

export interface ConversationSnapshotKey {
  originId: string
  agentId: string
  servedView: BuilderTimelineChannelView
}

export interface ConversationPresentationSnapshot extends ConversationSnapshotKey {
  profileId: string | null
  capturedAt: number
  estimatedBytes: number
  messages: ConversationHistoryEntry[]
  activityMessages: AgentActivityEntry[]
  conversationPage: ConversationHistoryPageMetadata | null
}

interface ConversationSnapshotCacheOptions {
  now?: () => number
  maxSnapshots?: number
  maxEstimatedBytes?: number
  maxEntryBytes?: number
  maxAgeMs?: number
}

function serializeKey(key: ConversationSnapshotKey): string {
  return JSON.stringify([key.originId, key.agentId, key.servedView])
}

function isPassivePresentationRow(entry: ConversationHistoryEntry): boolean {
  // Choice rows are lifecycle projections, not passive history. Even answered,
  // cancelled, or expired rows retain choice identifiers and UI affordance
  // semantics that must only come from the current authoritative bootstrap.
  if (entry.type === 'choice_request') return false

  // Optimistic user rows are likewise command-side state until confirmed by
  // persisted history.
  return !(
    entry.type === 'conversation_message' &&
    !entry.id &&
    typeof entry.clientRequestId === 'string'
  )
}

/** One flat, presentation-only, application-wide LRU. */
export class ConversationSnapshotCache {
  private readonly entries = new Map<string, ConversationPresentationSnapshot>()
  private readonly now: () => number
  private readonly maxSnapshots: number
  private readonly maxEstimatedBytes: number
  private readonly maxEntryBytes: number
  private readonly maxAgeMs: number
  private estimatedBytes = 0

  constructor(options: ConversationSnapshotCacheOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS_APPLICATION
    this.maxEstimatedBytes = options.maxEstimatedBytes ?? MAX_ESTIMATED_BYTES_APPLICATION
    this.maxEntryBytes = options.maxEntryBytes ?? MAX_ESTIMATED_BYTES_PER_ENTRY
    this.maxAgeMs = options.maxAgeMs ?? MAX_SNAPSHOT_AGE_MS
  }

  capture(input: Omit<ConversationPresentationSnapshot, 'capturedAt' | 'estimatedBytes'>): boolean {
    const key = serializeKey(input)
    this.removeKey(key)

    const messages = input.messages.filter(isPassivePresentationRow)
    const activityMessages = [...input.activityMessages]
    const conversationPage = input.conversationPage ? { ...input.conversationPage } : null
    const estimatedBytes = new TextEncoder().encode(JSON.stringify({
      messages,
      activityMessages,
      conversationPage,
    })).byteLength
    if (estimatedBytes > this.maxEntryBytes) return false

    const entry: ConversationPresentationSnapshot = {
      ...input,
      messages: [...messages],
      activityMessages,
      conversationPage,
      capturedAt: this.now(),
      estimatedBytes,
    }
    this.entries.set(key, entry)
    this.estimatedBytes += estimatedBytes
    this.prune()
    return this.entries.has(key)
  }

  get(key: ConversationSnapshotKey): ConversationPresentationSnapshot | null {
    this.removeExpired()
    const serialized = serializeKey(key)
    const entry = this.entries.get(serialized)
    if (!entry) return null
    this.entries.delete(serialized)
    this.entries.set(serialized, entry)
    return entry
  }

  evictAgent(originId: string, agentId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.originId === originId && entry.agentId === agentId) this.removeKey(key)
    }
  }

  evictOrigin(originId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.originId === originId) this.removeKey(key)
    }
  }

  evictProfile(originId: string, profileId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.originId === originId && entry.profileId === profileId) this.removeKey(key)
    }
  }

  get size(): number {
    this.removeExpired()
    return this.entries.size
  }

  get totalEstimatedBytes(): number {
    this.removeExpired()
    return this.estimatedBytes
  }

  private prune(): void {
    this.removeExpired()
    while (this.entries.size > this.maxSnapshots || this.estimatedBytes > this.maxEstimatedBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.removeKey(oldest)
    }
  }

  private removeExpired(): void {
    const cutoff = this.now() - this.maxAgeMs
    for (const [key, entry] of this.entries) {
      if (entry.capturedAt < cutoff) this.removeKey(key)
    }
  }

  private removeKey(key: string): void {
    const existing = this.entries.get(key)
    if (!existing) return
    this.entries.delete(key)
    this.estimatedBytes -= existing.estimatedBytes
  }
}
