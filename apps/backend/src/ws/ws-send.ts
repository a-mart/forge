import type { ServerEvent } from "@forge/protocol";
import { WebSocket } from "ws";

export const MAX_WS_EVENT_BYTES = 1 * 1024 * 1024;
export const MAX_WS_BUFFERED_AMOUNT_BYTES = 1 * 1024 * 1024;

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
  event: ServerEvent;
  onDropSocket: (socket: WebSocket) => void;
}): void {
  const { socket, event, onDropSocket } = options;

  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const socketIntegrity = validateSocketSendPath(socket);
  if (!socketIntegrity.ok) {
    console.warn("[swarm] ws:drop_event:invalid_socket", {
      eventType: event.type,
      reason: socketIntegrity.reason
    });
    onDropSocket(socket);
    return;
  }

  if (socket.bufferedAmount > MAX_WS_BUFFERED_AMOUNT_BYTES) {
    console.warn("[swarm] ws:drop_event:backpressure", {
      eventType: event.type,
      bufferedAmount: socket.bufferedAmount,
      maxBufferedAmountBytes: MAX_WS_BUFFERED_AMOUNT_BYTES
    });
    return;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(event);
  } catch (error) {
    console.warn("[swarm] ws:drop_event:serialize_failed", {
      eventType: event.type,
      message: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const eventBytes = Buffer.byteLength(serialized, "utf8");
  if (eventBytes > MAX_WS_EVENT_BYTES) {
    console.warn("[swarm] ws:drop_event:oversized", {
      eventType: event.type,
      eventBytes,
      maxEventBytes: MAX_WS_EVENT_BYTES
    });
    return;
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
  } catch (error) {
    console.warn("[swarm] ws:drop_event:send_failed", {
      eventType: event.type,
      message: error instanceof Error ? error.message : String(error)
    });
    onDropSocket(socket);
  }
}

export function validateSocketSendPath(socket: WebSocket): SocketSendPathValidationResult {
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
