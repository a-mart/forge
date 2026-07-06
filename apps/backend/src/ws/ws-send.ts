import type { CollaborationServerEvent, ServerEvent } from "@forge/protocol";
import { WebSocket } from "ws";
import { warnWsThrottled } from "./ws-log-throttle.js";

export const MAX_WS_EVENT_BYTES = 1 * 1024 * 1024;
export const MAX_WS_BUFFERED_AMOUNT_BYTES = 1 * 1024 * 1024;

/**
 * Bootstrap-critical event types must never be dropped under transient backpressure: losing any of
 * them leaves the client's (re)subscribe incomplete and, for the local origin, drives a reload loop.
 * `ready` in particular is the client's subscribe-complete signal. For these we await the socket
 * buffer to drain (bounded) before sending instead of dropping. All other (live/streaming) events
 * remain replaceable and keep the drop-on-backpressure behavior.
 */
export const BOOTSTRAP_CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "ready",
  "conversation_history",
  "agents_snapshot",
  "profiles_snapshot",
  "unread_counts_snapshot",
]);

/** Max time to await a saturated socket buffer to drain before falling back to the drop path. */
export const BOOTSTRAP_DRAIN_TIMEOUT_MS = 5_000;
/** Poll interval while waiting for `bufferedAmount` to fall below the cap. */
const BOOTSTRAP_DRAIN_POLL_MS = 15;

export type SocketSendPathValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_underlying_socket"
        | "missing_underlying_socket_write"
        | "socket_self_reference"
        | "socket_write_recurses_into_websocket_send";
    };

export function sendWsEvent(options: {
  socket: WebSocket;
  event: ServerEvent | CollaborationServerEvent;
  onDropSocket: (socket: WebSocket) => void;
}): number | null {
  const { socket, event, onDropSocket } = options;

  if (socket.readyState !== WebSocket.OPEN) {
    return null;
  }

  const socketIntegrity = validateSocketSendPath(socket);
  if (!socketIntegrity.ok) {
    console.warn("[swarm] ws:drop_event:invalid_socket", {
      eventType: event.type,
      reason: socketIntegrity.reason
    });
    onDropSocket(socket);
    return null;
  }

  if (socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
    warnWsThrottled(`drop_event:backpressure:${event.type}`, "[swarm] ws:drop_event:backpressure", {
      eventType: event.type,
      bufferedAmount: socket.bufferedAmount,
      maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES
    });
    return null;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch (error) {
    console.warn("[swarm] ws:drop_event:serialize_failed", {
      eventType: event.type,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  const eventBytes = Buffer.byteLength(serialized, "utf8");
  if (eventBytes > MAX_WS_EVENT_BYTES) {
    console.warn("[swarm] ws:drop_event:oversized", {
      eventType: event.type,
      eventBytes,
      maxEventBytes: MAX_WS_EVENT_BYTES
    });
    return null;
  }

  try {
    socket.send(serialized, (error) => {
      if (!error) {
        return;
      }

      console.warn("[swarm] ws:drop_event:send_failed", {
        eventType: event.type,
        message: error.message
      });
      onDropSocket(socket);
    });
    return eventBytes;
  } catch (error) {
    console.warn("[swarm] ws:drop_event:send_failed", {
      eventType: event.type,
      message: error instanceof Error ? error.message : String(error)
    });
    onDropSocket(socket);
    return null;
  }
}

/**
 * Backpressure-aware send for bootstrap-critical events. When the socket buffer is over the cap, this
 * awaits the buffer to drain (bounded by {@link BOOTSTRAP_DRAIN_TIMEOUT_MS}) before sending, so a large
 * synchronous bootstrap sequence flow-controls instead of dropping `ready`/`conversation_history`/etc.
 * Transient backpressure never terminates the socket — only a genuine send error (via {@link sendWsEvent}'s
 * `onDropSocket`) does. Non-critical event types are sent straight through and keep drop-on-backpressure.
 * If the drain wait times out on a truly stuck socket, it falls back to {@link sendWsEvent} (drop + log).
 */
export async function sendWsEventWithBackpressure(options: {
  socket: WebSocket;
  event: ServerEvent | CollaborationServerEvent;
  onDropSocket: (socket: WebSocket) => void;
  timeoutMs?: number;
}): Promise<number | null> {
  const { socket, event, onDropSocket, timeoutMs = BOOTSTRAP_DRAIN_TIMEOUT_MS } = options;

  if (
    BOOTSTRAP_CRITICAL_EVENT_TYPES.has(event.type) &&
    socket.readyState === WebSocket.OPEN &&
    socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES
  ) {
    const drained = await waitForSocketDrain(socket, timeoutMs);
    if (!drained) {
      warnWsThrottled(
        `drain_timeout:${event.type}`,
        "[swarm] ws:bootstrap_drain_timeout",
        {
          eventType: event.type,
          bufferedAmount: socket.bufferedAmount,
          maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES,
          timeoutMs,
        },
      );
      // Fall through to sendWsEvent, which drops (over cap) or terminates only on a real send error.
    }
  }

  return sendWsEvent({ socket, event, onDropSocket });
}

/**
 * Resolves once the socket's `bufferedAmount` falls to/under the cap (drained → true), or the socket
 * is no longer OPEN (closed → false), or the timeout elapses (stuck → false). Polls on a short timer;
 * never blocks the event loop.
 */
export function waitForSocketDrain(socket: WebSocket, timeoutMs: number): Promise<boolean> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.resolve(false);
  }
  if (socket.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT_BYTES) {
    return Promise.resolve(true);
  }

  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (socket.readyState !== WebSocket.OPEN) {
        resolve(false);
        return;
      }
      if (socket.bufferedAmount <= MAX_WS_BUFFERED_AMOUNT_BYTES) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, BOOTSTRAP_DRAIN_POLL_MS);
    };
    setTimeout(poll, BOOTSTRAP_DRAIN_POLL_MS);
  });
}

function validateSocketSendPath(socket: WebSocket): SocketSendPathValidationResult {
  const rawSocket = (socket as WebSocket & { _socket?: unknown })._socket;
  if (!rawSocket || typeof rawSocket !== "object") {
    return { ok: false, reason: "missing_underlying_socket" };
  }

  if (rawSocket === socket) {
    return { ok: false, reason: "socket_self_reference" };
  }

  const rawSocketWrite = (rawSocket as { write?: unknown }).write;
  if (typeof rawSocketWrite !== "function") {
    return { ok: false, reason: "missing_underlying_socket_write" };
  }

  if (rawSocketWrite === socket.send) {
    return { ok: false, reason: "socket_write_recurses_into_websocket_send" };
  }

  return { ok: true };
}
