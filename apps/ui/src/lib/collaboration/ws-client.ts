/**
 * Transport-backed collaboration WebSocket client.
 *
 * Uses {@link WebSocketTransport} from the shared transport layer for
 * connection lifecycle, reconnect, and JSON send/parse. This client owns
 * only the collab-domain event routing and state updates.
 *
 * Public channel-selection API: {@link setActiveChannel} — subscribe /
 * unsubscribe is an internal implementation detail.
 */

import type {
  ChoiceAnswer,
  CollaborationBootstrapEvent,
  CollaborationCategoryCreatedEvent,
  CollaborationCategoryDeletedEvent,
  CollaborationCategoryReorderedEvent,
  CollaborationCategoryUpdatedEvent,
  CollaborationChannelActivityUpdatedEvent,
  CollaborationChannelArchivedEvent,
  CollaborationChannelCreatedEvent,
  CollaborationChannelHistoryEvent,
  CollaborationChannelMessageEvent,
  CollaborationChannelReadyEvent,
  CollaborationChannelReorderedEvent,
  CollaborationChannelStatusEvent,
  CollaborationChannelUpdatedEvent,
  CollaborationChoiceRequestEvent,
  CollaborationClientCommand,
  CollaborationMessagePinnedEvent,
  CollaborationReadState,
  CollaborationReadStateUpdatedEvent,
  CollaborationSessionActivityEvent,
  CollaborationSessionActivitySnapshotEvent,
  CollaborationSessionAgentStatusEvent,
  CollaborationSessionWorkersSnapshotEvent,
  ConversationAttachment,
  ErrorEvent,
} from '@forge/protocol'
import {
  createInitialCollabWsState,
  type CollabWsState,
} from '../collab-ws-state'
import { WebSocketTransport } from '../ws-client/websocket-transport'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_CONNECT_DELAY_MS = 50
const RECONNECT_MS = 1_200
const RECONNECTING_SOCKET_ERROR = 'Collab WebSocket is disconnected. Reconnecting...'

/**
 * Close code sent by the backend when a user's collaboration session is
 * invalidated (role change, disable, password reset, session revocation).
 * When received, the client must NOT reconnect — the session is permanently
 * invalid until the user re-authenticates.
 */
const SESSION_INVALIDATED_CLOSE_CODE = 4001

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type CollabWsListener = (state: CollabWsState) => void

// ---------------------------------------------------------------------------
// Type guard for collab server events
// ---------------------------------------------------------------------------

type CollabServerEvent =
  | CollaborationBootstrapEvent
  | CollaborationChannelReadyEvent
  | CollaborationChannelHistoryEvent
  | CollaborationChannelMessageEvent
  | CollaborationChannelStatusEvent
  | CollaborationSessionWorkersSnapshotEvent
  | CollaborationSessionActivitySnapshotEvent
  | CollaborationSessionActivityEvent
  | CollaborationSessionAgentStatusEvent
  | CollaborationChannelActivityUpdatedEvent
  | CollaborationReadStateUpdatedEvent
  | CollaborationChoiceRequestEvent
  | CollaborationMessagePinnedEvent
  | CollaborationChannelCreatedEvent
  | CollaborationChannelUpdatedEvent
  | CollaborationChannelArchivedEvent
  | CollaborationChannelReorderedEvent
  | CollaborationCategoryCreatedEvent
  | CollaborationCategoryUpdatedEvent
  | CollaborationCategoryDeletedEvent
  | CollaborationCategoryReorderedEvent

function isCollabServerEvent(event: unknown): event is CollabServerEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    typeof (event as { type?: unknown }).type === 'string' &&
    (event as { type: string }).type.startsWith('collab_')
  )
}

function isCollabErrorEvent(event: unknown): event is ErrorEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'error' &&
    typeof (event as { code?: unknown }).code === 'string' &&
    (event as { code: string }).code.startsWith('COLLAB_') &&
    typeof (event as { message?: unknown }).message === 'string'
  )
}

// ---------------------------------------------------------------------------
// CollabWsClient — transport-backed
// ---------------------------------------------------------------------------

