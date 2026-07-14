import type { ServerEvent } from '@forge/protocol'
import type { ManagerWsState } from '../ws-state'
import type { ManagerWsConversationEventContext } from './types'
import {
  BOOTSTRAP_COALESCIBLE_EVENT_TYPES,
  BOOTSTRAP_FORCE_FLUSH_CONVERSATION_EVENT_TYPES,
  handleConversationEvent,
} from './event-handlers/conversation-event-handlers'

/** Default inactivity timeout before the buffer auto-flushes (ms). */
export const BOOTSTRAP_FLUSH_TIMEOUT_MS = 100

export interface BootstrapBufferDeps {
  getState: () => ManagerWsState
  updateState: (patch: Partial<ManagerWsState>) => void
  /** Re-exports the conversation event application logic. */
  applyConversationEvent: typeof handleConversationEvent
  /** Overridable flush timeout for testing. */
  flushTimeoutMs?: number
}

/**
 * Buffers bootstrap events during session subscription transitions to coalesce
 * multiple rapid state updates into a single listener notification.
 *
 * Bootstrap begins when `subscribeToAgent()` is called on a connected socket.
 * During bootstrap, coalescible events (ready, conversation_history,
 * pending_choices_snapshot, unread_counts_snapshot) are accumulated into a
 * pending patch. Non-coalescible events pass through untouched.
 *
 * Flushing occurs on:
 * - `unread_counts_snapshot` arrival (terminal signal — immediate flush)
 * - A live conversation event for the target session (force-flush)
 * - An `agent_status` event for the target session or its worker (force-flush)
 * - Inactivity timeout (100ms default, resets on each accepted buffered event)
 *
 * Socket ownership remains in `ManagerWsClient`. This class never imports or
 * touches WebSocket transport or sends commands.
 */
export class BootstrapBuffer {
  private targetAgentId: string | null = null
  private pendingPatch: Partial<ManagerWsState> = {}
  private timeoutId: ReturnType<typeof setTimeout> | undefined = undefined
  private readonly flushTimeoutMs: number
  private readonly deps: BootstrapBufferDeps

  constructor(deps: BootstrapBufferDeps) {
    this.deps = deps
    this.flushTimeoutMs = deps.flushTimeoutMs ?? BOOTSTRAP_FLUSH_TIMEOUT_MS
  }

  /** Whether the buffer is actively collecting bootstrap events. */
  get active(): boolean {
    return this.targetAgentId !== null
  }

  /** Start buffering for a new target session. Clears any prior buffer. */
  begin(targetAgentId: string): void {
    this.clear()
    this.targetAgentId = targetAgentId
    this.pendingPatch = {}
  }

  /**
   * Route an incoming server event through bootstrap logic.
   *
   * @returns `true` if the event was consumed (buffered or caused a flush
   *   that absorbed it). `false` if the event is not bootstrap-relevant and
   *   should be processed normally by the caller.
   */
  handleEvent(event: ServerEvent): boolean {
    if (!this.targetAgentId) return false

    // Coalescible events are buffered.
    if (BOOTSTRAP_COALESCIBLE_EVENT_TYPES.has(event.type)) {
      this.handleCoalescibleEvent(event)
      return true
    }

    // Force-flush triggers: flush accumulated state, then let the event
    // pass through for normal processing.
    if (this.shouldForceFlush(event)) {
      this.flush()
      return false
    }

    // Non-coalescible, non-flush-triggering events pass through.
    return false
  }

  /** Flush accumulated state immediately. Safe to call when inactive (no-op). */
  flush(): void {
    if (!this.targetAgentId) return

    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }

    const patch = this.pendingPatch
    this.targetAgentId = null
    this.pendingPatch = {}

    if (Object.keys(patch).length > 0) {
      this.deps.updateState(patch)
    }
  }

  /** Clear buffer state without flushing (e.g., on disconnect). */
  clear(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
      this.timeoutId = undefined
    }
    this.targetAgentId = null
    this.pendingPatch = {}
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleCoalescibleEvent(event: ServerEvent): void {
    if (!this.targetAgentId) return

    if (!this.isEventForTarget(event, this.targetAgentId)) {
      return
    }

    this.resetTimeout()

    // Build effective state overlay and reduce the event into pendingPatch.
    const effectiveState: ManagerWsState = { ...this.deps.getState(), ...this.pendingPatch }
    const context: ManagerWsConversationEventContext = {
      state: effectiveState,
      updateState: (patch) => {
        this.pendingPatch = { ...this.pendingPatch, ...patch }
      },
    }

    this.deps.applyConversationEvent(event, context)

    // unread_counts_snapshot is the terminal signal — flush immediately.
    if (event.type === 'unread_counts_snapshot') {
      this.flush()
    }
  }

  private isEventForTarget(event: ServerEvent, targetAgentId: string): boolean {
    if (event.type === 'ready') {
      return event.subscribedAgentId === targetAgentId
    }
    if (event.type === 'conversation_history' || event.type === 'pending_choices_snapshot') {
      return event.agentId === targetAgentId
    }
    if (event.type === 'session_plan_snapshot') {
      return event.sessionAgentId === targetAgentId
    }
    if (event.type === 'session_goal_snapshot') {
      return event.sessionAgentId === targetAgentId
    }
    // unread_counts_snapshot is global — always accepted.
    return true
  }

  private shouldForceFlush(event: ServerEvent): boolean {
    const targetAgentId = this.targetAgentId
    if (!targetAgentId) return false

    if (BOOTSTRAP_FORCE_FLUSH_CONVERSATION_EVENT_TYPES.has(event.type)) {
      return (
        'agentId' in event &&
        ((event as { agentId: string }).agentId === targetAgentId ||
          (event.type === 'choice_request' && event.sessionAgentId === targetAgentId))
      )
    }

    if (event.type === 'agent_status') {
      return (
        event.agentId === targetAgentId ||
        (event.managerId !== undefined && event.managerId === targetAgentId)
      )
    }

    if (event.type === 'model_cache_visualization_settings_changed') {
      return true
    }

    return false
  }

  private resetTimeout(): void {
    if (this.timeoutId !== undefined) {
      clearTimeout(this.timeoutId)
    }
    const target = this.targetAgentId
    this.timeoutId = setTimeout(() => {
      if (this.targetAgentId === target) {
        this.flush()
      }
    }, this.flushTimeoutMs)
  }
}