export class CollabWsClient {
  private transport: WebSocketTransport

  private state: CollabWsState
  private readonly listeners = new Set<CollabWsListener>()

  /** Channel we should re-subscribe to after reconnect */
  private activeChannelId: string | null = null

  constructor(url: string) {
    this.state = createInitialCollabWsState()

    this.transport = new WebSocketTransport({
      url,
      reconnectDelayMs: RECONNECT_MS,
      onOpen: () => {
        this.updateState({ connected: true, lastError: null, lastErrorCode: null })
        // Bootstrap on every connect/reconnect
        this.transport.send({ type: 'collab_bootstrap' })
      },
      onClose: (event) => {
        // Backend sends 4001 when the user's collab session is invalidated
        // (role change, disable, password reset, session revocation).
        // Stop reconnecting — the session is permanently invalid.
        if (event?.code === SESSION_INVALIDATED_CLOSE_CODE) {
          this.transport.disconnect()
          this.updateState({
            connected: false,
            hasBootstrapped: false,
            sessionWorkers: [],
            sessionActivity: [],
            sessionAgentStatuses: {},
            lastError: 'Your session has been invalidated. Please sign in again.',
            lastErrorCode: 'COLLAB_SESSION_INVALIDATED',
          })
          return
        }

        this.updateState({
          connected: false,
          hasBootstrapped: false,
          // Clear worker state so the UI doesn't show stale pills during reconnect
          sessionWorkers: [],
          sessionActivity: [],
          sessionAgentStatuses: {},
        })
      },
      onMessage: (data) => {
        this.handleMessage(data)
      },
      onError: () => {
        this.updateState({
          connected: false,
          lastError: 'Collab WebSocket connection error',
          lastErrorCode: null,
        })
      },
    })
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  getState(): CollabWsState {
    return this.state
  }

  subscribe(listener: CollabWsListener): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }

  start(): void {
    this.transport.connect(INITIAL_CONNECT_DELAY_MS)
  }

  destroy(): void {
    this.transport.disconnect()
  }

  /**
   * Set the active channel — handles subscribe/unsubscribe internally.
   * Pass `null` to unsubscribe from the current channel.
   */
  setActiveChannel(channelId: string | null): void {
    const trimmed = channelId?.trim() || null

    // Unsubscribe from previous channel first
    if (this.activeChannelId && this.activeChannelId !== trimmed) {
      if (this.transport.isConnected()) {
        this.transport.send({ type: 'collab_unsubscribe_channel', channelId: this.activeChannelId })
      }
    }

    this.activeChannelId = trimmed

    if (trimmed) {
      // Reset channel-scoped state
      this.updateState({
        activeChannelId: trimmed,
        channelHistory: [],
        channelHistoryLoaded: false,
        channelStatus: 'idle',
        channelStreamingStartedAt: undefined,
        sessionWorkers: [],
        sessionActivity: [],
        sessionAgentStatuses: {},
        pendingChoiceRequests: [],
      })

      if (this.transport.isConnected()) {
        this.transport.send({ type: 'collab_subscribe_channel', channelId: trimmed })
      }
    } else {
      // Clear all channel state
      this.updateState({
        activeChannelId: null,
        channelHistory: [],
        channelHistoryLoaded: false,
        channelStatus: 'idle',
        channelStreamingStartedAt: undefined,
        sessionWorkers: [],
        sessionActivity: [],
        sessionAgentStatuses: {},
        pendingChoiceRequests: [],
      })
    }
  }

  /**
   * Send a user message to a channel.
   */
  sendMessage(channelId: string, content: string, attachments?: ConversationAttachment[]): boolean {
    const trimmedContent = content.trim()
    const hasAttachments = attachments && attachments.length > 0
    if (!trimmedContent && !hasAttachments) return false

    if (!this.transport.isConnected()) {
      this.updateState({ lastError: RECONNECTING_SOCKET_ERROR, lastErrorCode: null })
      return false
    }

    const command: CollaborationClientCommand = {
      type: 'collab_user_message',
      channelId,
      content: trimmedContent,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }

    const sent = this.transport.send(command)
    if (sent) {
      this.updateState({ lastError: null, lastErrorCode: null })
    }
    return sent
  }

  /**
   * Mark a channel as read (server-authoritative).
   */
  markChannelRead(channelId: string): void {
    if (!this.transport.isConnected()) return
    this.transport.send({ type: 'collab_mark_channel_read', channelId })
  }

  /**
   * Respond to a choice request.
   */
  sendChoiceResponse(channelId: string, choiceId: string, answers: ChoiceAnswer[]): void {
    if (!this.transport.isConnected()) return
    this.transport.send({ type: 'collab_choice_response', channelId, choiceId, answers })
  }

  /**
   * Cancel a choice request.
   */
  sendChoiceCancel(channelId: string, choiceId: string): void {
    if (!this.transport.isConnected()) return
    this.transport.send({ type: 'collab_choice_cancel', channelId, choiceId })
  }

  /**
   * Pin or unpin a message in the active channel.
   */
  pinMessage(channelId: string, messageId: string, pinned: boolean): void {
    if (!this.transport.isConnected()) return
    this.transport.send({ type: 'collab_pin_message', channelId, messageId, pinned })
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handleMessage(event: unknown): void {
    if (isCollabServerEvent(event)) {
      this.handleCollabEvent(event)
      return
    }

    if (isCollabErrorEvent(event)) {
      this.updateState({
        lastError: event.message,
        lastErrorCode: event.code,
      })
    }
  }

  private handleCollabEvent(event: CollabServerEvent): void {
    switch (event.type) {
      case 'collab_bootstrap':
        this.handleBootstrap(event)
        break
      case 'collab_channel_ready':
        this.handleChannelReady(event)
        break
      case 'collab_channel_history':
        this.handleChannelHistory(event)
        break
      case 'collab_channel_message':
        this.handleChannelMessage(event)
        break
      case 'collab_channel_status':
        this.handleChannelStatus(event)
        break
      case 'collab_session_workers_snapshot':
        this.handleSessionWorkersSnapshot(event)
        break
      case 'collab_session_activity_snapshot':
        this.handleSessionActivitySnapshot(event)
        break
      case 'collab_session_activity':
        this.handleSessionActivity(event)
        break
      case 'collab_session_agent_status':
        this.handleSessionAgentStatus(event)
        break
      case 'collab_channel_activity_updated':
        this.handleChannelActivityUpdated(event)
        break
      case 'collab_read_state_updated':
        this.handleReadStateUpdated(event)
        break
      case 'collab_choice_request':
        this.handleChoiceRequest(event)
        break
      case 'collab_message_pinned':
        this.handleMessagePinned(event)
        break
      case 'collab_channel_created':
        this.handleChannelCreated(event)
        break
      case 'collab_channel_updated':
        this.handleChannelUpdated(event)
        break
      case 'collab_channel_archived':
        this.handleChannelArchived(event)
        break
      case 'collab_channel_reordered':
        this.handleChannelReordered(event)
        break
      case 'collab_category_created':
        this.handleCategoryCreated(event)
        break
      case 'collab_category_updated':
        this.handleCategoryUpdated(event)
        break
      case 'collab_category_deleted':
        this.handleCategoryDeleted(event)
        break
      case 'collab_category_reordered':
        this.handleCategoryReordered(event)
        break
    }
  }

  // -----------------------------------------------------------------------
  // Event handlers — bootstrap
  // -----------------------------------------------------------------------

  private handleBootstrap(event: CollaborationBootstrapEvent): void {
    const workspace = event.workspace
    const readStates: Record<string, CollaborationReadState> = {}
    const unreadCounts: Record<string, number> = {}

    for (const ch of event.channels) {
      readStates[ch.channelId] = ch.readState
      unreadCounts[ch.channelId] = ch.readState.unreadCount
    }

    // Strip readState from channels to store plain CollaborationChannel[]
    const channels = event.channels.map(({ readState: _rs, ...channel }) => channel)

    this.updateState({
      workspace,
      categories: event.categories,
      channels,
      currentUser: event.currentUser,
      channelReadStates: readStates,
      channelUnreadCounts: unreadCounts,
      hasBootstrapped: true,
      lastError: null,
      lastErrorCode: null,
    })

    // Re-subscribe to the channel we were viewing before reconnect
    if (this.activeChannelId) {
      this.transport.send({ type: 'collab_subscribe_channel', channelId: this.activeChannelId })
    }
  }

  // -----------------------------------------------------------------------
  // Event handlers — channel subscription
  // -----------------------------------------------------------------------

  private handleChannelReady(event: CollaborationChannelReadyEvent): void {
    this.updateState({
      channels: this.state.channels.map((ch) =>
        ch.channelId === event.channel.channelId ? event.channel : ch,
      ),
    })
  }

  private handleChannelHistory(event: CollaborationChannelHistoryEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({
      channelHistory: event.messages,
      channelHistoryLoaded: true,
    })
  }

  // -----------------------------------------------------------------------
  // Event handlers — live messages + status
  // -----------------------------------------------------------------------

  private handleChannelMessage(event: CollaborationChannelMessageEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({
      channelHistory: [...this.state.channelHistory, event.message],
      channelHistoryLoaded: true,
    })
  }

  private handleChannelStatus(event: CollaborationChannelStatusEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({
      channelStatus: event.status,
      channelStreamingStartedAt: event.streamingStartedAt,
    })
  }

  private handleSessionWorkersSnapshot(event: CollaborationSessionWorkersSnapshotEvent): void {
    if (event.channelId !== this.state.activeChannelId) return

    const nextStatuses = { ...this.state.sessionAgentStatuses }
    const workerIds = new Set(event.workers.map((worker) => worker.agentId))
    for (const agentId of Object.keys(nextStatuses)) {
      if (!workerIds.has(agentId)) {
        delete nextStatuses[agentId]
      }
    }

    this.updateState({
      sessionWorkers: event.workers,
      sessionAgentStatuses: nextStatuses,
    })
  }

  private handleSessionActivitySnapshot(event: CollaborationSessionActivitySnapshotEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({ sessionActivity: event.activity })
  }

  private handleSessionActivity(event: CollaborationSessionActivityEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({ sessionActivity: [...this.state.sessionActivity, event.activity] })
  }

  private handleSessionAgentStatus(event: CollaborationSessionAgentStatusEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({
      sessionAgentStatuses: {
        ...this.state.sessionAgentStatuses,
        [event.agentId]: {
          status: event.status,
          pendingCount: event.pendingCount,
          ...(event.contextUsage ? { contextUsage: event.contextUsage } : {}),
          ...(event.contextRecoveryInProgress !== undefined
            ? { contextRecoveryInProgress: event.contextRecoveryInProgress }
            : {}),
          ...(event.streamingStartedAt !== undefined ? { streamingStartedAt: event.streamingStartedAt } : {}),
        },
      },
    })
  }

  // -----------------------------------------------------------------------
  // Event handlers — activity & read state (all channels)
  // -----------------------------------------------------------------------

  private handleChannelActivityUpdated(event: CollaborationChannelActivityUpdatedEvent): void {
    this.updateState({
      channels: this.state.channels.map((ch) =>
        ch.channelId === event.channelId
          ? {
              ...ch,
              lastMessageSeq: event.lastMessageSeq,
              ...(event.lastMessageId !== undefined ? { lastMessageId: event.lastMessageId } : {}),
              ...(event.lastMessageAt !== undefined ? { lastMessageAt: event.lastMessageAt } : {}),
            }
          : ch,
      ),
      channelUnreadCounts: {
        ...this.state.channelUnreadCounts,
        [event.channelId]: event.unreadCount,
      },
    })
  }

  private handleReadStateUpdated(event: CollaborationReadStateUpdatedEvent): void {
    this.updateState({
      channelReadStates: {
        ...this.state.channelReadStates,
        [event.channelId]: event.readState,
      },
      channelUnreadCounts: {
        ...this.state.channelUnreadCounts,
        [event.channelId]: event.readState.unreadCount,
      },
    })
  }

  // -----------------------------------------------------------------------
  // Event handlers — choice requests
  // -----------------------------------------------------------------------

  private handleChoiceRequest(event: CollaborationChoiceRequestEvent): void {
    if (event.channelId !== this.state.activeChannelId) return

    const existing = this.state.pendingChoiceRequests
    const idx = existing.findIndex((cr) => cr.choiceId === event.request.choiceId)

    if (idx >= 0) {
      // Update existing choice request
      const updated = [...existing]
      updated[idx] = event.request
      this.updateState({ pendingChoiceRequests: updated })
    } else if (event.request.status === 'pending') {
      // Add new pending request
      this.updateState({ pendingChoiceRequests: [...existing, event.request] })
    }
  }

  private handleMessagePinned(event: CollaborationMessagePinnedEvent): void {
    if (event.channelId !== this.state.activeChannelId) return
    this.updateState({
      channelHistory: this.state.channelHistory.map((message) =>
        message.id === event.messageId
          ? { ...message, pinned: event.pinned }
          : message,
      ),
    })
  }

  // -----------------------------------------------------------------------
  // Event handlers — channel lifecycle
  // -----------------------------------------------------------------------

  private handleChannelCreated(event: CollaborationChannelCreatedEvent): void {
    if (this.state.channels.some((ch) => ch.channelId === event.channel.channelId)) return
    this.updateState({ channels: [...this.state.channels, event.channel] })
  }

  private handleChannelUpdated(event: CollaborationChannelUpdatedEvent): void {
    this.updateState({
      channels: this.state.channels.map((ch) =>
        ch.channelId === event.channel.channelId ? event.channel : ch,
      ),
    })
  }

  private handleChannelArchived(event: CollaborationChannelArchivedEvent): void {
    this.updateState({
      channels: this.state.channels.filter((ch) => ch.channelId !== event.channelId),
    })

    // If we were viewing this channel, clear state
    if (this.state.activeChannelId === event.channelId) {
      this.activeChannelId = null
      this.updateState({
        activeChannelId: null,
        channelHistory: [],
        channelHistoryLoaded: false,
        channelStatus: 'idle',
        channelStreamingStartedAt: undefined,
        sessionWorkers: [],
        sessionActivity: [],
        sessionAgentStatuses: {},
        pendingChoiceRequests: [],
      })
    }
  }

  private handleChannelReordered(event: CollaborationChannelReorderedEvent): void {
    const positionMap = new Map(event.channels.map((ch) => [ch.channelId, ch]))
    this.updateState({
      channels: this.state.channels.map((ch) => {
        const updated = positionMap.get(ch.channelId)
        return updated ? { ...ch, position: updated.position, categoryId: updated.categoryId } : ch
      }),
    })
  }

  // -----------------------------------------------------------------------
  // Event handlers — category lifecycle
  // -----------------------------------------------------------------------

  private handleCategoryCreated(event: CollaborationCategoryCreatedEvent): void {
    if (this.state.categories.some((cat) => cat.categoryId === event.category.categoryId)) return
    this.updateState({ categories: [...this.state.categories, event.category] })
  }

  private handleCategoryUpdated(event: CollaborationCategoryUpdatedEvent): void {
    this.updateState({
      categories: this.state.categories.map((cat) =>
        cat.categoryId === event.category.categoryId ? event.category : cat,
      ),
    })
  }

  private handleCategoryDeleted(event: CollaborationCategoryDeletedEvent): void {
    this.updateState({
      categories: this.state.categories.filter((cat) => cat.categoryId !== event.categoryId),
      channels: this.state.channels.map((ch) =>
        ch.categoryId === event.categoryId ? { ...ch, categoryId: undefined } : ch,
      ),
    })
  }

  private handleCategoryReordered(event: CollaborationCategoryReorderedEvent): void {
    const positionMap = new Map(event.categories.map((cat) => [cat.categoryId, cat]))
    this.updateState({
      categories: this.state.categories.map((cat) => {
        const updated = positionMap.get(cat.categoryId)
        return updated ? { ...cat, position: updated.position } : cat
      }),
    })
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private updateState(patch: Partial<CollabWsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }
}
